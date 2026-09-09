import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db } from "@/lib/db";
import { randomBytes } from "crypto";

const MAX_GROUPS_CREATED = 2;

function generateInviteCode(): string {
  // 8 uppercase alphanumeric chars, collisions extremely unlikely
  return randomBytes(5).toString("hex").toUpperCase().slice(0, 8);
}

// POST /api/chat/groups  body: { name, description?, classroomId?, allowStudentInvite? }
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

  const name = typeof body.name === "string" ? body.name.trim() : "";
  const description =
    typeof body.description === "string" && body.description.trim()
      ? body.description.trim()
      : null;
  const classroomId =
    typeof body.classroomId === "string" && body.classroomId.trim()
      ? body.classroomId.trim()
      : null;
  const allowStudentInvite = body.allowStudentInvite === true;

  if (!name || name.length < 2 || name.length > 60) {
    return NextResponse.json(
      { error: "Nama grup harus 2–60 karakter" },
      { status: 400 }
    );
  }

  // Limit: max 2 groups created per STUDENT. Admin & Guru are unlimited.
  const isUnlimited = userRole === "ADMIN" || userRole === "GURU";
  if (!isUnlimited) {
    const createdCount = await db.group.count({ where: { createdBy: userId } });
    if (createdCount >= MAX_GROUPS_CREATED) {
      return NextResponse.json(
        {
          error: `Batas membuat grup tercapai (maks ${MAX_GROUPS_CREATED} per siswa). Guru & admin tanpa batas. Hapus grup lama atau gabung grup lain.`,
        },
        { status: 400 }
      );
    }
  }

  // If classroomId provided, ensure the user is a member of that classroom.
  if (classroomId) {
    const membership = await db.classroomMember.findUnique({
      where: { classroomId_userId: { classroomId, userId } },
    });
    if (!membership) {
      return NextResponse.json(
        { error: "Kamu bukan anggota kelas ini" },
        { status: 403 }
      );
    }
  }

  // Generate a unique invite code (retry on rare collision)
  let inviteCode = generateInviteCode();
  for (let attempt = 0; attempt < 5; attempt++) {
    const existing = await db.group.findUnique({
      where: { inviteCode },
      select: { id: true },
    });
    if (!existing) break;
    inviteCode = generateInviteCode();
  }

  const group = await db.group.create({
    data: {
      name,
      description,
      classroomId,
      createdBy: userId,
      isPrivate: true,
      inviteCode,
      allowStudentInvite,
      members: {
        create: { userId },
      },
    },
    select: {
      id: true,
      name: true,
      description: true,
      isPrivate: true,
      classroomId: true,
      inviteCode: true,
      allowStudentInvite: true,
      createdAt: true,
    },
  });

  return NextResponse.json({ group }, { status: 201 });
}
