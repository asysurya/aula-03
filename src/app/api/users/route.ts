import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db } from "@/lib/db";

// List all users (directory). Authenticated users can read.
// Optional ?classroomId= filter to members of a classroom.
export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = (session.user as any).id as string;
  const url = new URL(req.url);
  const classroomId = url.searchParams.get("classroomId");

  if (classroomId) {
    const members = await db.classroomMember.findMany({
      where: { classroomId },
      include: {
        user: {
          select: {
            id: true,
            username: true,
            name: true,
            role: true,
            avatarColor: true,
            avatarUrl: true,
            bio: true,
            status: true,
            lastSeen: true,
          },
        },
      },
      orderBy: { user: { name: "asc" } },
    });
    return NextResponse.json({
      users: members.map((m) => ({ ...m.user, memberRole: m.role })),
    });
  }

  const users = await db.user.findMany({
    select: {
      id: true,
      username: true,
      name: true,
      role: true,
      avatarColor: true,
      avatarUrl: true,
      bio: true,
      status: true,
      lastSeen: true,
    },
    orderBy: { name: "asc" },
  });

  return NextResponse.json({
    users,
    currentUserId: userId,
  });
}
