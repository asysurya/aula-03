import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import {
  errorResponse,
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
import { ALLOWED_MIMES, MAX_FILE_SIZE, saveFile } from "@/lib/storage";

// POST /api/cloud/files — multipart/form-data with `file` (File) + optional
// `folderId` + optional `visibility` ("ALL"|"TEACHERS"|"PRIVATE").
export async function POST(req: NextRequest) {
  const user = await requireUser().catch(() => null);
  if (!user) return errorResponse("UNAUTHORIZED", 401);

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return errorResponse("INVALID_FORMDATA", 400);
  }

  const file = form.get("file");
  const folderId = (form.get("folderId") as string | null) ?? null;
  const classroomIdParam = (form.get("classroomId") as string | null) ?? null;
  const visibilityParam = (form.get("visibility") as string | null) ?? null;

  if (!(file instanceof File)) return errorResponse("FILE_REQUIRED", 400);
  if (file.size === 0) return errorResponse("FILE_EMPTY", 400);
  if (file.size > MAX_FILE_SIZE)
    return errorResponse("FILE_TOO_LARGE", 413, { maxBytes: MAX_FILE_SIZE });

  const mimetype = file.type || "application/octet-stream";
  if (!ALLOWED_MIMES.has(mimetype))
    return errorResponse("MIME_NOT_ALLOWED", 415, { mimetype });

  // Validate folder access if folderId provided; otherwise require classroomId
  // (root-level upload) and check classroom membership.
  let targetClassroomId: string | null = null;
  if (folderId) {
    const folder = await db.cloudFolder.findUnique({
      where: { id: folderId },
      select: { id: true, classroomId: true },
    });
    if (!folder) return errorResponse("FOLDER_NOT_FOUND", 404);
    const classroomId = await folderClassroomId(folderId);
    if (!classroomId) return errorResponse("FOLDER_NO_CLASSROOM", 400);
    if (
      user.role !== "ADMIN" &&
      !(await isClassroomMember(classroomId, user.id))
    ) {
      return errorResponse("FORBIDDEN", 403);
    }
    targetClassroomId = classroomId;
  } else if (classroomIdParam) {
    if (
      user.role !== "ADMIN" &&
      !(await isClassroomMember(classroomIdParam, user.id))
    ) {
      return errorResponse("FORBIDDEN", 403);
    }
    targetClassroomId = classroomIdParam;
  } else {
    return errorResponse("FOLDER_OR_CLASSROOM_REQUIRED", 400);
  }

  // ── Visibility validation ───────────────────────────────────────
  const userRole = user.role as UserRole;
  const classroomRole: ClassroomRole | null =
    userRole === "ADMIN"
      ? "TEACHER"
      : await getClassroomRole(targetClassroomId!, user.id);
  const visibility = parseVisibility(visibilityParam) ?? "ALL";
  if (
    !canSetVisibility(
      visibility,
      true /* isCreator: will be */,
      userRole,
      classroomRole
    )
  ) {
    return errorResponse("VISIBILITY_NOT_ALLOWED", 403);
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  let stored: { storageKey: string; size: number; cloudAccountId: string | null };
  try {
    stored = await saveFile(file.name, mimetype, bytes);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "SAVE_FAILED";
    if (msg === "FILE_TOO_LARGE") {
      return errorResponse("FILE_TOO_LARGE", 413, { maxBytes: MAX_FILE_SIZE });
    }
    // Pesan error dari saveFile sudah ramah-user (deskripsi MEGA/S3 lengkap
    // dalam bahasa Indonesia) — tampilkan langsung.
    return errorResponse(msg, 502);
  }

  const row = await db.cloudFile.create({
    data: {
      name: file.name,
      folderId: folderId ?? null,
      uploadedBy: user.id,
      storageKey: stored.storageKey,
      size: stored.size,
      mimetype,
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

  return Response.json({ file: row }, { status: 201 });
}
