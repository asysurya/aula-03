import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db } from "@/lib/db";

// GET /api/chat/groups/[id]/info
// Returns id, name, inviteCode, description, classroomId, members list,
// allowStudentInvite, createdBy, and computed canShareInvite.
// Only members of the group may read.
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = (session.user as any).id as string;
  const userRole = (session.user as any).role as "ADMIN" | "GURU" | "STUDENT";
  const { id } = await params;

  const membership = await db.groupMember.findUnique({
    where: { groupId_userId: { groupId: id, userId } },
    select: { id: true },
  });
  if (!membership) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const group = await db.group.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      description: true,
      isPrivate: true,
      classroomId: true,
      inviteCode: true,
      allowStudentInvite: true,
      createdBy: true,
      createdAt: true,
      members: {
        orderBy: { joinedAt: "asc" },
        select: {
          id: true,
          joinedAt: true,
          user: {
            select: {
              id: true,
              name: true,
              username: true,
              avatarUrl: true,
              avatarColor: true,
              role: true,
            },
          },
        },
      },
    },
  });

  if (!group) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Who can share the invite code?
  // - The group creator (always)
  // - Any ADMIN or GURU user (always)
  // - Student members, ONLY IF group.allowStudentInvite is true
  const isCreator = group.createdBy === userId;
  const canShareInvite =
    isCreator || userRole === "ADMIN" || userRole === "GURU" || group.allowStudentInvite;

  return NextResponse.json({
    group: {
      id: group.id,
      name: group.name,
      description: group.description,
      isPrivate: group.isPrivate,
      classroomId: group.classroomId,
      inviteCode: group.inviteCode,
      allowStudentInvite: group.allowStudentInvite,
      createdBy: group.createdBy,
      canShareInvite,
      createdAt: group.createdAt.toISOString(),
      members: group.members.map((m) => ({
        id: m.id,
        joinedAt: m.joinedAt.toISOString(),
        user: m.user,
      })),
    },
  });
}
