import { db } from "@/lib/db";
import type { AppSession } from "@/lib/auth";

// Membership validation + classroom fetch helpers for cloud routes.

export async function isClassroomMember(
  classroomId: string | null | undefined,
  userId: string
): Promise<boolean> {
  if (!classroomId) return false;
  const m = await db.classroomMember.findUnique({
    where: {
      classroomId_userId: { classroomId, userId },
    },
    select: { id: true, role: true },
  });
  return !!m;
}

export async function getClassroomRole(
  classroomId: string,
  userId: string
): Promise<"TEACHER" | "STUDENT" | null> {
  const m = await db.classroomMember.findUnique({
    where: {
      classroomId_userId: { classroomId, userId },
    },
    select: { role: true },
  });
  return m?.role ?? null;
}

// Walk up the folder tree to determine its effective classroomId.
export async function folderClassroomId(
  folderId: string
): Promise<string | null> {
  let currentId: string | null = folderId;
  let depth = 0;
  while (currentId && depth < 16) {
    const folder = await db.cloudFolder.findUnique({
      where: { id: currentId },
      select: { id: true, parentId: true, classroomId: true },
    });
    if (!folder) return null;
    if (folder.classroomId) return folder.classroomId;
    if (!folder.parentId) return null;
    currentId = folder.parentId;
    depth += 1;
  }
  return null;
}

// Walk up folder ancestors to build breadcrumb path. Returns [{id,name,classroomId}] root-first.
export async function folderAncestors(folderId: string) {
  const path: { id: string; name: string; classroomId: string | null }[] = [];
  let currentId: string | null = folderId;
  const visited = new Set<string>();
  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    const folder = await db.cloudFolder.findUnique({
      where: { id: currentId },
      select: {
        id: true,
        name: true,
        parentId: true,
        classroomId: true,
      },
    });
    if (!folder) break;
    path.unshift({
      id: folder.id,
      name: folder.name,
      classroomId: folder.classroomId,
    });
    currentId = folder.parentId;
  }
  return path;
}

// Membership check that resolves classroomId for a folder (walking up if needed).
export async function canAccessFolder(
  folderId: string,
  user: AppSession["user"]
): Promise<boolean> {
  const classroomId = await folderClassroomId(folderId);
  if (!classroomId) return false;
  if (user.role === "ADMIN") return true;
  return isClassroomMember(classroomId, user.id);
}

// JSON error helper.
export function errorResponse(
  message: string,
  status = 400,
  extra?: Record<string, unknown>
) {
  return Response.json({ error: message, ...extra }, { status });
}
