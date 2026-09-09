import "server-only";
import { db } from "@/lib/db";

// ───────────────────────── Types ─────────────────────────

export type Visibility = "ALL" | "TEACHERS" | "PRIVATE";
export type ClassroomRole = "TEACHER" | "STUDENT";
export type UserRole = "ADMIN" | "GURU" | "STUDENT";

// Minimal entity shapes used by the helpers — keeps the input contract small.
export interface FolderPermEntity {
  id: string;
  visibility: Visibility;
  createdBy: string;
  grants?: { userId: string }[];
}

export interface FilePermEntity {
  id: string;
  visibility: Visibility;
  uploadedBy: string;
  folderId: string | null;
  grants?: { userId: string }[];
}

// ───────────────────────── Predicates ─────────────────────────

/**
 * Whether a user is allowed to VIEW a folder.
 * - ADMIN → always true
 * - ALL → any classroom member (caller decides membership, default true)
 * - TEACHERS → classroomRole TEACHER, or userRole ADMIN/GURU
 * - PRIVATE → creator, ADMIN, or user has a FolderAccess grant
 *
 * NOTE: this function does NOT re-check classroom membership. The caller must
 * already have established that the user is a member of the classroom that owns
 * the folder (server routes do that via isClassroomMember before invoking these
 * predicates).
 */
export function canViewFolder(
  folder: FolderPermEntity,
  userId: string,
  userRole: UserRole,
  classroomRole: ClassroomRole | null
): boolean {
  if (userRole === "ADMIN") return true;
  switch (folder.visibility) {
    case "ALL":
      return true; // any classroom member
    case "TEACHERS":
      return classroomRole === "TEACHER" || userRole === "GURU";
    case "PRIVATE":
      if (folder.createdBy === userId) return true;
      if (Array.isArray(folder.grants) && folder.grants.some((g) => g.userId === userId))
        return true;
      return false;
    default:
      return true;
  }
}

/**
 * Whether a user is allowed to VIEW a file. If the file's visibility is ALL,
 * we still allow — visibility is taken from the file directly (not inherited
 * from the parent folder in this simple model, but the route layer may pass
 * an inherited value when the file has no explicit visibility record).
 */
export function canViewFile(
  file: FilePermEntity,
  userId: string,
  userRole: UserRole,
  classroomRole: ClassroomRole | null
): boolean {
  if (userRole === "ADMIN") return true;
  switch (file.visibility) {
    case "ALL":
      return true;
    case "TEACHERS":
      return classroomRole === "TEACHER" || userRole === "GURU";
    case "PRIVATE":
      if (file.uploadedBy === userId) return true;
      if (Array.isArray(file.grants) && file.grants.some((g) => g.userId === userId))
        return true;
      return false;
    default:
      return true;
  }
}

/**
 * Whether a user can edit (rename/move/delete) a folder.
 * - ADMIN / GURU → yes
 * - creator → yes
 * - classroom TEACHER → yes (so co-teachers can manage shared folders)
 * - otherwise → no
 */
export function canEditFolder(
  folder: FolderPermEntity,
  userId: string,
  userRole: UserRole,
  classroomRole: ClassroomRole | null
): boolean {
  if (userRole === "ADMIN") return true;
  if (userRole === "GURU") return true;
  if (folder.createdBy === userId) return true;
  if (classroomRole === "TEACHER") return true;
  return false;
}

/**
 * Whether a user can edit a file. Same rules as folders, but check uploader.
 */
export function canEditFile(
  file: FilePermEntity,
  userId: string,
  userRole: UserRole,
  classroomRole: ClassroomRole | null
): boolean {
  if (userRole === "ADMIN") return true;
  if (userRole === "GURU") return true;
  if (file.uploadedBy === userId) return true;
  if (classroomRole === "TEACHER") return true;
  return false;
}

