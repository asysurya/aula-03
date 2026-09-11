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
import { deleteFolderCascade } from "@/lib/folder-delete";

// Penghapusan folder berantai (BFS + relasi + assignment + blob MEGA satu
// per satu) bisa melebihi batas default serverless — naikkan ke 60 detik
// supaya tidak terpotong di tengah operasi (folder setengah terhapus).
export const maxDuration = 60;

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
// Cascade logic (anti P2014 / anti "sukses bohong") kini di lib/folder-delete
// supaya bisa dipakai ulang oleh penghapusan kelas.
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await requireUser().catch(() => null);
  if (!user) return errorResponse("UNAUTHORIZED", 401);

  const { id } = await params;

  try {
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

    const deletedFolderCount = await deleteFolderCascade(id);
    return Response.json({ ok: true, deletedFolderCount });
  } catch (e) {
    console.error("[folders/delete]", e);
    return errorResponse(
      "HAPUS_GAGAL: " +
        (e instanceof Error ? e.message : "kesalahan tidak diketahui"),
      500
    );
  }
}
