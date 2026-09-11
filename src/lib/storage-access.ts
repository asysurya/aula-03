import { db } from "@/lib/db";
import { parseMegaKey } from "@/lib/mega-storage";
import { canViewMount } from "@/lib/mount-access";
import { folderClassroomId, getClassroomRole } from "@/lib/cloud-utils";
import { canViewFile, type UserRole, type ClassroomRole } from "@/lib/cloud-perms";
import { parseS3Key } from "@/lib/s3-storage";

// ─────────────────────────────────────────────────────────────────────────
// Pemeriksaan akses file storage — logika yang SAMA dipakai oleh:
//   1. GET/HEAD /api/storage/[key]  (penyajian file)
//   2. GET /api/storage/[key]/link  (URL presigned S3 utk unduhan cepat)
// Dipisah ke lib supaya kedua route tidak pernah berbeda kebijakan.
// ─────────────────────────────────────────────────────────────────────────

export interface SessionUserLike {
  id: string;
  role: string;
}

export type StorageAccess =
  | {
      ok: true;
      /** File cloud biasa (punya baris CloudFile). */
      kind: "cloud";
      file: {
        id: string;
        name: string;
        mimetype: string;
        size: number;
        storageKey: string;
        expiresAt: Date | null;
      };
    }
  | {
      ok: true;
      /** File mentah dari mount MEGA (tanpa baris CloudFile). */
      kind: "mega-raw";
      accountId: string;
    }
  | { ok: false; status: number; body: string };

/**
 * Cek apakah user boleh membaca storageKey ini. `status` yang dikembalikan
 * untuk kegagalan mengikuti semantik /api/storage (401/403/404/410).
 */
export async function checkStorageAccess(
  sessionUser: SessionUserLike | null,
  key: string
): Promise<StorageAccess> {
  if (!sessionUser) {
    return { ok: false, status: 401, body: "Unauthorized" };
  }

  const file = await db.cloudFile.findFirst({
    where: { storageKey: key },
    select: {
      id: true,
      name: true,
      mimetype: true,
      size: true,
      storageKey: true,
      visibility: true,
      uploadedBy: true,
      folderId: true,
      expiresAt: true,
      grants: { select: { userId: true } },
    },
  });

  if (!file) {
    const mega = parseMegaKey(key);
    if (!mega) return { ok: false, status: 404, body: "Not found" };
    const mountAccount = await db.cloudAccount.findUnique({
      where: { id: mega.accountId },
      select: { id: true, mountVisibleTo: true, mountMode: true },
    });
    if (!mountAccount || !canViewMount(mountAccount, sessionUser.role)) {
      return { ok: false, status: 404, body: "Not found" };
    }
    return { ok: true, kind: "mega-raw", accountId: mega.accountId };
  }

  // File sementara (lampiran chat) yang sudah kedaluwarsa → anggap hilang.
  if (file.expiresAt && file.expiresAt.getTime() < Date.now()) {
    return { ok: false, status: 410, body: "Gone" };
  }

  // Izin: file kelas → cek keanggotaan kelas + visibility.
  let classroomRole: ClassroomRole | null = null;
  if (file.folderId) {
    const cid = await folderClassroomId(file.folderId);
    if (cid) {
      classroomRole =
        sessionUser.role === "ADMIN"
          ? "TEACHER"
          : await getClassroomRole(cid, sessionUser.id);
    }
  }

  const allowed =
    !file.folderId
      ? true
      : canViewFile(
          {
            id: file.id,
            visibility: file.visibility,
            uploadedBy: file.uploadedBy,
            folderId: file.folderId,
            grants: file.grants,
          },
          sessionUser.id,
          sessionUser.role as UserRole,
          classroomRole
        );

  if (!allowed) {
    return { ok: false, status: 403, body: "Forbidden" };
  }

  return {
    ok: true,
    kind: "cloud",
    file: {
      id: file.id,
      name: file.name,
      mimetype: file.mimetype,
      size: file.size,
      storageKey: file.storageKey,
      expiresAt: file.expiresAt,
    },
  };
}

/** Akun S3 pemilik storageKey ini (null bila bukan S3). */
export async function s3AccountOf(storageKey: string) {
  const parsed = parseS3Key(storageKey);
  if (!parsed) return null;
  const account = await db.cloudAccount.findUnique({
    where: { id: parsed.accountId },
    select: {
      id: true,
      endpoint: true,
      region: true,
      bucket: true,
      accessKeyId: true,
      secretAccessKey: true,
    },
  });
  if (!account || !account.bucket || !account.accessKeyId || !account.secretAccessKey) {
    return null;
  }
  return { account, objectKey: parsed.objectKey };
}
