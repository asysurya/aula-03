import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/session";
import { db } from "@/lib/db";

// ─────────────────────────────────────────────────────────────────────
// GET    /api/builder/projects/:id — detail proyek (lengkap dengan html).
// PATCH  /api/builder/projects/:id — ubah judul/deskripsi/html.
// DELETE /api/builder/projects/:id — hapus proyek.
// Proyek privat per user — id milik orang lain diperlakukan 404.
// ─────────────────────────────────────────────────────────────────────

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: Params) {
  const user = await requireUser().catch(() => null);
  if (!user) return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
  const { id } = await params;

  const row = await db.builderProject.findUnique({ where: { id } });
  if (!row || row.userId !== user.id) {
    return NextResponse.json({ error: "Proyek tidak ditemukan" }, { status: 404 });
  }

  return NextResponse.json({
    project: {
      id: row.id,
      title: row.title,
      description: row.description,
      html: row.html,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    },
  });
}

const patchSchema = z.object({
  title: z.string().trim().min(1, "Judul tidak boleh kosong").max(120).optional(),
  description: z.string().trim().max(400).optional().nullable(),
  html: z.string().min(1, "Kode kosong").max(200_000).optional(),
});

export async function PATCH(req: NextRequest, { params }: Params) {
  const user = await requireUser().catch(() => null);
  if (!user) return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
  const { id } = await params;

  const existing = await db.builderProject.findUnique({ where: { id } });
  if (!existing || existing.userId !== user.id) {
    return NextResponse.json({ error: "Proyek tidak ditemukan" }, { status: 404 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Data tidak valid" }, { status: 400 });
  }
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    const first = parsed.error.issues[0]?.message ?? "Data tidak valid";
    return NextResponse.json({ error: first }, { status: 400 });
  }
  const d = parsed.data;

  const updated = await db.builderProject.update({
    where: { id },
    data: {
      ...(d.title !== undefined ? { title: d.title } : {}),
      ...(d.description !== undefined ? { description: d.description ?? null } : {}),
      ...(d.html !== undefined ? { html: d.html } : {}),
    },
  });
  return NextResponse.json({ ok: true, id: updated.id, updatedAt: updated.updatedAt.toISOString() });
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const user = await requireUser().catch(() => null);
  if (!user) return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
  const { id } = await params;

  const existing = await db.builderProject.findUnique({ where: { id } });
  if (!existing || existing.userId !== user.id) {
    return NextResponse.json({ error: "Proyek tidak ditemukan" }, { status: 404 });
  }

  await db.builderProject.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
