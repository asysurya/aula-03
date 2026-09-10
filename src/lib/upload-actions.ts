import { db } from "@/lib/db";
import type { AppSession } from "@/lib/auth";
import {
  folderClassroomId,
  getClassroomRole,
  isClassroomMember,
} from "@/lib/cloud-utils";
import {
  canSetVisibility,
  parseVisibility,
  type ClassroomRole,
  type UserRole,
} from "@/lib/cloud-perms";
import { ALLOWED_MIMES, MAX_FILE_SIZE, saveFile, deleteFile } from "@/lib/storage";
import { resolveMime } from "@/lib/file-constants";
import { megaUploadTo, describeMegaError, type MegaAccountLike } from "@/lib/mega-storage";
import { canWriteMount } from "@/lib/mount-access";
import { hardDeleteCloudFilesByIds } from "@/lib/hard-delete";

// ─────────────────────────────────────────────────────────────────────────
// Upload actions — inti logika SEMUA endpoint upload file.
//
// Dipakai di dua jalur:
// 1. Route HTTP asli (multipart langsung) — untuk file kecil (≤ 4 MB).
// 2. Route /api/upload/complete (chunked) — untuk file besar yang dipecah
//    supaya lolos batas body 4.5 MB serverless Vercel.
//
// Setiap action menerima file yang SUDAH dirakit (bytes di memori) dan
// mengembalikan { status, body } identik dengan response route aslinya,
// supaya client tidak perlu tahu jalur mana yang dipakai.
// ─────────────────────────────────────────────────────────────────────────

export type SessionUser = AppSession["user"];

export interface UploadBytes {
  name: string;
  mimetype: string;
  size: number;
  bytes: Buffer;
}

export interface ActionResult {
  status: number;
  body: unknown;
}

function ok(body: unknown, status = 201): ActionResult {
  return { status, body };
}

function fail(
  error: string,
  status: number,
  extra?: Record<string, unknown>
): ActionResult {
  return { status, body: { error, ...extra } };
}

// Validasi file standar: tidak kosong, ≤ MAX_FILE_SIZE, mimetype diizinkan.
// Mimetype dinormalisasi dulu: OS bisa mengirim mimetype kosong/salah —
// infer dari ekstensi (resolveMime) sebelum dicek.
function validateStandard(file: UploadBytes): ActionResult | null {
  file.mimetype = resolveMime(file.name, file.mimetype);
  if (file.size === 0) return fail("FILE_EMPTY", 400);
  if (file.size > MAX_FILE_SIZE)
    return fail("FILE_TOO_LARGE", 413, { maxBytes: MAX_FILE_SIZE });
  if (!ALLOWED_MIMES.has(file.mimetype))
    return fail("MIME_NOT_ALLOWED", 415, { mimetype: file.mimetype });
  return null;
}

async function persist(
  file: UploadBytes
): Promise<{ stored: Awaited<ReturnType<typeof saveFile>> } | ActionResult> {
  try {
    return { stored: await saveFile(file.name, file.mimetype, file.bytes) };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "SAVE_FAILED";
    return fail(msg, 502);
  }
}

// ───────────────────────── 1. Cloud file (materi) ─────────────────────────

export async function uploadCloudFileAction(
  user: SessionUser,
  file: UploadBytes,
  params: { folderId?: string | null; classroomId?: string | null; visibility?: string | null }
): Promise<ActionResult> {
  const invalid = validateStandard(file);
  if (invalid) return invalid;

  let targetClassroomId: string | null = null;
  if (params.folderId) {
    const folder = await db.cloudFolder.findUnique({
      where: { id: params.folderId },
      select: { id: true, classroomId: true },
    });
    if (!folder) return fail("FOLDER_NOT_FOUND", 404);
    const classroomId = await folderClassroomId(params.folderId);
    if (!classroomId) return fail("FOLDER_NO_CLASSROOM", 400);
    if (user.role !== "ADMIN" && !(await isClassroomMember(classroomId, user.id))) {
      return fail("FORBIDDEN", 403);
    }
    targetClassroomId = classroomId;
  } else if (params.classroomId) {
    if (user.role !== "ADMIN" && !(await isClassroomMember(params.classroomId, user.id))) {
      return fail("FORBIDDEN", 403);
    }
    targetClassroomId = params.classroomId;
  } else {
    return fail("FOLDER_OR_CLASSROOM_REQUIRED", 400);
  }

  const userRole = user.role as UserRole;
  const classroomRole: ClassroomRole | null =
    userRole === "ADMIN" ? "TEACHER" : await getClassroomRole(targetClassroomId!, user.id);
  const visibility = parseVisibility(params.visibility ?? null) ?? "ALL";
  if (!canSetVisibility(visibility, true, userRole, classroomRole)) {
    return fail("VISIBILITY_NOT_ALLOWED", 403);
  }

  const res = await persist(file);
  if ("status" in res) return res;
  const { stored } = res;

  const row = await db.cloudFile.create({
    data: {
      name: file.name,
      folderId: params.folderId ?? null,
      uploadedBy: user.id,
      storageKey: stored.storageKey,
      size: stored.size,
      mimetype: file.mimetype,
      cloudAccountId: stored.cloudAccountId,
      visibility,
    },
    select: {
      id: true,
      name: true,
      size: true,
      mimetype: true,
      storageKey: true,
      cloudAccountId: true,
      createdAt: true,
      uploadedBy: true,
      visibility: true,
      uploader: { select: { id: true, name: true, username: true } },
    },
  });

  return ok({ file: row });
}

