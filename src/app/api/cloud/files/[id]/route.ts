import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { hardDeleteCloudFilesByIds } from "@/lib/hard-delete";
import { requireUser } from "@/lib/session";
import {
  errorResponse,
  folderClassroomId,
  getClassroomRole,
} from "@/lib/cloud-utils";
import {
  canEditFile,
  canDeleteFile,
  type ClassroomRole,
  type UserRole,
} from "@/lib/cloud-perms";

// PATCH /api/cloud/files/[id] — rename a file.
// Body: { name: string } (1-200 chars, not empty). Only uploader/admin/guru
// or classroom TEACHER may rename.
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
  if (name.length > 200) return errorResponse("NAME_TOO_LONG", 400);

  const file = await db.cloudFile.findUnique({
    where: { id },
    select: {
      id: true,
      uploadedBy: true,
      folderId: true,
    },
  });
  if (!file) return errorResponse("FILE_NOT_FOUND", 404);

  // Resolve classroom role for edit check.
  let classroomRole: ClassroomRole | null = null;
  if (file.folderId) {
    const cid = await folderClassroomId(file.folderId);
    if (cid) {
      classroomRole =
        user.role === "ADMIN"
          ? "TEACHER"
          : await getClassroomRole(cid, user.id);
    }
  }

  if (
    !canEditFile(
      {
        id: file.id,
        visibility: "ALL",
        uploadedBy: file.uploadedBy,
        folderId: file.folderId,
      },
      user.id,
      user.role as UserRole,
      classroomRole
    )
  ) {
    return errorResponse("FORBIDDEN", 403);
  }

  const updated = await db.cloudFile.update({
    where: { id },
    data: { name },
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

  return Response.json({ file: updated });
}

// DELETE /api/cloud/files/[id] — delete file row + storage blob.
// Stricter: only ADMIN, GURU, or the uploader (owner) may delete.
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await requireUser().catch(() => null);
  if (!user) return errorResponse("UNAUTHORIZED", 401);

  const { id } = await params;

  const file = await db.cloudFile.findUnique({
    where: { id },
    select: {
      id: true,
      storageKey: true,
      uploadedBy: true,
      folderId: true,
      submission: { select: { id: true } },
    },
  });

  if (!file) return errorResponse("FILE_NOT_FOUND", 404);

  // Stricter delete check: ADMIN, GURU, or owner only.
  if (
    !canDeleteFile(
      { uploadedBy: file.uploadedBy },
      user.id,
      user.role as UserRole
    )
  ) {
    return errorResponse("FORBIDDEN", 403);
  }

  // Hard delete: baris DB + blob MEGA/lokal + semua referensi — permanen.
  await hardDeleteCloudFilesByIds([id]);

  return Response.json({ ok: true });
}
