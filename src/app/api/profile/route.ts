import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { requireUser } from "@/lib/session";
import { db } from "@/lib/db";

// PATCH /api/profile — SEMUA user (admin/guru/siswa) boleh mengatur profil
// sendiri: nama, bio, warna avatar, foto avatar (URL), dan ganti password.
// USERNAME TIDAK BISA DIUBAH (dipakai sebagai identitas login permanen).

const AVATAR_COLOR_KEYS = [
  "emerald",
  "amber",
  "rose",
  "violet",
  "cyan",
  "orange",
  "pink",
  "teal",
  "fuchsia",
  "lime",
] as const;

const patchSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Nama tidak boleh kosong")
    .max(60, "Nama maksimal 60 karakter")
    .optional(),
  bio: z.string().max(240, "Bio maksimal 240 karakter").nullable().optional(),
  avatarColor: z.enum(AVATAR_COLOR_KEYS).optional(),
  avatarUrl: z
    .string()
    .max(500)
    .refine(
      (v) =>
        v === "" ||
        /^https?:\/\/.+/i.test(v) ||
        v.startsWith("/api/storage/"),
      "avatarUrl harus URL http(s) atau path /api/storage/..."
    )
    .optional(),
  currentPassword: z.string().optional(),
  newPassword: z.string().optional(),
});

export async function PATCH(req: NextRequest) {
  const user = await requireUser().catch(() => null);
  if (!user) {
    return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "INVALID_JSON" }, { status: 400 });
  }
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    const first = parsed.error.issues[0]?.message ?? "Data tidak valid";
    return NextResponse.json({ error: first }, { status: 400 });
  }
  const d = parsed.data;

  const data: Record<string, unknown> = {};

  if (d.name !== undefined) data.name = d.name;
  if (d.bio !== undefined) data.bio = d.bio ?? null;
  if (d.avatarColor !== undefined) data.avatarColor = d.avatarColor;
  if (d.avatarUrl !== undefined) {
    data.avatarUrl = d.avatarUrl.length > 0 ? d.avatarUrl : null;
  }

  // ── Ganti password (opsional) ──
  if (d.currentPassword !== undefined || d.newPassword !== undefined) {
    if (!d.currentPassword || !d.newPassword) {
      return NextResponse.json(
        { error: "Password lama dan baru wajib diisi bersamaan" },
        { status: 400 }
      );
    }
    if (d.newPassword.length < 4) {
      return NextResponse.json(
        { error: "Password baru minimal 4 karakter" },
        { status: 400 }
      );
    }
    const row = await db.user.findUnique({
      where: { id: user.id },
      select: { password: true },
    });
    if (!row) {
      return NextResponse.json({ error: "USER_NOT_FOUND" }, { status: 404 });
    }
    const ok = await bcrypt.compare(d.currentPassword, row.password);
    if (!ok) {
      return NextResponse.json(
        { error: "Password saat ini salah" },
        { status: 403 }
      );
    }
    data.password = await bcrypt.hash(d.newPassword, 10);
  }

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: "Tidak ada perubahan" }, { status: 400 });
  }

  const updated = await db.user.update({
    where: { id: user.id },
    data,
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

  return NextResponse.json({ ok: true, user: updated });
}
