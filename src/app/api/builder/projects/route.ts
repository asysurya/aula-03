import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/session";
import { db } from "@/lib/db";

// ─────────────────────────────────────────────────────────────────────
// GET  /api/builder/projects — daftar proyek AI Builder milik user
//                        (ringkas: tanpa isi html — hanya meta + ukuran).
// POST /api/builder/projects — simpan (buat baru / update bila ada id).
// Semua proyek privat per user — tidak bisa membaca proyek orang lain.
// ─────────────────────────────────────────────────────────────────────

export async function GET() {
  const user = await requireUser().catch(() => null);
  if (!user) return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });

  const rows = await db.builderProject.findMany({
    where: { userId: user.id },
    orderBy: { updatedAt: "desc" },
    select: {
      id: true,
      title: true,
      description: true,
      createdAt: true,
      updatedAt: true,
      html: true, // ukuran dihitung server; html dikirim di detail saja
    },
    take: 100,
  });

  return NextResponse.json({
    projects: rows.map((r) => ({
      id: r.id,
      title: r.title,
      description: r.description,
      htmlLength: r.html.length,
      updatedAt: r.updatedAt.toISOString(),
    })),
  });
}

const saveSchema = z.object({
  id: z.string().trim().min(1).max(60).optional(),
  title: z.string().trim().min(1, "Judul tidak boleh kosong").max(120),
  description: z.string().trim().max(400).optional().nullable(),
  html: z.string().min(1, "Kode kosong — tidak ada yang bisa disimpan").max(200_000),
});

export async function POST(req: NextRequest) {
  const user = await requireUser().catch(() => null);
  if (!user) return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Data tidak valid" }, { status: 400 });
  }
  const parsed = saveSchema.safeParse(body);
  if (!parsed.success) {
    const first = parsed.error.issues[0]?.message ?? "Data tidak valid";
    return NextResponse.json({ error: first }, { status: 400 });
  }
  const d = parsed.data;

  // Update proyek milik sendiri (id orang lain → 404, tidak bocor ada/tidak).
  if (d.id) {
    const existing = await db.builderProject.findUnique({ where: { id: d.id } });
    if (!existing || existing.userId !== user.id) {
      return NextResponse.json({ error: "Proyek tidak ditemukan" }, { status: 404 });
    }
    const updated = await db.builderProject.update({
      where: { id: d.id },
      data: {
        title: d.title,
        description: d.description ?? null,
        html: d.html,
      },
    });
    return NextResponse.json({ ok: true, id: updated.id, updatedAt: updated.updatedAt.toISOString() });
  }

  // Kuota per user (anti penyalahgunaan tempat penyimpanan).
  const count = await db.builderProject.count({ where: { userId: user.id } });
  if (count >= 50) {
    return NextResponse.json(
      { error: "Batas 50 proyek tercapai — hapus proyek lama dulu." },
      { status: 400 }
    );
  }

  const created = await db.builderProject.create({
    data: {
      userId: user.id,
      title: d.title,
      description: d.description ?? null,
      html: d.html,
    },
  });
  return NextResponse.json({ ok: true, id: created.id, updatedAt: created.updatedAt.toISOString() });
}
