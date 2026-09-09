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
  canEditFile,
  type ClassroomRole,
  type UserRole,
} from "@/lib/cloud-perms";

// POST /api/cloud/files/move
// Body: { fileIds: string[], targetFolderId: string|null }
// Validates:
//  - User can edit each source file (uploader/admin/guru/teacher).
//  - User can view (and write to) the target folder (member of its classroom).
// Updates `folderId` on each file.
export async function POST(req: NextRequest) {
  const user = await requireUser().catch(() => null);
  if (!user) return errorResponse("UNAUTHORIZED", 401);

  let body: { fileIds?: string[]; targetFolderId?: string | null };
  try {
    body = await req.json();
  } catch {
    return errorResponse("INVALID_JSON", 400);
  }

  const fileIds = Array.isArray(body.fileIds)
    ? body.fileIds.filter((x): x is string => typeof x === "string" && !!x)
    : [];
  if (fileIds.length === 0) return errorResponse("FILE_IDS_REQUIRED", 400);

  // Cap batch size.
  if (fileIds.length > 100) return errorResponse("TOO_MANY", 400);

  const targetFolderId =
    body.targetFolderId === null || body.targetFolderId === undefined
      ? null
      : String(body.targetFolderId);

  // Resolve target classroom + check membership.
  let targetClassroomId: string | null = null;
  if (targetFolderId) {
    const targetFolder = await db.cloudFolder.findUnique({
      where: { id: targetFolderId },
      select: { id: true, visibility: true, createdBy: true, classroomId: true },
    });
    if (!targetFolder) return errorResponse("TARGET_NOT_FOUND", 404);
    targetClassroomId = await folderClassroomId(targetFolderId);
    if (!targetClassroomId) return errorResponse("TARGET_NO_CLASSROOM", 400);
  }

  if (targetClassroomId) {
    if (
      user.role !== "ADMIN" &&
      !(await isClassroomMember(targetClassroomId, user.id))
    ) {
      return errorResponse("FORBIDDEN_TARGET", 403);
    }
  }

  // Fetch all source files.
  const files = await db.cloudFile.findMany({
    where: { id: { in: fileIds } },
    select: {
      id: true,
      uploadedBy: true,
      folderId: true,
      storageKey: true,
    },
  });

  if (files.length === 0) return errorResponse("FILES_NOT_FOUND", 404);
  if (files.length !== fileIds.length) {
    // Some files don't exist — partial failure: abort for atomicity.
    return errorResponse("SOME_FILES_NOT_FOUND", 404);
  }

  const userRole = user.role as UserRole;

  // Verify edit permission for each file. Resolve each file's classroom role.
  // (Files may live in different folders/classrooms, so per-file check.)
  for (const file of files) {
    let classroomRole: ClassroomRole | null = null;
    if (file.folderId) {
      const cid = await folderClassroomId(file.folderId);
      if (cid) {
        classroomRole =
          userRole === "ADMIN"
            ? "TEACHER"
            : await getClassroomRole(cid, user.id);
      }
    } else if (targetClassroomId) {
      // File at root of source classroom — use target classroom role as proxy
      // (the move keeps it in the same classroom when target is root-level).
      classroomRole =
        userRole === "ADMIN"
          ? "TEACHER"
          : await getClassroomRole(targetClassroomId, user.id);
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
        userRole,
        classroomRole
      )
    ) {
      return errorResponse("FORBIDDEN_FILE", 403, { fileId: file.id });
    }
  }

  // All checks passed — move.
  await db.cloudFile.updateMany({
    where: { id: { in: fileIds } },
    data: { folderId: targetFolderId },
  });

  return Response.json({
    ok: true,
    movedCount: fileIds.length,
    targetFolderId,
  });
}
