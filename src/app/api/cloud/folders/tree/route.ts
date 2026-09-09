import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import {
  errorResponse,
  getClassroomRole,
  isClassroomMember,
} from "@/lib/cloud-utils";
import {
  canViewFolder,
  type ClassroomRole,
  type UserRole,
} from "@/lib/cloud-perms";
import type { FolderTreeNode } from "@/lib/cloud-format";

// GET /api/cloud/folders/tree?classroomId=<id>
// Returns a tree of all folders the user can see in the given classroom.
// Used by the move/copy folder picker dialog.
export async function GET(req: NextRequest) {
  const user = await requireUser().catch(() => null);
  if (!user) return errorResponse("UNAUTHORIZED", 401);

  const url = new URL(req.url);
  const classroomId = url.searchParams.get("classroomId");
  if (!classroomId) return errorResponse("CLASSROOM_REQUIRED", 400);

  if (user.role !== "ADMIN" && !(await isClassroomMember(classroomId, user.id))) {
    return errorResponse("FORBIDDEN", 403);
  }

  const userRole = user.role as UserRole;
  const classroomRole: ClassroomRole | null =
    userRole === "ADMIN" ? "TEACHER" : await getClassroomRole(classroomId, user.id);

  // Fetch all folders owned by this classroom directly.
  const all = await db.cloudFolder.findMany({
    where: { classroomId },
    select: {
      id: true,
      name: true,
      type: true,
      parentId: true,
      classroomId: true,
      visibility: true,
      createdBy: true,
      grants: { select: { userId: true } },
    },
    orderBy: [{ name: "asc" }],
  });

  // Filter by visibility (students shouldn't see hidden folders in the picker).
  const visible = all.filter((f) =>
    canViewFolder(
      {
        id: f.id,
        visibility: f.visibility,
        createdBy: f.createdBy,
        grants: f.grants,
      },
      user.id,
      userRole,
      classroomRole
    )
  );

  // Build a tree by parentId.
  const byParent = new Map<string | null, typeof visible>();
  for (const f of visible) {
    const key = f.parentId ?? null;
    const arr = byParent.get(key) ?? [];
    arr.push(f);
    byParent.set(key, arr);
  }

  function build(parentId: string | null): FolderTreeNode[] {
    const children = byParent.get(parentId) ?? [];
    return children.map((f) => ({
      id: f.id,
      name: f.name,
      type: f.type,
      children: build(f.id),
    }));
  }

  return Response.json({ tree: build(null) });
}
