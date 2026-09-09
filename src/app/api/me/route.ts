import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db } from "@/lib/db";
import { getOnlineUserIds } from "@/lib/presence";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ user: null }, { status: 200 });
  }
  const u = (session.user as any) as {
    id: string;
    name: string;
    username: string;
    role: "ADMIN" | "STUDENT";
  };

  const user = await db.user.findUnique({
    where: { id: u.id },
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
  });

  if (!user) return NextResponse.json({ user: null });

  const classrooms = await db.classroomMember.findMany({
    where: { userId: user.id },
    include: {
      classroom: {
        select: {
          id: true,
          name: true,
          description: true,
        },
      },
    },
    orderBy: { classroom: { name: "asc" } },
  });

  const groups = await db.groupMember.findMany({
    where: {
      userId: user.id,
    },
    include: {
      group: {
        select: {
          id: true,
          name: true,
          description: true,
          isPrivate: true,
          classroomId: true,
        },
      },
    },
    orderBy: { group: { name: "asc" } },
  });

  const onlineIds = await getOnlineUserIds();

  return NextResponse.json({
    user,
    classrooms: classrooms.map((c) => ({
      ...c.classroom,
      memberRole: c.role,
    })),
    groups: groups.map((g) => g.group),
    onlineUserIds: Array.from(onlineIds),
  });
}
