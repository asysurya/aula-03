import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { errorResponse, isClassroomMember } from "@/lib/cloud-utils";

// GET /api/cloud/classrooms/[id]/members
// Returns the list of classroom members (id, name, username, avatarColor, role).
// Any classroom member may call this. Used by the permission multi-select
// picker in the file browser.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await requireUser().catch(() => null);
  if (!user) return errorResponse("UNAUTHORIZED", 401);

  const { id } = await params;

  const classroom = await db.classroom.findUnique({
    where: { id },
    select: { id: true },
  });
  if (!classroom) return errorResponse("CLASSROOM_NOT_FOUND", 404);

  if (user.role !== "ADMIN" && !(await isClassroomMember(id, user.id))) {
    return errorResponse("FORBIDDEN", 403);
  }

  const members = await db.classroomMember.findMany({
    where: { classroomId: id },
    orderBy: [{ role: "asc" }, { user: { name: "asc" } }],
    select: {
      role: true,
      user: {
        select: {
          id: true,
          name: true,
          username: true,
          avatarColor: true,
        },
      },
    },
  });

  return Response.json({
    members: members.map((m) => ({
      id: m.user.id,
      name: m.user.name,
      username: m.user.username,
      avatarColor: m.user.avatarColor,
      role: m.role,
    })),
  });
}
