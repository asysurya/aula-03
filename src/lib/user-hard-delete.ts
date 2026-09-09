import { db } from "@/lib/db";
import { deleteFile } from "@/lib/storage";
import { hardDeleteCloudFilesByIds } from "@/lib/hard-delete";

// ─────────────────────────────────────────────────────────────────────────
// Hard delete USER — menghapus akun + seluruh jejak datanya secara PERMANEN.
//
// Kenapa perlu fungsi khusus? Semua relasi ke User memakai onDelete:
// NoAction (Prisma MongoDB menolak delete bila masih direferensikan —
// error P2014 "would violate the required relation"). Jadi semua baris
// yang menunjuk user harus dibersihkan/dialihkan LEBIH DULU, dengan
// urutan yang aman (anak sebelum induk).
//
// Yang terjadi saat user dihapus:
//  · Pesan yang dikirim user → dihapus (beserta lampiran/reaksi/resipen).
//  · Balasan orang lain ke pesan user → replyTo dilepas (pesan tetap ada).
//  · DM yang melibatkan user → utas dihapus seluruhnya.
//  · Grup yang DIBUAT user → kepemilikan dialihkan ke admin penghapus
//    (obrolan kelas tetap utuh), kecuali adminId tidak diberikan.
//  · Folder/file/tugas/dokumen yang dibuat user → hard delete cascade
//    (file fisik di MEGA/S3/lokal ikut dihapus permanen).
//  · Pengumpulan tugas (Submission) & Attempt form user → dihapus.
//  · Foto avatar user di cloud → blob dihapus.
//  · Sesi upload staging (chunk) user → dibersihkan.
// ─────────────────────────────────────────────────────────────────────────

/** Sub-cascade: hapus kumpulan pesan beserta baris yang menunjuknya. */
async function deleteMessagesCascade(messageIds: string[]): Promise<void> {
  if (messageIds.length === 0) return;
  const ids = Array.from(new Set(messageIds));

  // Balasan (dari siapapun) ke pesan-pesan ini → lepas replyTo-nya.
  await db.message.updateMany({
    where: { replyToId: { in: ids } },
    data: { replyToId: null },
  });
  // Baris yang menunjuk message (NoAction) — hapus dulu.
  await db.readReceipt.deleteMany({ where: { messageId: { in: ids } } });
  await db.messageReaction.deleteMany({ where: { messageId: { in: ids } } });
  await db.messageAttachment.deleteMany({ where: { messageId: { in: ids } } });
  await db.message.deleteMany({ where: { id: { in: ids } } });
}

/** Hapus semua utas DM yang melibatkan user (kedua arah). */
async function deleteDmThreads(userId: string): Promise<void> {
  const convs = await db.dMConversation.findMany({
    where: { OR: [{ user1Id: userId }, { user2Id: userId }] },
    select: { id: true },
  });
  if (convs.length === 0) return;
  const convIds = convs.map((c) => c.id);
  const msgs = await db.message.findMany({
    where: { dmId: { in: convIds } },
    select: { id: true },
  });
  await deleteMessagesCascade(msgs.map((m) => m.id));
  await db.dMConversation.deleteMany({ where: { id: { in: convIds } } });
}

/** Kumpulkan semua id folder turunan (BFS) termasuk folder itu sendiri. */
async function collectFolderIds(rootIds: string[]): Promise<string[]> {
  const all = [...rootIds];
  const stack = [...rootIds];
  while (stack.length > 0) {
    const parent = stack.pop()!;
    const children = await db.cloudFolder.findMany({
      where: { parentId: parent },
      select: { id: true },
    });
    for (const c of children) {
      all.push(c.id);
      stack.push(c.id);
    }
  }
  return Array.from(new Set(all));
}

/**
 * Hard delete cascade folder (paritas dengan route folders/[id] DELETE):
 * submission + dokumen + assignment + grant + file fisik, folder terdalam
 * duluan. Mengembalikan jumlah folder yang dihapus.
 */
