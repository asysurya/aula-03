// ── Impor lampiran materi AI dari PENYIMPANAN AULA (cloud storage) ──────
// dan dari MOUNT MEGA (multi-akun) — sumber yang SAMA dengan lampiran
// chat (Cloud Picker): file yang sudah tersimpan di cloud sekolah
// (MEGA/S3 lewat tabel CloudFile) maupun berkas di dalam akun MEGA
// yang di-mount (hak akses diatur admin per-akun, per peran + per orang).
//
// Dua jalur:
//   • importFromStorageFile(user, fileId) — baris CloudFile apa pun yang
//     BOLEH DIBACA user (izin PERSIS seperti penyajian /api/storage/[key]
//     lewat checkStorageAccess) → bytes via getFile() (dispatch mega/s3/
//     lokal) → pipeline extractText() → AiAttachment source "storage".
//   • importFromMega(user, accountId?, nodeId) — node file di akun MEGA
//     yang boleh dibuka user (canViewMount; akun dipilih eksplisit atau
//     akun pertama yang boleh dibuka — sama seperti tree/attach chat) →
//     nama/ukuran dibaca server-side (megaStat) → megaDownload →
//     AiAttachment source "mega".
//
// Dipisah dari ai-import.ts (yang murni fs/path tanpa DB) supaya
// kompilasi unit terpisah pada E2E tetap berjalan.

import { db } from "@/lib/db";
import { getFile } from "@/lib/storage";
import { checkStorageAccess } from "@/lib/storage-access";
import { canViewMount } from "@/lib/mount-access";
import {
  megaStat,
  megaDownload,
  describeMegaError,
  type MegaAccountLike,
} from "@/lib/mega-storage";
import { resolveMime } from "@/lib/file-constants";
import { ImportError, type ImportedFile } from "@/lib/ai-import";

const MAX_IMPORT_SIZE = 4 * 1024 * 1024; // 4 MB — sama dengan upload/cloud/mount

export interface ImportUser {
  id: string;
  role: string;
}

// ── Cloud storage Aula (baris CloudFile) ───────────────────────────────

/**
 * Impor file dari penyimpanan cloud Aula sebagai materi AI.
 * Izin dibaca dengan logika yang SAMA dengan penyajian file
 * (/api/storage/[key]) — file kelas, file bersama permanen, maupun file
 * milik sendiri; file PRIVATE orang lain ditolak.
 */
export async function importFromStorageFile(
  user: ImportUser,
  rawFileId: string
): Promise<ImportedFile> {
  const fileId = (rawFileId || "").trim();
  if (!fileId) {
    throw new ImportError("Berikan id berkas cloud", 400);
  }
  const file = await db.cloudFile.findUnique({
    where: { id: fileId },
    select: {
      id: true,
      name: true,
      mimetype: true,
      size: true,
      storageKey: true,
      folderId: true,
    },
  });
  if (!file) {
    throw new ImportError("Berkas tidak ditemukan di cloud", 404);
  }

  // Izin baca sama persis dengan menyajikan file (termasuk file
  // kedaluwarsa → 410, PRIVATE orang lain → 403).
  const access = await checkStorageAccess(
    { id: user.id, role: user.role },
    file.storageKey
  );
  if (!access.ok) {
    if (access.status === 410) {
      throw new ImportError("Berkas sudah kedaluwarsa", 404);
    }
    if (access.status === 403) {
      throw new ImportError(
        "Kamu tidak punya izin membaca berkas cloud ini",
        403
      );
    }
    throw new ImportError("Berkas tidak ditemukan di cloud", 404);
  }

  if (file.size > MAX_IMPORT_SIZE) {
    throw new ImportError("Berkas terlalu besar (maks 4 MB)", 413);
  }

  const data = await getFile(file.storageKey);
  if (!data || data.bytes.length === 0) {
    throw new ImportError(
      "Berkas tidak terbaca dari penyimpanan (mungkin sudah dihapus)",
      502
    );
  }
  if (data.bytes.length > MAX_IMPORT_SIZE) {
    throw new ImportError("Berkas terlalu besar (maks 4 MB)", 413);
  }

  // Nama folder untuk keterangan asal (best-effort).
  let folderName: string | null = null;
  if (file.folderId) {
    const folder = await db.cloudFolder
      .findUnique({
        where: { id: file.folderId },
        select: { name: true },
      })
      .catch(() => null);
    folderName = folder?.name ?? null;
  }

  return {
    name: file.name || "berkas",
    mime: file.mimetype || resolveMime(file.name, ""),
    buf: data.bytes,
    origin: folderName
      ? `Aula Cloud · ${folderName}`
      : "Aula Cloud",
  };
}