// ───────────────────────── 2. Submission (tugas siswa) ─────────────────────────

export async function uploadSubmissionAction(
  user: SessionUser,
  file: UploadBytes | null,
  params: { assignmentId: string; note?: string | null }
): Promise<ActionResult> {
  const assignment = await db.assignment.findUnique({
    where: { id: params.assignmentId },
    select: { id: true, folderId: true },
  });
  if (!assignment) return fail("ASSIGNMENT_NOT_FOUND", 404);

  const classroomId = await folderClassroomId(assignment.folderId);
  if (!classroomId) return fail("FOLDER_NO_CLASSROOM", 400);

  const role =
    user.role === "ADMIN" ? "TEACHER" : await getClassroomRole(classroomId, user.id);
  if (!role) return fail("FORBIDDEN", 403);
  if (role !== "STUDENT") return fail("STUDENT_ONLY", 403);

  const note = params.note ?? null;
  let fileId: string | null = null;
  if (file) {
    const invalid = validateStandard(file);
    if (invalid) return invalid;
    const res = await persist(file);
    if ("status" in res) return res;
    const { stored } = res;

    const row = await db.cloudFile.create({
      data: {
        name: file.name,
        folderId: assignment.folderId,
        uploadedBy: user.id,
        storageKey: stored.storageKey,
        size: stored.size,
        mimetype: file.mimetype,
        cloudAccountId: stored.cloudAccountId,
      },
      select: { id: true },
    });
    fileId = row.id;
  }

  const submissionSelect = {
    id: true,
    assignmentId: true,
    userId: true,
    fileId: true,
    note: true,
    submittedAt: true,
    file: {
      select: { id: true, name: true, size: true, mimetype: true, storageKey: true },
    },
  } as const;

  const existing = await db.submission.findUnique({
    where: { assignmentId_userId: { assignmentId: params.assignmentId, userId: user.id } },
    select: { id: true, fileId: true },
  });

  let submission;
  if (existing) {
    const oldFileId = existing.fileId;
    let oldStorageKey: string | null = null;
    if (oldFileId && oldFileId !== fileId) {
      const oldFile = await db.cloudFile
        .findUnique({ where: { id: oldFileId }, select: { storageKey: true } })
        .catch(() => null);
      oldStorageKey = oldFile?.storageKey ?? null;
    }
    submission = await db.submission.update({
      where: { id: existing.id },
      data: {
        note: note?.trim() ? note.trim() : null,
        fileId,
        submittedAt: new Date(),
      },
      select: submissionSelect,
    });
    if (oldFileId && oldFileId !== fileId) {
      await db.cloudFile.delete({ where: { id: oldFileId } }).catch(() => {});
      if (oldStorageKey) await deleteFile(oldStorageKey);
    }
  } else {
    submission = await db.submission.create({
      data: {
        assignmentId: params.assignmentId,
        userId: user.id,
        fileId,
        note: note?.trim() ? note.trim() : null,
      },
      select: submissionSelect,
    });
  }

  return ok({ submission });
}

// ───────────────────────── 3. Upload langsung ke mount MEGA ─────────────────────────