async function hardDeleteFoldersCascade(rootFolderIds: string[]): Promise<number> {
  if (rootFolderIds.length === 0) return 0;
  const allFolderIds = await collectFolderIds(rootFolderIds);

  // Submission milik assignment di folder-folder ini (NoAction ke Assignment
  // dan CloudFile → hapus dulu).
  const assignments = await db.assignment.findMany({
    where: { folderId: { in: allFolderIds } },
    select: { id: true },
  });
  if (assignments.length > 0) {
    await db.submission.deleteMany({
      where: { assignmentId: { in: assignments.map((a) => a.id) } },
    });
  }

  // SharedDoc di dalam → hapus kolaborator dulu, lalu dokumennya.
  const docs = await db.sharedDoc.findMany({
    where: { folderId: { in: allFolderIds } },
    select: { id: true },
  });
  if (docs.length > 0) {
    const docIds = docs.map((d) => d.id);
    await db.docCollaborator.deleteMany({ where: { docId: { in: docIds } } });
    await db.sharedDoc.deleteMany({ where: { id: { in: docIds } } });
  }

  // Assignment (cascade Prisma: Form → Question/Attempt → Answer).
  if (assignments.length > 0) {
    await db.assignment.deleteMany({
      where: { id: { in: assignments.map((a) => a.id) } },
    });
  }

  // Grant akses folder.
  await db.folderAccess.deleteMany({ where: { folderId: { in: allFolderIds } } });

  // Semua file di dalam folder (hard delete: referensi + baris + blob fisik).
  const files = await db.cloudFile.findMany({
    where: { folderId: { in: allFolderIds } },
    select: { id: true },
  });
  await hardDeleteCloudFilesByIds(files.map((f) => f.id));

  // Folder terdalam duluan (relasi parent NoAction).
  for (const fid of [...allFolderIds].reverse()) {
    await db.cloudFolder.delete({ where: { id: fid } }).catch(() => {});
  }
  return allFolderIds.length;
}

export interface HardDeleteUserResult {
  deletedMessages: number;
  deletedDmThreads: number;
  reassignedGroups: number;
  deletedFolders: number;
  deletedFiles: number;
}

/**
 * Hapus user permanen. `reassignGroupsTo` = id admin yang menghapus —
 * grup yang dibuat user dialihkan ke admin tsb. supaya obrolan kelas
 * tidak ikut musnah. Bila kosong, grup buatan user dihapus cascade.
 */