// ── Mount MEGA (multi-akun) ────────────────────────────────────────────

interface MegaAccountRow extends MegaAccountLike {
  name: string;
  mountVisibleTo: string | null;
  mountMode: string | null;
  mountUserIds: string[] | null;
  mountUserWriteIds: string[] | null;
}

const MEGA_ACCOUNT_SELECT = {
  id: true,
  email: true,
  password: true,
  sessionData: true,
  name: true,
  mountVisibleTo: true,
  mountMode: true,
  mountUserIds: true,
  mountUserWriteIds: true,
} as const;

/**
 * Pilih akun MEGA: eksplisit via accountId, atau akun aktif pertama yang
 * BOLEH DIBUKA user (peran + grant per-orang) — konsisten dengan
 * /api/cloud/mega/tree dan /api/cloud/mega/attach milik lampiran chat.
 */
async function pickMegaAccount(
  user: ImportUser,
  accountId: string | null
): Promise<MegaAccountRow | null> {
  if (accountId) {
    return db.cloudAccount.findFirst({
      where: { id: accountId, provider: "mega", email: { not: null } },
      select: MEGA_ACCOUNT_SELECT,
    });
  }
  const rows = await db.cloudAccount.findMany({
    where: {
      provider: "mega",
      active: true,
      email: { not: null },
      lastStatus: { not: "error" },
    },
    orderBy: { fileCount: "asc" },
    select: MEGA_ACCOUNT_SELECT,
  });
  return rows.find((a) => canViewMount(a, user.role, user.id)) ?? null;
}

/**
 * Impor file dari mount MEGA sebagai materi AI. File TIDAK disalin ke
 * penyimpanan Aula — bytes diunduh sekali untuk ekstraksi teks; node
 * asli tetap utuh di akun MEGA (persis sifat lampiran chat).
 */
export async function importFromMega(
  user: ImportUser,
  rawAccountId: string | null,
  rawNodeId: string
): Promise<ImportedFile> {
  const nodeId = (rawNodeId || "").trim();
  if (!nodeId) {
    throw new ImportError("Berikan nodeId berkas MEGA", 400);
  }
  const accountId =
    typeof rawAccountId === "string" && rawAccountId.trim()
      ? rawAccountId.trim()
      : null;

  const account = await pickMegaAccount(user, accountId);
  if (!account || !account.email) {
    throw new ImportError(
      "Belum ada akun MEGA aktif. Tambahkan/aktifkan lewat Admin Panel → Data & Cloud.",
      404
    );
  }
  if (!canViewMount(account, user.role, user.id)) {
    throw new ImportError(
      "FORBIDDEN — kamu tidak punya izin membuka mount akun cloud ini. Minta admin mengatur hak aksesnya.",
      403
    );
  }

  const accountLike: MegaAccountLike = {
    id: account.id,
    email: account.email,
    password: account.password,
    sessionData: account.sessionData,
  };

  let stat: { name: string; size: number; isFolder: boolean };
  try {
    stat = await megaStat(accountLike, nodeId);
  } catch (e) {
    throw new ImportError(
      `Gagal membaca file MEGA: ${describeMegaError(e)}`,
      502
    );
  }
  if (stat.isFolder) {
    throw new ImportError(
      "Folder tidak bisa dilampirkan — pilih file di dalamnya.",
      400
    );
  }
  if (stat.size > MAX_IMPORT_SIZE) {
    throw new ImportError("Berkas terlalu besar (maks 4 MB)", 413);
  }

  const buf = await megaDownload(accountLike, nodeId);
  if (!buf || buf.length === 0) {
    throw new ImportError(
      "Gagal mengunduh berkas dari MEGA — coba lagi.",
      502
    );
  }
  if (buf.length > MAX_IMPORT_SIZE) {
    throw new ImportError("Berkas terlalu besar (maks 4 MB)", 413);
  }

  return {
    name: stat.name || "berkas",
    mime: resolveMime(stat.name, ""),
    buf,
    origin: `MEGA · ${account.name}`,
  };
}
