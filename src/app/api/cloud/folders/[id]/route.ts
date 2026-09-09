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
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await requireUser().catch(() => null);
  if (!user) return errorResponse("UNAUTHORIZED", 401);

  const { id } = await params;

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
  const filesInFolders = await db.cloudFile.findMany({
    where: { folderId: { in: allFolderIds } },
    select: { id: true, storageKey: true, submission: { select: { id: true } } },
  });

  // ── HARD DELETE support ──
  // File jawaban form (FormAnswer) & gambar soal (FormQuestion) memiliki
  // folderId=null — TIDAK tercakup query di atas dan tadinya dibiarkan
  // yatim di DB + MEGA saat tugas dihapus. Kumpulkan SEBELUM baris
  // assignment/form/attempt terhapus oleh cascade.
  const orphanFileIds: string[] = [];
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
    if (forms.length > 0) {
      const formIds = forms.map((f) => f.id);
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

  // ── HARD DELETE, urutan aman (anak dulu, induk belakangan) ──
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

  // 3. Assignment (cascade: Form → FormQuestion/FormAttempt → FormAnswer).
  if (assignmentsInFolders.length > 0) {
    await db.assignment.deleteMany({
      where: { id: { in: assignmentsInFolders.map((a) => a.id) } },
    });
  }

  // 4. FolderAccess untuk folder-folder ini.
  await db.folderAccess.deleteMany({
    where: { folderId: { in: allFolderIds } },
  });

  // 5. Hard delete SEMUA file di dalam folder ini + file jawaban form /
  //    gambar soal (orphan): bersihkan FileAccess/MessageAttachment/
  //    referensi Submission → hapus baris CloudFile → hapus blob MEGA/lokal.
  const allFileIds = [
    ...filesInFolders.map((f) => f.id),
    ...orphanFileIds,
  ];
  await hardDeleteCloudFilesByIds(allFileIds);

  // 6. Terakhir: folder itu sendiri — dari yang paling dalam (anak dulu)
  //    supaya relasi CloudFolder.parent (NoAction) tidak melanggar.
  for (const fid of [...allFolderIds].reverse()) {
    await db.cloudFolder.delete({ where: { id: fid } }).catch(() => {});
  }

  return Response.json({ ok: true, deletedFolderCount: allFolderIds.length });
}
