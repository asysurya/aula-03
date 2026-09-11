import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/session";
import { db } from "@/lib/db";
import {
  chainSort,
  fetchMongoStats,
  serializeConnection,
} from "@/lib/db-connections";

// POST /api/admin/database-connections/[id]/test
// Uji koneksi + ambil dbStats (usage penyimpanan) sekali jalan.
// Hasil (latensi, status, usage) disimpan ke baris koneksi.

export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  await requireAdmin();
  const { id } = await params;
  const row = await db.databaseConnection.findUnique({ where: { id } });
  if (!row) {
    return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
  }

  if (row.type !== "mongodb") {
    return NextResponse.json({
      status: "unsupported",
      error: `Tipe "${row.type}" belum didukung pengujian.`,
    });
  }

  try {
    const stats = await fetchMongoStats(row.uri);
    const updated = await db.databaseConnection.update({
      where: { id },
      data: {
        lastStatus: "connected",
        lastError: null,
        lastCheckedAt: new Date(),
        latencyMs: stats.latencyMs,
        dataSize: BigInt(Math.round(stats.dataSize)),
        storageSize: BigInt(Math.round(stats.storageSize)),
        indexSize: BigInt(Math.round(stats.indexSize)),
        objects: Math.round(stats.objects),
        usageCheckedAt: new Date(),
      },
    });
    const rows = await db.databaseConnection.findMany();
    const idx = chainSort(rows).findIndex((r) => r.id === id);
    return NextResponse.json({
      status: "connected",
      latencyMs: stats.latencyMs,
      connection: serializeConnection(updated, idx + 1),
    });
  } catch (e) {
    const message = e instanceof Error ? e.message.slice(0, 300) : "unknown";
    const updated = await db.databaseConnection.update({
      where: { id },
      data: {
        lastStatus: "error",
        lastError: message,
        lastCheckedAt: new Date(),
        latencyMs: null,
      },
    });
    const rows = await db.databaseConnection.findMany();
    const idx = chainSort(rows).findIndex((r) => r.id === id);
    return NextResponse.json(
      {
        status: "error",
        error: message,
        connection: serializeConnection(updated, idx + 1),
      },
      { status: 200 }
    );
  }
}
