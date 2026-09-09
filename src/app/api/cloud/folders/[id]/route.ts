import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import {
  errorResponse,
  folderClassroomId,
  getClassroomRole,
} from "@/lib/cloud-utils";
import {
  canEditFolder,
  canDeleteFolder,
  type ClassroomRole,
  type UserRole,
} from "@/lib/cloud-perms";
import { deleteFile } from "@/lib/storage";

// PATCH /api/cloud/folders/[id] — rename a folder.
// Body: { name: string } (1-120 chars, not empty). Allowed for ADMIN/GURU,
// creator, or classroom TEACHER.
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
  if (name.length > 120) return errorResponse("NAME_TOO_LONG", 400);

  const folder = await db.cloudFolder.findUnique({
    where: { id },
    select: {
      id: true,
      visibility: true,
      createdBy: true,
      classroomId: true,
    },
  });
  if (!folder) return errorResponse("FOLDER_NOT_FOUND", 404);

  // Resolve classroom role for edit check.
  let classroomRole: ClassroomRole | null = null;
  let cid = folder.classroomId;
  if (!cid) cid = await folderClassroomId(id);
  if (cid) {
    classroomRole =
      user.role === "ADMIN" ? "TEACHER" : await getClassroomRole(cid, user.id);
  }

  if (
    !canEditFolder(
      {
        id: folder.id,
        visibility: folder.visibility,
        createdBy: folder.createdBy,
      },
      user.id,
      user.role as UserRole,
      classroomRole
    )
  ) {
    return errorResponse("FORBIDDEN", 403);
  }

  const updated = await db.cloudFolder.update({
    where: { id },
    data: { name },
    select: {
      id: true,
      name: true,
      type: true,
      classroomId: true,
      parentId: true,
      createdAt: true,
      createdBy: true,
      visibility: true,
    },
  });

  return Response.json({ folder: updated });
}

// DELETE /api/cloud/folders/[id] — delete folder + all descendants + their
// files (storage blobs included). Stricter: only ADMIN/GURU/creator may delete.
// Assignment folders also delete the linked Assignment + Submissions (cascade).
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await requireUser().catch(() => null);
  if (!user) return errorResponse("UNAUTHORIZED", 401);

  const { id } = await params;

  const folder = await db.cloudFolder.findUnique({
    where: { id },
    select: {
      id: true,
      visibility: true,
      createdBy: true,
      classroomId: true,
    },
  });
  if (!folder) return errorResponse("FOLDER_NOT_FOUND", 404);

  // Stricter delete check: ADMIN, GURU, or owner only.
  if (
    !canDeleteFolder(
      { createdBy: folder.createdBy },
      user.id,
      user.role as UserRole
    )
  ) {
    return errorResponse("FORBIDDEN", 403);
  }

  // Recursively collect all descendant folder IDs (BFS).
  const allFolderIds: string[] = [id];
  const stack = [id];
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

  // Gather all files within these folders (including root-level files of
  // the top folder itself, but we already include id in allFolderIds).
  const filesInFolders = await db.cloudFile.findMany({
    where: { folderId: { in: allFolderIds } },
    select: { id: true, storageKey: true, submission: { select: { id: true } } },
  });

  // Clear submission links for any files tied to submissions.
  const filesWithSubs = filesInFolders.filter((f) => f.submission);
  if (filesWithSubs.length > 0) {
    await db.submission.updateMany({
      where: { fileId: { in: filesWithSubs.map((f) => f.id) } },
      data: { fileId: null },
    });
  }

  // Delete the folder rows (cascades FolderAccess, child folders, files,
  // docs, assignment+submissions via onDelete: Cascade).
  await db.cloudFolder.deleteMany({
    where: { id: { in: allFolderIds } },
  });

  // Best-effort delete of underlying storage blobs.
  const storageKeys = Array.from(
    new Set(filesInFolders.map((f) => f.storageKey))
  );
  for (const key of storageKeys) {
    try {
      await deleteFile(key);
    } catch {
      // Non-fatal.
    }
  }

  return Response.json({ ok: true, deletedFolderCount: allFolderIds.length });
}
