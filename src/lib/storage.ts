import { randomBytes } from "crypto";
import { promises as fs } from "fs";
import path from "path";
import { db } from "@/lib/db";
import {
  megaUpload,
  megaDownload,
  megaDelete,
  parseMegaKey,
  type MegaAccountLike,
} from "@/lib/mega-storage";

// Storage abstraction.
// - Default: local filesystem (`/uploads`).
// - If an active MEGA CloudAccount (provider=mega, lastStatus=connected) exists,
//   uploads route to MEGA (round-robin by lowest fileCount). On any MEGA error
//   the upload falls back to local filesystem so the app never breaks.
// - getFile/deleteFile dispatch by storageKey prefix:
//     `mega:<accountId>:<nodeId>` → MEGA
//     anything else → local filesystem
//
// See DEPLOY.md (MongoDB + MEGA Storage section) for production notes.

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
async function pickMegaAccount(): Promise<{
  id: string;
  email: string | null;
  password: string | null;
} | null> {
  const account = await db.cloudAccount.findFirst({
    where: {
      provider: "mega",
      active: true,
      email: { not: null },
      password: { not: null },
      lastStatus: { not: "error" },
    },
    orderBy: { fileCount: "asc" },
    select: { id: true, email: true, password: true },
  });
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
 * Save a file. MEGA is REQUIRED — uploads go directly to MEGA (round-robin
 * across active accounts). No local fallback: if no MEGA account is
 * configured or the upload fails, an error is thrown.
 *
 * The only exception is the sync feature, which uses saveLocal directly
 * to stage files before migrating them to MEGA.
 */
export async function saveFile(
  name: string,
  mimetype: string,
  bytes: Buffer
): Promise<SaveFileResult> {
  if (bytes.length > MAX_SIZE) {
    throw new Error("FILE_TOO_LARGE");
  }

  // MEGA is required — no local fallback.
  const account = await pickMegaAccount();
  if (!account || !account.email || !account.password) {
    throw new Error("MEGA_NOT_CONFIGURED");
  }
  const accountLike: MegaAccountLike = {
    id: account.id,
    email: account.email,
    password: account.password,
  };
  const result = await megaUpload(accountLike, name, bytes, mimetype);
  // Bump fileCount (best-effort).
  try {
    await db.cloudAccount.update({
      where: { id: account.id },
      data: { fileCount: { increment: 1 } },
    });
  } catch {
    /* ignore counter errors */
  }
  return {
    storageKey: result.storageKey,
    size: result.size,
    cloudAccountId: account.id,
  };
}

/**
 * Read file bytes by storageKey. Dispatches MEGA vs local automatically.
 */
export async function getFile(storageKey: string): Promise<{
  bytes: Buffer;
} | null> {
  const mega = parseMegaKey(storageKey);
  if (mega) {
    const account = await db.cloudAccount.findUnique({
      where: { id: mega.accountId },
      select: { id: true, email: true, password: true },
    });
    if (!account || !account.email || !account.password) return null;
    const buf = await megaDownload(
      {
        id: account.id,
        email: account.email,
        password: account.password,
      },
      mega.nodeId
    );
    return buf ? { bytes: buf } : null;
  }
  return getLocal(storageKey);
}

/**
 * Delete file by storageKey. Dispatches MEGA vs local automatically.
 * Also decrements the owning cloudAccount.fileCount when applicable.
 */
export async function deleteFile(storageKey: string): Promise<void> {
  const mega = parseMegaKey(storageKey);
  if (mega) {
    const account = await db.cloudAccount.findUnique({
      where: { id: mega.accountId },
      select: { id: true, email: true, password: true, fileCount: true },
    });
    if (account && account.email && account.password) {
      await megaDelete(
        {
          id: account.id,
          email: account.email,
          password: account.password,
        },
        mega.nodeId
      );
      // Decrement counter (floor at 0).
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
