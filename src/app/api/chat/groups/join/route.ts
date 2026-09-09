import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db } from "@/lib/db";

const MAX_GROUPS_JOINED = 20;

// POST /api/chat/groups/join  body: { inviteCode }
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = (session.user as any).id as string;
  const userRole = (session.user as any).role as "ADMIN" | "GURU" | "STUDENT";

  const body = await req.json().catch(() => null);
  if (!body) {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  const rawCode = typeof body.inviteCode === "string" ? body.inviteCode.trim() : "";
  if (!rawCode) {
    return NextResponse.json(
      { error: "Kode invite wajib diisi" },
      { status: 400 }
    );
  }
  const inviteCode = rawCode.toUpperCase();

  const group = await db.group.findUnique({
    where: { inviteCode },
    select: {
      id: true,
      name: true,
      description: true,
      isPrivate: true,
      classroomId: true,
    },
  });

  if (!group) {
    return NextResponse.json(
      { error: "Kode invite tidak ditemukan" },
      { status: 404 }
    );
  }

  const existing = await db.groupMember.findUnique({
    where: { groupId_userId: { groupId: group.id, userId } },
    select: { id: true },
  });

  if (existing) {
    return NextResponse.json({
      group,
      alreadyMember: true,
    });
  }

  // Limit: max 20 groups joined per STUDENT. Admin & Guru are unlimited.
  const isUnlimited = userRole === "ADMIN" || userRole === "GURU";
  if (!isUnlimited) {
    const joinedCount = await db.groupMember.count({ where: { userId } });
    if (joinedCount >= MAX_GROUPS_JOINED) {
      return NextResponse.json(
        {
          error: `Batas bergabung grup tercapai (maks ${MAX_GROUPS_JOINED} per siswa). Guru & admin tanpa batas. Keluar dari grup lain dulu.`,
        },
        { status: 400 }
      );
    }
  }

  await db.groupMember.create({
    data: { groupId: group.id, userId },
  });

  return NextResponse.json({ group, alreadyMember: false });
}
