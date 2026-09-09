import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { getSession } from "@/lib/session";
import { db } from "@/lib/db";

const patchSchema = z
  .object({
    name: z.string().min(1).max(60).optional(),
    bio: z.string().max(240).optional(),
    avatarColor: z.string().optional(),
    currentPassword: z.string().optional(),
    newPassword: z.string().min(4).max(100).optional(),
  })
  .refine(
    (d) => (d.newPassword ? !!d.currentPassword : true),
    { message: "currentPassword wajib untuk ganti password", path: ["currentPassword"] }
  );

export async function PATCH(req: NextRequest) {
  const session = await getSession();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const body = await req.json();
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Data tidak valid", details: parsed.error.flatten() },
      { status: 400 }
    );
  }
  const { name, bio, avatarColor, currentPassword, newPassword } = parsed.data;
  const data: any = {};
  if (name) data.name = name;
  if (bio !== undefined) data.bio = bio;
  if (avatarColor) data.avatarColor = avatarColor;

  if (newPassword) {
    const user = await db.user.findUnique({ where: { id: session.user.id } });
    if (!user) return NextResponse.json({ error: "User tidak ditemukan" }, { status: 404 });
    const ok = await bcrypt.compare(currentPassword || "", user.password);
    if (!ok) {
      return NextResponse.json({ error: "Password saat ini salah" }, { status: 400 });
    }
    data.password = await bcrypt.hash(newPassword, 10);
  }

  const updated = await db.user.update({
    where: { id: session.user.id },
    data,
    select: {
      id: true,
      name: true,
      bio: true,
      avatarColor: true,
      username: true,
      role: true,
    },
  });
  return NextResponse.json({ user: updated });
}
