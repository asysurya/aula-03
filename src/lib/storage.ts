import { randomBytes } from "crypto";
import { promises as fs } from "fs";
import path from "path";
import { db } from "@/lib/db";
import { fileCacheDelete } from "@/lib/file-cache";
import {
  megaUploadTo,
  megaDownload,
  megaDelete,
  parseMegaKey,
  describeMegaError,
  type MegaAccountLike,
} from "@/lib/mega-storage";
import {
  s3Upload,
  s3Download,
  s3Delete,
  parseS3Key,
  type S3AccountLike,
} from "@/lib/s3-storage";

// Storage abstraction.
// - Provider didukung: MEGA (provider "mega") dan S3-compatible
//   (provider "s3" — Cloudflare R2 / B2 / Spaces / Wasabi / MinIO / AWS).
// - saveFile memilih MEGA dulu (jika ada & aktif); bila MEGA gagal
//   (mis. akun diblokir EBLOCKED) atau tidak dikonfigurasi → otomatis
//   fallback ke S3. Tidak ada fallback lokal: file harus tersimpan di cloud
//   agar tetap ada setelah deploy ulang.
// - getFile/deleteFile dispatch berdasarkan prefix storageKey:
//     `mega:<accountId>:<nodeId>`  → MEGA
//     `s3:<accountId>:<objectKey>` → S3
//     lainnya                      → local filesystem (file lama / staging sync)
//
// See DEPLOY.md (MongoDB + Cloud Storage section) for production notes.

const UPLOAD_DIR = path.join(process.cwd(), "uploads");
const MAX_SIZE = 100 * 1024 * 1024; // 100 MB

export const MAX_FILE_SIZE = MAX_SIZE;
export const ALLOWED_MIMES = new Set<string>([
  // docs
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "text/plain",
  "text/markdown",
  "application/json",
  // images
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
  // archives
  "application/zip",
  "application/x-zip-compressed",
  // audio/video
  "audio/mpeg",
  "audio/mp4",
  "video/mp4",
  "video/webm",
]);

function isImage(mime: string) {
  return mime.startsWith("image/");
}

export interface SaveFileResult {
  storageKey: string;
  size: number;
  cloudAccountId: string | null;
}

/**
 * Pick the next MEGA account for upload (lowest fileCount wins).
 * Accepts any active account whose lastStatus is NOT "error"
 * (i.e. "connected" or "unknown"/"checking"). This way a freshly
 * added account (status "unknown") is immediately usable for uploads,
 * and only accounts that explicitly failed testing are skipped.
 * Returns null when no active account is available.
 */
async function pickMegaAccount(): Promise<MegaAccountLike | null> {
  const account = await db.cloudAccount.findFirst({
    where: {
      provider: "mega",
      active: true,
      email: { not: null },
      password: { not: null },
      lastStatus: { not: "error" },
    },
    orderBy: { fileCount: "asc" },
    select: {
      id: true,
      email: true,
      password: true,
      sessionData: true,
    },
  });
  return account;
}

/**
 * Pick the next S3-compatible account (fallback / alternatif MEGA).
 * Syarat sama: aktif + status bukan "error" + konfigurasi lengkap.
 */
async function pickS3Account(): Promise<S3AccountLike | null> {
  const account = await db.cloudAccount.findFirst({
    where: {
      provider: "s3",
      active: true,
      bucket: { not: null },
      accessKeyId: { not: null },
      secretAccessKey: { not: null },
      lastStatus: { not: "error" },
    },
    orderBy: { fileCount: "asc" },
    select: {
      id: true,
      endpoint: true,
      region: true,
      bucket: true,
      accessKeyId: true,
      secretAccessKey: true,
    },
  });
  return account;
}

async function loadMegaAccountLike(
  accountId: string
): Promise<MegaAccountLike | null> {
  const account = await db.cloudAccount.findUnique({
    where: { id: accountId },
    select: { id: true, email: true, password: true, sessionData: true },
  });
  if (!account) return null;
  return {
    id: account.id,
    email: account.email,
    password: account.password,
    sessionData: account.sessionData,
  };
}

async function loadS3AccountLike(
  accountId: string
): Promise<S3AccountLike | null> {
  const account = await db.cloudAccount.findUnique({
    where: { id: accountId },
    select: {
      id: true,
      endpoint: true,
      region: true,
      bucket: true,
      accessKeyId: true,
      secretAccessKey: true,
    },
  });
  if (!account) return null;
  return account;
}

// ───────────────────────── Local filesystem helpers ─────────────────────────

async function saveLocal(
  name: string,
  bytes: Buffer
): Promise<{ storageKey: string; size: number }> {
  await fs.mkdir(UPLOAD_DIR, { recursive: true });
  const id = randomBytes(16).toString("hex");
  const ext = path.extname(name) || "";
  const key = `${id}${ext}`;
  await fs.writeFile(path.join(UPLOAD_DIR, key), bytes);
  return { storageKey: key, size: bytes.length };
}

async function getLocal(storageKey: string): Promise<{ bytes: Buffer } | null> {
  try {
    const full = path.join(UPLOAD_DIR, storageKey);
    const bytes = await fs.readFile(full);
    return { bytes };
  } catch {
    return null;
  }
}

