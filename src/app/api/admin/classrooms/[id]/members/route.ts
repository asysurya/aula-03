import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/session";
import { db } from "@/lib/db";

// List members of a classroom
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  await requireAdmin();
  const { id } = await params;
  const members = await db.classroomMember.findMany({
    where: { classroomId: id },
    include: {
      user: {
        select: {
          id: true,
          name: true,
          username: true,
          role: true,
          avatarColor: true,
          avatarUrl: true,
        },
      },
    },
    orderBy: { user: { name: "asc" } },
  });
  // Candidate users not yet members (for the add dialog)
  const memberUserIds = members.map((m) => m.userId);
  const candidates = await db.user.findMany({
    where: { id: { notIn: memberUserIds } },
    select: {
      id: true,
      name: true,
      username: true,
      role: true,
      avatarColor: true,
    },
    orderBy: { name: "asc" },
  });
  return NextResponse.json({ members, candidates });
}

const addSchema = z.object({
  userId: z.string(),
  role: z.enum(["TEACHER", "STUDENT"]).default("STUDENT"),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  await requireAdmin();
  const { id } = await params;
  const body = await req.json();
  const parsed = addSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Data tidak valid" }, { status: 400 });
  }
  const member = await db.classroomMember.upsert({
    where: { classroomId_userId: { classroomId: id, userId: parsed.data.userId } },
    update: { role: parsed.data.role },
    create: { classroomId: id, userId: parsed.data.userId, role: parsed.data.role },
    include: { user: { select: { id: true, name: true, username: true, role: true } } },
  });
  return NextResponse.json({ member }, { status: 201 });
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  await requireAdmin();
  const { id } = await params;
  const url = new URL(req.url);
  const userId = url.searchParams.get("userId");
  if (!userId) return NextResponse.json({ error: "userId required" }, { status: 400 });
  await db.classroomMember.delete({
    where: { classroomId_userId: { classroomId: id, userId } },
  });
  return NextResponse.json({ ok: true });
}