export async function uploadMegaFileAction(
  user: SessionUser,
  file: UploadBytes,
  params: { parentId?: string | null; accountId?: string | null }
): Promise<ActionResult> {
  const invalid = validateStandard(file);
  if (invalid) return invalid;

  const select = {
    id: true,
    email: true,
    password: true,
    sessionData: true,
    mountVisibleTo: true,
    mountMode: true,
  };
  const account = params.accountId
    ? await db.cloudAccount.findFirst({
        where: { id: params.accountId, provider: "mega", email: { not: null } },
        select,
      })
    : await db.cloudAccount.findFirst({
        where: {
          provider: "mega",
          active: true,
          email: { not: null },
          lastStatus: { not: "error" },
        },
        orderBy: { fileCount: "asc" },
        select,
      });
  if (!account || !account.email) {
    return fail("Belum ada akun MEGA aktif.", 404);
  }
  // ── Hak akses mount: unggah = operasi TULIS ──
  if (!canWriteMount(account, user.role)) {
    return fail(
      "Mount ini baca-saja untukmu (hak akses diatur admin di Admin Panel → Data & Cloud).",
      403
    );
  }
  const accountLike: MegaAccountLike = account;

  try {
    const result = await megaUploadTo(accountLike, params.parentId ?? null, file.name, file.bytes, file.mimetype);
    try {
      await db.cloudAccount.update({
        where: { id: account.id },
        data: { fileCount: { increment: 1 } },
      });
    } catch {
      /* ignore */
    }
    return ok({
      ok: true,
      nodeId: result.nodeId,
      storageKey: result.storageKey,
      size: result.size,
    });
  } catch (e) {
    return fail(`Upload ke MEGA gagal: ${describeMegaError(e)}`, 502);
  }
}

// ───────────────────────── 4. Lampiran chat (sementara 24 jam) ─────────────────────────

type ConversationKind = "classroom" | "group" | "dm";
const ATTACHMENT_TTL_MS = 24 * 60 * 60 * 1000;

async function assertMembership(
  kind: ConversationKind,
  id: string,
  userId: string
): Promise<boolean> {
  if (kind === "classroom") {
    const m = await db.classroomMember.findUnique({
      where: { classroomId_userId: { classroomId: id, userId } },
    });
    return !!m;
  }
  if (kind === "group") {
    const m = await db.groupMember.findUnique({
      where: { groupId_userId: { groupId: id, userId } },
    });
    return !!m;
  }
  if (kind === "dm") {
    const dm = await db.dMConversation.findUnique({ where: { id } });
    if (!dm) return false;
    return dm.user1Id === userId || dm.user2Id === userId;
  }
  return false;
}

export async function uploadAttachmentAction(
  user: SessionUser,
  file: UploadBytes,
  params: { kind: string; id: string }
): Promise<ActionResult> {
  const invalid = validateStandard(file);
  if (invalid) return invalid;
  if (!["classroom", "group", "dm"].includes(params.kind)) {
    return fail("Invalid kind", 400);
  }
  const member = await assertMembership(params.kind as ConversationKind, params.id, user.id);
  if (!member) return fail("Forbidden", 403);

  const res = await persist(file);
  if ("status" in res) return res;
  const { stored } = res;

  const row = await db.cloudFile.create({
    data: {
      name: file.name,
      folderId: null,
      uploadedBy: user.id,
      storageKey: stored.storageKey,
      size: stored.size,
      mimetype: file.mimetype,
      visibility: "ALL",
      cloudAccountId: stored.cloudAccountId,
      expiresAt: new Date(Date.now() + ATTACHMENT_TTL_MS),
    },
    select: { id: true, name: true, size: true, mimetype: true, storageKey: true },
  });

  return ok({
    fileId: row.id,
    name: row.name,
    size: row.size,
    mimetype: row.mimetype,
    storageKey: row.storageKey,
  });
}

// ───────────────────────── 5. Avatar profil ─────────────────────────

const MAX_AVATAR_BYTES = 5 * 1024 * 1024;

function avatarStorageKeyFromUrl(url: string | null): string | null {
  if (!url || !url.startsWith("/api/storage/")) return null;
  try {
    return decodeURIComponent(url.slice("/api/storage/".length));
  } catch {
    return null;
  }
}

async function cleanupOldAvatar(userId: string): Promise<void> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { avatarUrl: true },
  });
  const oldKey = avatarStorageKeyFromUrl(user?.avatarUrl ?? null);
  if (!oldKey) return;
  const rows = await db.cloudFile.findMany({
    where: { storageKey: oldKey },
    select: { id: true },
  });
  if (rows.length > 0) {
    await hardDeleteCloudFilesByIds(rows.map((r) => r.id));
  }
}

export async function uploadAvatarAction(
  user: SessionUser,
  file: UploadBytes
): Promise<ActionResult> {
  if (file.size === 0) return fail("FILE_EMPTY", 400);
  if (file.size > MAX_AVATAR_BYTES) return fail("Foto maksimal 5 MB", 413);
  if (!file.mimetype.startsWith("image/")) {
    return fail("File harus berupa gambar (jpg/png/webp/gif)", 415);
  }

  const name = file.name || "avatar.png";
  const res = await persist({ ...file, name });
  if ("status" in res) return res;
  const { stored } = res;

  await db.cloudFile.create({
    data: {
      name,
      folderId: null,
      uploadedBy: user.id,
      storageKey: stored.storageKey,
      size: stored.size,
      mimetype: file.mimetype,
      cloudAccountId: stored.cloudAccountId,
      visibility: "ALL",
    },
  });

  await cleanupOldAvatar(user.id);

  const avatarUrl = `/api/storage/${stored.storageKey}`;
  await db.user.update({ where: { id: user.id }, data: { avatarUrl } });

  return ok({ ok: true, avatarUrl });
}