/**
 * Whether the user may CHANGE the permissions (visibility + grants) of a folder.
 * Only the creator or ADMIN/GURU. (Classroom teachers cannot lock files they
 * didn't create — they can edit content but not permission policy.)
 */
export function canManagePermissions(
  entity: { createdBy: string },
  userId: string,
  userRole: UserRole
): boolean {
  if (userRole === "ADMIN") return true;
  if (userRole === "GURU") return true;
  return entity.createdBy === userId;
}

// ───────────────────────── List filters ─────────────────────────

export function filterVisibleFolders<T extends FolderPermEntity>(
  folders: T[],
  userId: string,
  userRole: UserRole,
  classroomRole: ClassroomRole | null
): T[] {
  return folders.filter((f) =>
    canViewFolder(f, userId, userRole, classroomRole)
  );
}

export function filterVisibleFiles<T extends FilePermEntity>(
  files: T[],
  userId: string,
  userRole: UserRole,
  classroomRole: ClassroomRole | null
): T[] {
  return files.filter((f) =>
    canViewFile(f, userId, userRole, classroomRole)
  );
}

// ───────────────────────── Validation helpers ─────────────────────────

/**
 * Validate that a `visibility` value from a request body is one of the enum
 * values. Returns the validated value or `null` if invalid.
 */
export function parseVisibility(v: unknown): Visibility | null {
  if (v === "ALL" || v === "TEACHERS" || v === "PRIVATE") return v;
  return null;
}

/**
 * Whether the requesting user may SET a particular visibility value.
 * - TEACHERS → only TEACHERS-classroom-role users + ADMIN/GURU
 * - PRIVATE → only creator + ADMIN/GURU
 * - ALL → anyone who can create folders/files
 */
export function canSetVisibility(
  visibility: Visibility,
  isCreator: boolean,
  userRole: UserRole,
  classroomRole: ClassroomRole | null
): boolean {
  if (visibility === "ALL") return true;
  if (visibility === "TEACHERS") {
    return userRole === "ADMIN" || userRole === "GURU" || classroomRole === "TEACHER";
  }
  if (visibility === "PRIVATE") {
    return userRole === "ADMIN" || userRole === "GURU" || isCreator;
  }
  return false;
}

// ───────────────────────── Cycle detection ─────────────────────────

/**
 * Walk up the folder tree from `targetId` to root, checking if `candidateId`
 * appears as an ancestor of `targetId`. Used to prevent moving a folder into
 * one of its own descendants (which would create a cycle).
 *
 * Also returns true when candidateId === targetId (moving into self).
 */
export async function isFolderAncestor(
  candidateId: string,
  targetId: string | null
): Promise<boolean> {
  if (!targetId) return false;
  if (candidateId === targetId) return true;
  let currentId: string | null = targetId;
  const visited = new Set<string>();
  let depth = 0;
  while (currentId && !visited.has(currentId) && depth < 24) {
    visited.add(currentId);
    if (currentId === candidateId) return true;
    const folder = await db.cloudFolder.findUnique({
      where: { id: currentId },
      select: { parentId: true },
    });
    if (!folder) return false;
    currentId = folder.parentId;
    depth += 1;
  }
  return false;
}

/**
 * Whether the user may DELETE a file.
 * Stricter than canEditFile: only ADMIN, GURU, or the uploader (owner).
 * Classroom teachers and students cannot delete files they don't own.
 */
export function canDeleteFile(
  file: { uploadedBy: string },
  userId: string,
  userRole: UserRole
): boolean {
  if (userRole === "ADMIN") return true;
  if (userRole === "GURU") return true;
  return file.uploadedBy === userId;
}

/**
 * Whether the user may DELETE a folder.
 * Stricter than canEditFolder: only ADMIN, GURU, or the creator (owner).
 */
export function canDeleteFolder(
  folder: { createdBy: string },
  userId: string,
  userRole: UserRole
): boolean {
  if (userRole === "ADMIN") return true;
  if (userRole === "GURU") return true;
  return folder.createdBy === userId;
}
