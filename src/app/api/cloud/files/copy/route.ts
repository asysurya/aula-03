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

// POST /api/cloud/files/copy
// Body: { fileIds: string[], targetFolderId: string|null }
// Creates a duplicate CloudFile row pointing to the SAME storageKey (no blob
// duplication — reference counting). The copy is named "Copy of <original>".
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
  if (fileIds.length > 50) return errorResponse("TOO_MANY", 400);

  const targetFolderId =
    body.targetFolderId === null || body.targetFolderId === undefined
      ? null
      : String(body.targetFolderId);

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
      user.role !== "ADMIN" &&
      !(await isClassroomMember(targetClassroomId, user.id))
    ) {
      return errorResponse("FORBIDDEN_TARGET", 403);
    }
  }

  // Fetch source files.
  const files = await db.cloudFile.findMany({
    where: { id: { in: fileIds } },
    select: {
      id: true,
      name: true,
      uploadedBy: true,
      folderId: true,
      storageKey: true,
      size: true,
      mimetype: true,
      cloudAccountId: true,
    },
  });

  if (files.length === 0) return errorResponse("FILES_NOT_FOUND", 404);
  if (files.length !== fileIds.length) {
    return errorResponse("SOME_FILES_NOT_FOUND", 404);
  }

  const userRole = user.role as UserRole;

  // Verify the user can VIEW each source file (so they're not copying files
  // they shouldn't see). Use canEditFile since copying = read+create.
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

  // Create copies — same storageKey (reference-counted).
  const created = await db.$transaction(
    files.map((file) =>
      db.cloudFile.create({
        data: {
          name: `Copy of ${file.name}`.slice(0, 200),
          folderId: targetFolderId,
          uploadedBy: user.id,
          storageKey: file.storageKey,
          size: file.size,
          mimetype: file.mimetype,
          cloudAccountId: file.cloudAccountId,
          visibility: "ALL",
        },
        select: { id: true },
      })
    )
  );

  return Response.json({
    ok: true,
    copiedCount: created.length,
    targetFolderId,
    copiedFileIds: created.map((c) => c.id),
  });
}
