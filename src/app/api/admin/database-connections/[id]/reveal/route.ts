import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/session";
import { db } from "@/lib/db";

// POST /api/admin/database-connections/[id]/reveal
// Kembalikan URI lengkap (untuk tombol "Salin URI" saat migrasi).
// Hanya admin; body POST eksplisit agar tidak tersimpan di cache mana pun.

export const dynamic = "force-dynamic";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  await requireAdmin();
  const { id } = await params;
  const row = await db.databaseConnection.findUnique({
    where: { id },
    select: { uri: true },
  });
  if (!row) {
    return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
  }
  return NextResponse.json({ uri: row.uri });
}