export async function hardDeleteUser(
  userId: string,
  reassignGroupsTo?: string
): Promise<HardDeleteUserResult> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { id: true, avatarUrl: true },
  });
  if (!user) return {
    deletedMessages: 0,
    deletedDmThreads: 0,
    reassignedGroups: 0,
    deletedFolders: 0,
    deletedFiles: 0,
  };

  // ── 1. Pesan yang dikirim user (di kelas / grup / DM) ──
  const ownMessages = await db.message.findMany({
    where: { senderId: userId },
    select: { id: true },
  });
  await deleteMessagesCascade(ownMessages.map((m) => m.id));

  // ── 2. Reaksi & resipen baca buatan user di pesan orang lain ──
  await db.messageReaction.deleteMany({ where: { userId } });
  await db.readReceipt.deleteMany({ where: { userId } });

  // ── 3. DM yang melibatkan user → utas dihapus seluruhnya ──
  const dmCount = await db.dMConversation.count({
    where: { OR: [{ user1Id: userId }, { user2Id: userId }] },
  });
  await deleteDmThreads(userId);

  // ── 4. Grup buatan user → alihkan ke admin (obrolan tetap hidup) ──
  let reassigned = 0;
  const ownedGroups = await db.group.findMany({
    where: { createdBy: userId },
    select: { id: true },
  });
  if (ownedGroups.length > 0) {
    if (reassignGroupsTo && reassignGroupsTo !== userId) {
      await db.group.updateMany({
        where: { id: { in: ownedGroups.map((g) => g.id) } },
        data: { createdBy: reassignGroupsTo },
      });
      reassigned = ownedGroups.length;
    } else {
      // Tanpa penerus: hapus grup + seluruh pesannya.
      for (const g of ownedGroups) {
        const msgs = await db.message.findMany({
          where: { groupId: g.id },
          select: { id: true },
        });
        await deleteMessagesCascade(msgs.map((m) => m.id));
        await db.groupMember.deleteMany({ where: { groupId: g.id } });
        await db.group.delete({ where: { id: g.id } }).catch(() => {});
      }
    }
  }

  // ── 5. Keanggotaan & presence ──
  await db.classroomMember.deleteMany({ where: { userId } });
  await db.groupMember.deleteMany({ where: { userId } });
  await db.presenceRecord.deleteMany({ where: { userId } });

  // ── 6. Kolaborasi dokumen milik orang lain ──
  await db.docCollaborator.deleteMany({ where: { userId } });

  // ── 7. Dokumen yang dibuat user ──
  const ownDocs = await db.sharedDoc.findMany({
    where: { createdBy: userId },
    select: { id: true },
  });
  if (ownDocs.length > 0) {
    const docIds = ownDocs.map((d) => d.id);
    await db.docCollaborator.deleteMany({ where: { docId: { in: docIds } } });
    await db.sharedDoc.deleteMany({ where: { id: { in: docIds } } });
  }

  // ── 8. Submission pengumpulan tugas oleh user ──
  await db.submission.deleteMany({ where: { userId } });

  // ── 9. Assignment yang dibuat user (submission siswa lain ikut dibersihkan
  //        supaya relasi NoAction tidak melanggar; Form cascade) ──
  const ownAssignments = await db.assignment.findMany({
    where: { createdBy: userId },
    select: { id: true },
  });
  if (ownAssignments.length > 0) {
    const ids = ownAssignments.map((a) => a.id);
    await db.submission.deleteMany({ where: { assignmentId: { in: ids } } });
    await db.assignment.deleteMany({ where: { id: { in: ids } } });
  }

  // ── 10. Folder yang dibuat user → cascade penuh (file fisik ikut) ──
  const ownFolders = await db.cloudFolder.findMany({
    where: { createdBy: userId },
    select: { id: true },
  });
  const folderCount = await hardDeleteFoldersCascade(
    ownFolders.map((f) => f.id)
  );

  // ── 11. File yang diunggah user di folder orang lain / root ──
  const ownFiles = await db.cloudFile.findMany({
    where: { uploadedBy: userId },
    select: { id: true },
  });
  await hardDeleteCloudFilesByIds(ownFiles.map((f) => f.id));

  // ── 12. Grant akses folder/file yang diberikan KEPADA user ──
  await db.folderAccess.deleteMany({ where: { userId } });
  await db.fileAccess.deleteMany({ where: { userId } });

  // ── 13. Attempt form anti-nyontek user (jawaban ikut cascade) ──
  await db.formAttempt.deleteMany({ where: { userId } });

  // ── 14. Sesi upload staging (chunk besar yang belum selesai) ──
  await db.uploadSession.deleteMany({ where: { uploadedBy: userId } });

  // ── 15. Avatar user di cloud storage ──
  const avatar = user.avatarUrl;
  if (avatar && avatar.startsWith("/api/storage/")) {
    try {
      await deleteFile(decodeURIComponent(avatar.slice("/api/storage/".length)));
    } catch {
      /* best-effort */
    }
  }

  // ── 16. Baris user itu sendiri ──
  await db.user.delete({ where: { id: userId } });

  return {
    deletedMessages: ownMessages.length,
    deletedDmThreads: dmCount,
    reassignedGroups: reassigned,
    deletedFolders: folderCount,
    deletedFiles: ownFiles.length,
  };
}