// ───────────────────────── 6. Gambar soal form (guru) ─────────────────────────

export async function uploadFormImageAction(
  user: SessionUser,
  file: UploadBytes,
  params: { folderId: string }
): Promise<ActionResult> {
  if (file.size === 0) return fail("FILE_EMPTY", 400);
  if (file.size > MAX_FILE_SIZE) return fail("FILE_TOO_LARGE", 413);
  if (!ALLOWED_MIMES.has(file.mimetype) || !file.mimetype.startsWith("image/")) {
    return fail("IMAGE_REQUIRED", 415);
  }

  const assignment = await db.assignment.findUnique({
    where: { folderId: params.folderId },
    select: { id: true },
  });
  if (!assignment) return fail("ASSIGNMENT_NOT_FOUND", 404);

  const classroomId = await folderClassroomId(params.folderId);
  if (!classroomId) return fail("FOLDER_NO_CLASSROOM", 400);
  const myRole = user.role === "ADMIN" ? "TEACHER" : await getClassroomRole(classroomId, user.id);
  if (myRole !== "TEACHER") return fail("FORBIDDEN", 403);

  const res = await persist(file);
  if ("status" in res) return res;
  const { stored } = res;

  const cloudFile = await db.cloudFile.create({
    data: {
      name: file.name,
      folderId: null,
      uploadedBy: user.id,
      storageKey: stored.storageKey,
      size: stored.size,
      mimetype: file.mimetype,
      visibility: "PRIVATE",
      cloudAccountId: stored.cloudAccountId,
    },
    select: { id: true, name: true, size: true, mimetype: true, storageKey: true },
  });

  return ok({ file: cloudFile });
}

// ───────────────────────── 7. Jawaban FILE/IMAGE form (siswa) ─────────────────────────

export async function uploadAnswerFileAction(
  user: SessionUser,
  file: UploadBytes,
  params: { folderId: string; questionId: string }
): Promise<ActionResult> {
  const invalid = validateStandard(file);
  if (invalid) return invalid;
  if (!params.questionId) return fail("QUESTION_ID_REQUIRED", 400);

  const assignment = await db.assignment.findUnique({
    where: { folderId: params.folderId },
    select: { id: true },
  });
  if (!assignment) return fail("ASSIGNMENT_NOT_FOUND", 404);

  const classroomId = await folderClassroomId(params.folderId);
  if (!classroomId) return fail("FOLDER_NO_CLASSROOM", 400);
  if (user.role !== "ADMIN" && !(await isClassroomMember(classroomId, user.id))) {
    return fail("FORBIDDEN", 403);
  }

  const form = await db.form.findUnique({
    where: { assignmentId: assignment.id },
    select: { id: true },
  });
  if (!form) return fail("FORM_NOT_FOUND", 404);

  const attempt = await db.formAttempt.findUnique({
    where: { formId_userId: { formId: form.id, userId: user.id } },
  });
  if (!attempt) return fail("ATTEMPT_NOT_FOUND", 404);
  if (attempt.status !== "IN_PROGRESS") return fail("ATTEMPT_ALREADY_SUBMITTED", 409);

  const question = await db.formQuestion.findFirst({
    where: { id: params.questionId, formId: form.id },
    select: { id: true, type: true },
  });
  if (!question) return fail("QUESTION_NOT_FOUND", 404);
  if (question.type !== "FILE" && question.type !== "IMAGE") {
    return fail("QUESTION_NOT_UPLOAD_TYPE", 400);
  }
  if (question.type === "IMAGE" && !file.mimetype.startsWith("image/")) {
    return fail("IMAGE_REQUIRED", 400);
  }

  const res = await persist(file);
  if ("status" in res) return res;
  const { stored } = res;

  const cloudFile = await db.cloudFile.create({
    data: {
      name: file.name,
      folderId: null,
      uploadedBy: user.id,
      storageKey: stored.storageKey,
      size: stored.size,
      mimetype: file.mimetype,
      visibility: "PRIVATE",
      cloudAccountId: stored.cloudAccountId,
    },
    select: { id: true, name: true, size: true, mimetype: true, storageKey: true },
  });

  return ok({ file: cloudFile });
}
