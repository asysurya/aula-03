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

// GET /api/cloud/folders/[id]/permissions
// Returns the folder's current visibility + granted users list. Only the creator
// or ADMIN/GURU may view this.
export async function GET(
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
  if (!folder) return errorResponse("FOLDER_NOT_FOUND", 404);

  if (!canManagePermissions(folder, user.id, user.role as UserRole)) {
    return errorResponse("FORBIDDEN", 403);
  }

  return Response.json({
    id: folder.id,
    kind: "folder" as const,
    visibility: folder.visibility,
    createdBy: folder.createdBy,
    canManage: true,
    grantedUsers: folder.grants.map((g) => g.user),
  });
}

// PATCH /api/cloud/folders/[id]/permissions
// Body: { visibility: "ALL"|"TEACHERS"|"PRIVATE", grantedUserIds?: string[] }
// Replaces existing grants with the new list (when PRIVATE).
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await requireUser().catch(() => null);
  if (!user) return errorResponse("UNAUTHORIZED", 401);

  const { id } = await params;
  const folder = await db.cloudFolder.findUnique({
    where: { id },
    select: { id: true, visibility: true, createdBy: true, classroomId: true },
  });
  if (!folder) return errorResponse("FOLDER_NOT_FOUND", 404);

  if (!canManagePermissions(folder, user.id, user.role as UserRole)) {
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
  const classroomId = folder.classroomId
    ? folder.classroomId
    : await folderClassroomId(id);
  if (!classroomId) return errorResponse("FOLDER_NO_CLASSROOM", 400);

  const userRole = user.role as UserRole;
  const classroomRole: ClassroomRole | null =
    userRole === "ADMIN"
      ? "TEACHER"
      : await getClassroomRole(classroomId, user.id);

  if (
    !canSetVisibility(
      visibility,
      folder.createdBy === user.id,
      userRole,
      classroomRole
    )
  ) {
    return errorResponse("VISIBILITY_NOT_ALLOWED", 403);
  }

  // Validate grantedUserIds: they must be members of the same classroom.
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
    await tx.cloudFolder.update({
      where: { id },
      data: { visibility },
    });
    // Replace grants: delete existing, add new.
    await tx.folderAccess.deleteMany({ where: { folderId: id } });
    if (visibility === "PRIVATE" && grantedUserIds.length > 0) {
      await tx.folderAccess.createMany({
        data: grantedUserIds.map((userId) => ({ folderId: id, userId })),
      });
    }
  });

  const updated = await db.cloudFolder.findUnique({
    where: { id },
    select: {
      id: true,
      visibility: true,
      createdBy: true,
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

  // isClassroomMember import only used for type inference in some flows; suppress.
  void isClassroomMember;

  return Response.json({
    id: updated!.id,
    kind: "folder" as const,
    visibility: updated!.visibility,
    createdBy: updated!.createdBy,
    canManage: true,
    grantedUsers: updated!.grants.map((g) => g.user),
  });
}
