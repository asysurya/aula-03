import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import {
  errorResponse,
  folderClassroomId,
  getClassroomRole,
} from "@/lib/cloud-utils";
import {
  canEditFolder,
  canDeleteFolder,
  type ClassroomRole,
  type UserRole,
} from "@/lib/cloud-perms";
import { hardDeleteCloudFilesByIds } from "@/lib/hard-delete";

// Penghapusan folder berantai (BFS + relasi + assignment + blob MEGA satu
// per satu) bisa melebihi batas default serverless — naikkan ke 60 detik
// supaya tidak terpotong di tengah operasi (folder setengah terhapus).
export const maxDuration = 60;

// PATCH /api/cloud/folders/[id] — rename a folder.
// Body: { name: string } (1-120 chars, not empty). Allowed for ADMIN/GURU,
// creator, or classroom TEACHER.
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await requireUser().catch(() => null);
  if (!user) return errorResponse("UNAUTHORIZED", 401);

  const { id } = await params;

  let body: { name?: string };
  try {
    body = await req.json();
  } catch {
    return errorResponse("INVALID_JSON", 400);
  }

  const name = (body.name ?? "").trim();
  if (!name) return errorResponse("NAME_REQUIRED", 400);
  if (name.length > 120) return errorResponse("NAME_TOO_LONG", 400);

  const folder = await db.cloudFolder.findUnique({
    where: { id },
    select: {
      id: true,
      visibility: true,
      createdBy: true,
      classroomId: true,
    },
  });
  if (!folder) return errorResponse("FOLDER_NOT_FOUND", 404);

  // Resolve classroom role for edit check.
  let classroomRole: ClassroomRole | null = null;
  let cid = folder.classroomId;
  if (!cid) cid = await folderClassroomId(id);
  if (cid) {
    classroomRole =
      user.role === "ADMIN" ? "TEACHER" : await getClassroomRole(cid, user.id);
  }

  if (
    !canEditFolder(
      {
        id: folder.id,
        visibility: folder.visibility,
        createdBy: folder.createdBy,
      },
      user.id,
      user.role as UserRole,
      classroomRole
    )
  ) {
    return errorResponse("FORBIDDEN", 403);
  }

  const updated = await db.cloudFolder.update({
    where: { id },
    data: { name },
    select: {
      id: true,
      name: true,
      type: true,
      classroomId: true,
      parentId: true,
      createdAt: true,
      createdBy: true,
      visibility: true,
    },
  });

  return Response.json({ folder: updated });
}

