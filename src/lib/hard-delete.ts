import { db } from "@/lib/db";
import { deleteFile } from "@/lib/storage";

// ─────────────────────────────────────────────────────────────────────────
// Hard delete — menghapus baris CloudFile + blob fisiknya (MEGA / lokal)
// secara PERMANEN. Bukan sekadar menyembunyikan: referensi ke file
// (MessageAttachment, FormAnswer, FormQuestion image, Submission, FileAccess)
// dibersihkan dulu, lalu baris DB dihapus, lalu blob di storage dihapus.
// ─────────────────────────────────────────────────────────────────────────

/** Lepas semua referensi ke baris CloudFile (NoAction/SetNull). */
async function detachCloudFileReferences(unique: string[]): Promise<void> {
  await db.messageAttachment.deleteMany({
    where: { fileId: { in: unique } },
  });
  await db.formAnswer.updateMany({
    where: { fileId: { in: unique } },
    data: { fileId: null },
  });
  await db.formQuestion.updateMany({
    where: { imageFileId: { in: unique } },
    data: { imageFileId: null },
  });
  await db.submission.updateMany({
    where: { fileId: { in: unique } },
    data: { fileId: null },
  });
  try {
    await db.fileAccess.deleteMany({ where: { fileId: { in: unique } } });
  } catch {
    /* model may not exist in older schemas */
  }
}

export async function hardDeleteCloudFilesByIds(
  fileIds: string[]
): Promise<void> {
  if (fileIds.length === 0) return;
  const unique = Array.from(new Set(fileIds));

  // 1. Lepas referensi (relasi NoAction/SetNull — dibersihkan eksplisit
  //    supaya tidak menyisakan baris yatim di DB).
  await detachCloudFileReferences(unique);

  // 2. Hapus baris CloudFile.
  const files = await db.cloudFile.findMany({
    where: { id: { in: unique } },
    select: { id: true, storageKey: true },
  });
  await db.cloudFile.deleteMany({ where: { id: { in: unique } } });

  // 3. Hapus blob fisik (MEGA node / file lokal) — permanen.
  for (const f of files) {
    try {
      await deleteFile(f.storageKey);
    } catch {
      /* best-effort — baris DB sudah terhapus */
    }
  }
}

/**
 * Hapus baris CloudFile + referensinya TANPA menyentuh blob fisiknya.
 *
 * Dipakai untuk file PERMANEN visibilitas ALL tanpa folder — unggahan chat
 * permanen & referensi mount MEGA ("Lampirkan dari Mount MEGA"):
 *  · File aslinya hidup di akun cloud bersama (MEGA/S3 milik admin) dan
 *    bisa dipakai pesan lain — blob dipertahankan.
 *  · Referensi mount menunjuk file ASLI milik admin di MEGA; menghapus
 *    baris tidak boleh ikut menghapus file aslinya.
 */
export async function deleteCloudFileRowsKeepBlob(
  fileIds: string[]
): Promise<void> {
  if (fileIds.length === 0) return;
  const unique = Array.from(new Set(fileIds));
  await detachCloudFileReferences(unique);
  await db.cloudFile.deleteMany({ where: { id: { in: unique } } });
}