async function deleteLocal(storageKey: string): Promise<void> {
  try {
    await fs.unlink(path.join(UPLOAD_DIR, storageKey));
  } catch {
    /* ignore */
  }
}

// ───────────────────────── Public storage API ─────────────────────────

export { saveLocal, getLocal, deleteLocal };

/**
 * Save a file ke cloud. Preferensi: MEGA → S3. Bila keduanya gagal /
 * tidak ada, error dilempar dengan pesan yang bisa ditindaklanjuti.
 *
 * Catatan error: "MEGA_NOT_CONFIGURED" dipertahankan sebagai nama error
 * bila TIDAK ADA akun cloud sama sekali (pesan lengkap menyebut S3).
 */
export async function saveFile(
  name: string,
  mimetype: string,
  bytes: Buffer
): Promise<SaveFileResult> {
  if (bytes.length > MAX_SIZE) {
    throw new Error("FILE_TOO_LARGE");
  }

  // ── 1. Coba MEGA dulu ──
  const mega = await pickMegaAccount();
  if (mega) {
    try {
      const result = await megaUploadTo(mega, null, name, bytes, mimetype);
      try {
        await db.cloudAccount.update({
          where: { id: mega.id },
          data: { fileCount: { increment: 1 } },
        });
      } catch {
        /* ignore counter errors */
      }
      return {
        storageKey: result.storageKey,
        size: result.size,
        cloudAccountId: mega.id,
      };
    } catch (e) {
      // Akun MEGA bermasalah (diblokir / rate limit) → coba S3.
      // Kalau S3 juga tidak ada, lempar error MEGA yang asli.
      const s3 = await pickS3Account();
      if (!s3) {
        throw new Error(describeMegaError(e));
      }
      // jatuh ke blok S3 di bawah
      return await saveToS3(s3, name, bytes, mimetype);
    }
  }

  // ── 2. Tidak ada MEGA → S3 ──
  const s3 = await pickS3Account();
  if (s3) {
    return await saveToS3(s3, name, bytes, mimetype);
  }

  throw new Error(
    "CLOUD_NOT_CONFIGURED: belum ada akun cloud aktif. Tambahkan akun MEGA atau S3 (Cloudflare R2 / Backblaze B2 / Spaces) lewat Admin Panel → Data & Cloud."
  );
}

async function saveToS3(
  s3: S3AccountLike,
  name: string,
  bytes: Buffer,
  mimetype: string
): Promise<SaveFileResult> {
  const result = await s3Upload(s3, name, bytes, mimetype);
  try {
    await db.cloudAccount.update({
      where: { id: s3.id },
      data: { fileCount: { increment: 1 } },
    });
  } catch {
    /* ignore counter errors */
  }
  return {
    storageKey: result.storageKey,
    size: result.size,
    cloudAccountId: s3.id,
  };
}

/**
 * Read file bytes by storageKey. Dispatches MEGA / S3 / local automatically.
 */
export async function getFile(storageKey: string): Promise<{
  bytes: Buffer;
} | null> {
  const mega = parseMegaKey(storageKey);
  if (mega) {
    const account = await loadMegaAccountLike(mega.accountId);
    if (!account) return null;
    const buf = await megaDownload(account, mega.nodeId);
    return buf ? { bytes: buf } : null;
  }
  const s3 = parseS3Key(storageKey);
  if (s3) {
    const account = await loadS3AccountLike(s3.accountId);
    if (!account) return null;
    const buf = await s3Download(account, s3.objectKey);
    return buf ? { bytes: buf } : null;
  }
  return getLocal(storageKey);
}

/**
 * Delete file by storageKey. Dispatches MEGA / S3 / local automatically.
 * Also decrements the owning cloudAccount.fileCount when applicable.
 */
export async function deleteFile(storageKey: string): Promise<void> {
  // Blob dihapus → evict dari LRU cache supaya tidak menyajikan file mati.
  fileCacheDelete(storageKey);
  const mega = parseMegaKey(storageKey);
  if (mega) {
    const account = await db.cloudAccount.findUnique({
      where: { id: mega.accountId },
      select: { id: true, fileCount: true },
    });
    if (account) {
      const accountLike = await loadMegaAccountLike(mega.accountId);
      if (accountLike) {
        await megaDelete(accountLike, mega.nodeId);
      }
      try {
        const next = Math.max(0, (account.fileCount ?? 0) - 1);
        await db.cloudAccount.update({
          where: { id: account.id },
          data: { fileCount: next },
        });
      } catch {
        /* ignore */
      }
    }
    return;
  }
  const s3 = parseS3Key(storageKey);
  if (s3) {
    const account = await db.cloudAccount.findUnique({
      where: { id: s3.accountId },
      select: { id: true, fileCount: true },
    });
    const accountLike = await loadS3AccountLike(s3.accountId);
    if (accountLike) {
      await s3Delete(accountLike, s3.objectKey);
    }
    if (account) {
      try {
        const next = Math.max(0, (account.fileCount ?? 0) - 1);
        await db.cloudAccount.update({
          where: { id: account.id },
          data: { fileCount: next },
        });
      } catch {
        /* ignore */
      }
    }
    return;
  }
  await deleteLocal(storageKey);
}

export { filePublicUrl } from "@/lib/file-constants";

export { isImage };
