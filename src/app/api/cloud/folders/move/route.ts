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
  canEditFolder,
  isFolderAncestor,
  type ClassroomRole,
  type UserRole,
} from "@/lib/cloud-perms";

// POST /api/cloud/folders/move
// Body: { folderIds: string[], targetFolderId: string|null }
// Validates:
//  - User can edit each source folder (creator/admin/guru/teacher).
//  - User is a member of the target folder's classroom.
//  - Target is not the source folder itself or any of its descendants (cycle).
export async function POST(req: NextRequest) {
  const user = await requireUser().catch(() => null);
  if (!user) return errorResponse("UNAUTHORIZED", 401);

  let body: { folderIds?: string[]; targetFolderId?: string | null };
  try {
    body = await req.json();
  } catch {
    return errorResponse("INVALID_JSON", 400);
  }

  const folderIds = Array.isArray(body.folderIds)
    ? body.folderIds.filter((x): x is string => typeof x === "string" && !!x)
    : [];
  if (folderIds.length === 0) return errorResponse("FOLDER_IDS_REQUIRED", 400);
  if (folderIds.length > 50) return errorResponse("TOO_MANY", 400);

  const targetFolderId =
    body.targetFolderId === null || body.targetFolderId === undefined
      ? null
      : String(body.targetFolderId);

  const userRole = user.role as UserRole;

  // Resolve target classroom + check membership.
  let targetClassroomId: string | null = null;
  if (targetFolderId) {
    const targetFolder = await db.cloudFolder.findUnique({
      where: { id: targetFolderId },
      select: { id: true, classroomId: true },
    });
    if (!targetFolder) return errorResponse("TARGET_NOT_FOUND", 404);
    targetClassroomId = await folderClassroomId(targetFolderId);
    if (!targetClassroomId) return errorResponse("TARGET_NO_CLASSROOM", 400);
    if (
      userRole !== "ADMIN" &&
      !(await isClassroomMember(targetClassroomId, user.id))
    ) {
      return errorResponse("FORBIDDEN_TARGET", 403);
    }
  }

  // Fetch source folders.
  const folders = await db.cloudFolder.findMany({
    where: { id: { in: folderIds } },
    select: {
      id: true,
      visibility: true,
      createdBy: true,
      classroomId: true,
    },
  });

  if (folders.length === 0) return errorResponse("FOLDERS_NOT_FOUND", 404);
  if (folders.length !== folderIds.length) {
    return errorResponse("SOME_FOLDERS_NOT_FOUND", 404);
  }

  // Verify edit permission + cycle for each folder.
  for (const folder of folders) {
    // Edit permission.
    let classroomRole: ClassroomRole | null = null;
    let cid = folder.classroomId;
    if (!cid) cid = await folderClassroomId(folder.id);
    if (cid) {
      classroomRole =
        userRole === "ADMIN" ? "TEACHER" : await getClassroomRole(cid, user.id);
    }
    if (
      !canEditFolder(
        {
          id: folder.id,
          visibility: folder.visibility,
          createdBy: folder.createdBy,
        },
        user.id,
        userRole,
        classroomRole
      )
    ) {
      return errorResponse("FORBIDDEN_FOLDER", 403, { folderId: folder.id });
    }

    // Cycle check: target must not be the folder itself or any of its descendants.
    if (targetFolderId) {
      if (folder.id === targetFolderId) {
        return errorResponse("CANNOT_MOVE_INTO_SELF", 400, { folderId: folder.id });
      }
      const isAncestor = await isFolderAncestor(folder.id, targetFolderId);
      if (isAncestor) {
        return errorResponse("CYCLE_DETECTED", 400, { folderId: folder.id });
      }
    }

    // Cross-classroom move: not allowed (folders must stay within their classroom).
    if (cid && targetClassroomId && cid !== targetClassroomId) {
      return errorResponse("CROSS_CLASSROOM_MOVE_NOT_ALLOWED", 400, {
        folderId: folder.id,
      });
    }
  }

  // If moving to root (targetFolderId=null), we still need a classroomId to
  // assign to the folder's `classroomId` (so it remains a member of the same
  // classroom). We keep each folder's existing classroomId when moving to root.
  // (Cross-classroom move was already rejected above.)

  await db.cloudFolder.updateMany({
    where: { id: { in: folderIds } },
    data: { parentId: targetFolderId },
  });

  return Response.json({
    ok: true,
    movedCount: folderIds.length,
    targetFolderId,
  });
}
