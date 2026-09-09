import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { requireAdmin } from "@/lib/session";
import { db } from "@/lib/db";

const createSchema = z.object({
  username: z.string().min(3).max(24).regex(/^[a-z0-9._-]+$/),
  name: z.string().min(1).max(60),
  password: z.string().min(4).max(100),
  role: z.enum(["ADMIN", "GURU", "STUDENT"]).default("STUDENT"),
  avatarColor: z.string().optional(),
});

export async function GET() {
  await requireAdmin();
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
      createdAt: true,
      _count: { select: { classroomMemberships: true, groupMemberships: true } },
    },
    orderBy: [{ role: "desc" }, { name: "asc" }],
  });
  return NextResponse.json({ users });
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
  const { username, name, password, role, avatarColor } = parsed.data;
  const exists = await db.user.findUnique({ where: { username } });
  if (exists) {
    return NextResponse.json({ error: "Username sudah dipakai" }, { status: 409 });
  }
  const hashed = await bcrypt.hash(password, 10);
  const user = await db.user.create({
    data: {
      username,
      name,
      password: hashed,
      role,
      avatarColor: avatarColor || "emerald",
    },
    select: {
      id: true,
      username: true,
      name: true,
      role: true,
      avatarColor: true,
      createdAt: true,
    },
  });
  return NextResponse.json({ user }, { status: 201 });
}