// DELETE /api/cloud/folders/[id] — delete folder + all descendants + their
// files (storage blobs included). Stricter: only ADMIN/GURU/creator may delete.
// Assignment folders also delete the linked Assignment + Submissions (cascade).
//
// Urutan final (anti "sukses bohong"):
//   (a) bersihkan relasi/anak DB: submission → docCollaborator+sharedDoc →
//       formAttemptArchive → assignment (cascade Form) → folderAccess;
//   (b)  hardDeleteCloudFilesByIds (baris CloudFile + blob MEGA best-effort)
//       — dibatasi 15 detik dan TIDAK BOLEH melempar (kegagalan storage
//       tidak boleh menghalangi penghapusan data);
//   (b2) safety-net: pastikan BARIS CloudFile benar-benar terhapus walau (b)
//       gagal/timeout, supaya langkah (c) tidak tersandung relasi NoAction;
//   (c)  folder.delete children-first (per-item .catch) — SELALU dijalankan.
// Seluruh handler dibungkus try/catch → error jujur HTTP 500 (UI kini cek
// res.ok dan menampilkan toast error, bukan toast sukses palsu).
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await requireUser().catch(() => null);
  if (!user) return errorResponse("UNAUTHORIZED", 401);

  const { id } = await params;

  try {
    const folder = await db.cloudFolder.findUnique({
      where: { id },
      select: {
        id: true,
        visibility: true,
        createdBy: true,
        classroomId: true,
      },
    });
    if (!folder) return errorResponse("FOLDER_NOT_FOUND", 404);

    // Stricter delete check: ADMIN, GURU, or owner only.
    if (
      !canDeleteFolder(
        { createdBy: folder.createdBy },
        user.id,
        user.role as UserRole
      )
    ) {
      return errorResponse("FORBIDDEN", 403);
    }

    // Recursively collect all descendant folder IDs (BFS).
    const allFolderIds: string[] = [id];
    const stack = [id];
    while (stack.length > 0) {
      const parentId = stack.pop()!;
      const children = await db.cloudFolder.findMany({
        where: { parentId },
        select: { id: true },
      });
      for (const c of children) {
        allFolderIds.push(c.id);
        stack.push(c.id);
      }
    }

    // Gather all files within these folders (including root-level files of
    // the top folder itself, but we already include id in allFolderIds).
    // storageKey dikumpulkan SEBELUM baris apa pun dihapus — hardDelete
    // membaca ulang kunci ini secara internal sebelum deleteMany-nya.
    const filesInFolders = await db.cloudFile.findMany({
      where: { folderId: { in: allFolderIds } },
      select: { id: true, storageKey: true },
    });

    // ── HARD DELETE support ──
    // File jawaban form (FormAnswer) & gambar soal (FormQuestion) memiliki
    // folderId=null — TIDAK tercakup query di atas dan tadinya dibiarkan
    // yatim di DB + MEGA saat tugas dihapus. Kumpulkan SEBELUM baris
    // assignment/form/attempt terhapus oleh cascade.
    const orphanFileIds: string[] = [];
    const formIds: string[] = [];
    const assignmentsInFolders = await db.assignment.findMany({
      where: { folderId: { in: allFolderIds } },
      select: { id: true },
    });
    if (assignmentsInFolders.length > 0) {
      const assignmentIds = assignmentsInFolders.map((a) => a.id);
      const forms = await db.form.findMany({
        where: { assignmentId: { in: assignmentIds } },
        select: { id: true },
      });
      formIds.push(...forms.map((f) => f.id));
      if (forms.length > 0) {
        const attempts = await db.formAttempt.findMany({
          where: { formId: { in: formIds } },
          select: { id: true },
        });
        if (attempts.length > 0) {
          const attemptIds = attempts.map((a) => a.id);
          const answerFiles = await db.formAnswer.findMany({
            where: { attemptId: { in: attemptIds }, fileId: { not: null } },
            select: { fileId: true },
          });
          orphanFileIds.push(
            ...answerFiles.map((a) => a.fileId as string)
          );
        }
        const questionImages = await db.formQuestion.findMany({
          where: { formId: { in: formIds }, imageFileId: { not: null } },
          select: { imageFileId: true },
        });
        orphanFileIds.push(
          ...questionImages.map((q) => q.imageFileId as string)
        );
      }
    }

    // ── (a) HARD DELETE, urutan aman (anak dulu, induk belakangan) ──
    // Semua relasi ke CloudFolder/Assignment/CloudFile/SharedDoc memakai
    // NoAction (Prisma MongoDB menolak delete bila masih direferensikan —
    // P2014), jadi baris-baris yang menunjuk HARUS dihapus lebih dulu.

    // 1. Submission milik assignment di folder ini (menunjuk Assignment
    //    dan CloudFile dengan NoAction).
    if (assignmentsInFolders.length > 0) {
      await db.submission.deleteMany({
        where: {
          assignmentId: { in: assignmentsInFolders.map((a) => a.id) },
        },
      });
    }

    // 2. SharedDoc di folder ini: hapus kolaboratornya dulu (NoAction),
    //    lalu dokumennya.
    const docsInFolders = await db.sharedDoc.findMany({
      where: { folderId: { in: allFolderIds } },
      select: { id: true },
    });
    if (docsInFolders.length > 0) {
      const docIds = docsInFolders.map((d) => d.id);
      await db.docCollaborator.deleteMany({
        where: { docId: { in: docIds } },
      });
      await db.sharedDoc.deleteMany({ where: { id: { in: docIds } } });
    }

    // 3. Arsip percobaan form (FormAttemptArchive) — snapshot jawaban per
    //    percobaan lama (field `answers` JSON ikut terhapus). Tidak punya FK
    //    ke Form, tapi dibiarkan yatim jika tidak dibersihkan di sini.
    if (formIds.length > 0) {
      await db.formAttemptArchive.deleteMany({
        where: { formId: { in: formIds } },
      });
    }

    // 4. Assignment (cascade: Form → FormQuestion/FormAttempt → FormAnswer).
    if (assignmentsInFolders.length > 0) {
      await db.assignment.deleteMany({
        where: { id: { in: assignmentsInFolders.map((a) => a.id) } },
      });
    }

    // 5. FolderAccess untuk folder-folder ini.
    await db.folderAccess.deleteMany({
      where: { folderId: { in: allFolderIds } },
    });

    // ── (b) Hard delete SEMUA file di dalam folder ini + file jawaban form /
    //    gambar soal (orphan): bersihkan FileAccess/MessageAttachment/
    //    referensi Submission → hapus baris CloudFile → hapus blob MEGA/lokal.
    //    PENTING: kegagalan storage (blob lambat, MEGA down) TIDAK boleh
    //    menghalangi penghapusan data — batasi 15 detik & telan errornya.
    const allFileIds = [
      ...filesInFolders.map((f) => f.id),
      ...orphanFileIds,
    ];
    let hardDeleteTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        hardDeleteCloudFilesByIds(allFileIds),
        new Promise<void>((r) => {
          hardDeleteTimer = setTimeout(r, 15_000);
        }),
      ]);
    } catch (e) {
      // Baris file mungkin belum semua terhapus — safety-net (b2) menutup
      // celah ini; blob fisik tetap best-effort (promise berlanjut di latar).
      console.error("[folders/delete] hardDeleteCloudFilesByIds gagal:", e);
    } finally {
      if (hardDeleteTimer) clearTimeout(hardDeleteTimer);
    }

    // ── (b2) Safety-net: pastikan BARIS CloudFile di folder ini terhapus
    //    walau langkah (b) gagal/timeout, supaya folder.delete di (c) tidak
    //    tersandung relasi NoAction CloudFile → CloudFolder. Lepas dulu
    //    referensi NoAction yang mungkin masih tersisa (mirror detach).
    try {
      await db.messageAttachment.deleteMany({
        where: { fileId: { in: allFileIds } },
      });
      // Model FileAccess mungkin tidak ada di skema lama — best-effort.
      await db.fileAccess
        .deleteMany({ where: { fileId: { in: allFileIds } } })
        .catch(() => {});
      await db.submission.updateMany({
        where: { fileId: { in: allFileIds } },
        data: { fileId: null },
      });
      await db.formAnswer.updateMany({
        where: { fileId: { in: allFileIds } },
        data: { fileId: null },
      });
      await db.formQuestion.updateMany({
        where: { imageFileId: { in: allFileIds } },
        data: { imageFileId: null },
      });
      await db.cloudFile.deleteMany({
        where: {
          OR: [
            { folderId: { in: allFolderIds } },
            { id: { in: allFileIds } },
          ],
        },
      });
    } catch (e) {
      console.error("[folders/delete] safety-net cloudFile gagal:", e);
    }

    // ── (c) Terakhir: folder itu sendiri — dari yang paling dalam (anak
    //    dulu) supaya relasi CloudFolder.parent (NoAction) tidak melanggar.
    //    SELALU dijalankan meski langkah (b)/(b2) gagal; per-item .catch.
    for (const fid of [...allFolderIds].reverse()) {
      await db.cloudFolder.delete({ where: { id: fid } }).catch(() => {});
    }

    return Response.json({ ok: true, deletedFolderCount: allFolderIds.length });
  } catch (e) {
    console.error("[folders/delete]", e);
    return errorResponse(
      "HAPUS_GAGAL: " +
        (e instanceof Error ? e.message : "kesalahan tidak diketahui"),
      500
    );
  }
}
