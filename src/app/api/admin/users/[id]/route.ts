import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { requireAdmin } from "@/lib/session";
import { db } from "@/lib/db";

const patchSchema = z.object({
  name: z.string().min(1).max(60).optional(),
  role: z.enum(["ADMIN", "GURU", "STUDENT"]).optional(),
  avatarColor: z.string().optional(),
  bio: z.string().max(240).optional(),
  resetPassword: z.string().min(4).max(100).optional(),
});

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const admin = await requireAdmin();
  const { id } = await params;
  const body = await req.json();
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Data tidak valid", details: parsed.error.flatten() },
      { status: 400 }
    );
  }
  const data: any = {};
  if (parsed.data.name) data.name = parsed.data.name;
  if (parsed.data.role) data.role = parsed.data.role;
  if (parsed.data.avatarColor) data.avatarColor = parsed.data.avatarColor;
  if (parsed.data.bio !== undefined) data.bio = parsed.data.bio;
  if (parsed.data.resetPassword) {
    data.password = await bcrypt.hash(parsed.data.resetPassword, 10);
  }
  const user = await db.user.update({
    where: { id },
    data,
    select: {
      id: true,
      username: true,
      name: true,
      role: true,
      avatarColor: true,
      bio: true,
    },
  });
  // Prevent self-demotion to a non-admin (lock out protection)
  if (id === admin.id && parsed.data.role === "STUDENT") {
    return NextResponse.json(
      { error: "Tidak bisa menurunkan role diri sendiri dari admin" },
      { status: 400 }
    );
  }
  return NextResponse.json({ user });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const admin = await requireAdmin();
  const { id } = await params;
  if (id === admin.id) {
    return NextResponse.json(
      { error: "Tidak bisa menghapus akun sendiri" },
      { status: 400 }
    );
  }
  await db.user.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
