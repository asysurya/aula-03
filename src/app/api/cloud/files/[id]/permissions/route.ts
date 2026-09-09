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
  canManagePermissions,
  canSetVisibility,
  parseVisibility,
  type ClassroomRole,
  type UserRole,
} from "@/lib/cloud-perms";

// GET /api/cloud/files/[id]/permissions
export async function GET(
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
      visibility: true,
      uploadedBy: true,
      grants: {
        select: {
          user: {
            select: {
              id: true,
              name: true,
              username: true,
              avatarColor: true,
            },
          },
        },
      },
    },
  });
  if (!file) return errorResponse("FILE_NOT_FOUND", 404);

  if (!canManagePermissions({ createdBy: file.uploadedBy }, user.id, user.role as UserRole)) {
    return errorResponse("FORBIDDEN", 403);
  }

  return Response.json({
    id: file.id,
    kind: "file" as const,
    visibility: file.visibility,
    uploadedBy: file.uploadedBy,
    canManage: true,
    grantedUsers: file.grants.map((g) => g.user),
  });
}

// PATCH /api/cloud/files/[id]/permissions
// Body: { visibility: "ALL"|"TEACHERS"|"PRIVATE", grantedUserIds?: string[] }
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await requireUser().catch(() => null);
  if (!user) return errorResponse("UNAUTHORIZED", 401);

  const { id } = await params;
  const file = await db.cloudFile.findUnique({
    where: { id },
    select: {
      id: true,
      visibility: true,
      uploadedBy: true,
      folderId: true,
    },
  });
  if (!file) return errorResponse("FILE_NOT_FOUND", 404);

  if (!canManagePermissions({ createdBy: file.uploadedBy }, user.id, user.role as UserRole)) {
    return errorResponse("FORBIDDEN", 403);
  }

  let body: { visibility?: string; grantedUserIds?: string[] };
  try {
    body = await req.json();
  } catch {
    return errorResponse("INVALID_JSON", 400);
  }

  const visibility = parseVisibility(body.visibility);
  if (!visibility) return errorResponse("INVALID_VISIBILITY", 400);

  // Resolve classroom role for visibility permission check.
  if (!file.folderId) return errorResponse("FILE_NO_FOLDER", 400);
  const classroomId = await folderClassroomId(file.folderId);
  if (!classroomId) return errorResponse("FOLDER_NO_CLASSROOM", 400);

  const userRole = user.role as UserRole;
  const classroomRole: ClassroomRole | null =
    userRole === "ADMIN"
      ? "TEACHER"
      : await getClassroomRole(classroomId, user.id);

  if (
    !canSetVisibility(
      visibility,
      file.uploadedBy === user.id,
      userRole,
      classroomRole
    )
  ) {
    return errorResponse("VISIBILITY_NOT_ALLOWED", 403);
  }

  const grantedUserIds = Array.isArray(body.grantedUserIds)
    ? body.grantedUserIds.filter((x) => typeof x === "string")
    : [];

  if (visibility === "PRIVATE" && grantedUserIds.length > 0) {
    const valid = (
      await db.classroomMember.findMany({
        where: { classroomId, userId: { in: grantedUserIds } },
        select: { userId: true },
      })
    ).map((m) => m.userId);
    const invalid = grantedUserIds.filter((uid) => !valid.includes(uid));
    if (invalid.length > 0) {
      return errorResponse("GRANT_NOT_MEMBER", 400, { invalid });
    }
  }

  await db.$transaction(async (tx) => {
    await tx.cloudFile.update({
      where: { id },
      data: { visibility },
    });
    await tx.fileAccess.deleteMany({ where: { fileId: id } });
    if (visibility === "PRIVATE" && grantedUserIds.length > 0) {
      await tx.fileAccess.createMany({
        data: grantedUserIds.map((userId) => ({ fileId: id, userId })),
      });
    }
  });

  const updated = await db.cloudFile.findUnique({
    where: { id },
    select: {
      id: true,
      visibility: true,
      uploadedBy: true,
      grants: {
        select: {
          user: {
            select: {
              id: true,
              name: true,
              username: true,
              avatarColor: true,
            },
          },
        },
      },
    },
  });

  // Suppress unused import warning.
  void isClassroomMember;

  return Response.json({
    id: updated!.id,
    kind: "file" as const,
    visibility: updated!.visibility,
    uploadedBy: updated!.uploadedBy,
    canManage: true,
    grantedUsers: updated!.grants.map((g) => g.user),
  });
}
