import { NextResponse } from "next/server";
import { requireUser } from "@/lib/session";
import { db } from "@/lib/db";

// GET /api/ai/history — 50 pesan terakhir user (urut waktu naik).
export async function GET() {
  const user = await requireUser().catch(() => null);
  if (!user) return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });

  const rows = await db.aiMessage.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: "desc" },
    take: 50,
    select: { id: true, role: true, content: true, createdAt: true },
  });

  return NextResponse.json({
    messages: rows
      .reverse()
      .map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        createdAt: m.createdAt.toISOString(),
      })),
  });
}

// DELETE /api/ai/history — hapus SELURUH riwayat Teman AI milik user.
export async function DELETE() {
  const user = await requireUser().catch(() => null);
  if (!user) return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });

  const res = await db.aiMessage.deleteMany({ where: { userId: user.id } });
  return NextResponse.json({ ok: true, deleted: res.count });
}
