import { db } from "@/lib/db";
import { hardDeleteCloudFilesByIds } from "@/lib/hard-delete";

// ─────────────────────────────────────────────────────────────────────────
// Cascade penghapusan folder — dipakai bersama oleh:
//   · DELETE /api/cloud/folders/[id]        (hapus satu folder)
//   · DELETE /api/admin/classrooms/[id]     (hapus kelas → semua foldernya)
//
// Urutan final (anti "sukses bohong" / anti P2014 Prisma-Mongo):
//   (a) bersihkan relasi/anak DB: submission → docCollaborator+sharedDoc →
//       formAttemptArchive → assignment (cascade Form) → folderAccess;
//   (b)  hardDeleteCloudFilesByIds (baris CloudFile + blob, best-effort
//       refcount storageKey) — dibatasi 15 detik, tidak boleh melempar;
//   (b2) safety-net: pastikan BARIS CloudFile benar-benar terhapus;
//   (c)  folder.delete children-first — SELALU dijalankan.
// Mengembalikan jumlah folder yang terkumpul (termasuk turunannya).
// ─────────────────────────────────────────────────────────────────────────

export async function deleteFolderCascade(rootId: string): Promise<number> {
  // Recursively collect all descendant folder IDs (BFS).
  const allFolderIds: string[] = [rootId];
  const stack = [rootId];
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

  // Gather all files within these folders. storageKey dikumpulkan SEBELUM
  // baris apa pun dihapus — hardDelete membaca ulang kunci ini secara
  // internal sebelum deleteMany-nya.
  const filesInFolders = await db.cloudFile.findMany({
    where: { folderId: { in: allFolderIds } },
    select: { id: true, storageKey: true },
  });

  // ── HARD DELETE support ──
  // File jawaban form (FormAnswer) & gambar soal (FormQuestion) punya
  // folderId=null — kumpulkan SEBELUM assignment/form/attempt terhapus.
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
        orphanFileIds.push(...answerFiles.map((a) => a.fileId as string));
      }
      const questionImages = await db.formQuestion.findMany({
        where: { formId: { in: formIds }, imageFileId: { not: null } },
        select: { imageFileId: true },
      });
      orphanFileIds.push(...questionImages.map((q) => q.imageFileId as string));
    }
  }

  // ── (a) HARD DELETE, urutan aman (anak dulu, induk belakangan) ──

  // 1. Submission milik assignment di folder ini.
  if (assignmentsInFolders.length > 0) {
    await db.submission.deleteMany({
      where: {
        assignmentId: { in: assignmentsInFolders.map((a) => a.id) },
      },
    });
  }

  // 2. SharedDoc di folder ini: kolaborator dulu (NoAction), lalu dokumen.
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

  // 3. Arsip percobaan form.
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

  // ── (b) Hard delete SEMUA file + file jawaban form / gambar soal ──
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
    console.error("[folder-delete] hardDeleteCloudFilesByIds gagal:", e);
  } finally {
    if (hardDeleteTimer) clearTimeout(hardDeleteTimer);
  }

  // ── (b2) Safety-net: pastikan BARIS CloudFile terhapus walau (b)
  //    gagal/timeout, supaya folder.delete di (c) tidak tersandung NoAction.
  try {
    await db.messageAttachment.deleteMany({
      where: { fileId: { in: allFileIds } },
    });
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
    console.error("[folder-delete] safety-net cloudFile gagal:", e);
  }

  // ── (c) Terakhir: folder itu sendiri — anak dulu (NoAction parent).
  for (const fid of [...allFolderIds].reverse()) {
    await db.cloudFolder.delete({ where: { id: fid } }).catch(() => {});
  }

  return allFolderIds.length;
}
