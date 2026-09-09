import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/session";
import { db } from "@/lib/db";

const createSchema = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(240).optional(),
});

export async function GET() {
  await requireAdmin();
  const classrooms = await db.classroom.findMany({
    include: {
      _count: { select: { members: true, folders: true, groups: true } },
      members: {
        select: {
          userId: true,
          role: true,
          user: {
            select: { id: true, name: true, username: true, role: true, avatarColor: true },
          },
        },
        orderBy: { user: { name: "asc" } },
      },
    },
    orderBy: { name: "asc" },
  });
  return NextResponse.json({ classrooms });
}

export async function POST(req: NextRequest) {
  await requireAdmin();
  const body = await req.json();
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Data tidak valid", details: parsed.error.flatten() },
      { status: 400 }
    );
  }
  const admin = await requireAdmin();
  const classroom = await db.classroom.create({
    data: {
      name: parsed.data.name,
      description: parsed.data.description,
      members: { create: { userId: admin.id, role: "TEACHER" } },
    },
  });
  return NextResponse.json({ classroom }, { status: 201 });
}
