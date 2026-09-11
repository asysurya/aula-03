import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/session";
import { db } from "@/lib/db";
import { chainSort, fetchMongoStats, serializeConnection } from "@/lib/db-connections";

// POST /api/admin/database-connections/sync-usage
// Refresh usage (dbStats) SEMUA koneksi MongoDB aktif sekaligus, paralel.
// Dipanggil tombol "Perbarui Usage" dan otomatis saat panel dibuka bila
// data usage sudah basi (> 10 menit) — supaya angka selalu segar.

export const runtime = "nodejs";
export const maxDuration = 60;

const STALE_MS = 10 * 60 * 1000;

export async function POST() {
  await requireAdmin();
  const rows = await db.databaseConnection.findMany({
    where: { type: "mongodb", active: true },
  });

  const results = await Promise.allSettled(
    rows.map(async (row) => {
      try {
        const stats = await fetchMongoStats(row.uri);
        await db.databaseConnection.update({
          where: { id: row.id },
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
        return { id: row.id, ok: true as const };
      } catch (e) {
        const message = e instanceof Error ? e.message.slice(0, 300) : "unknown";
        await db.databaseConnection
          .update({
            where: { id: row.id },
            data: {
              lastStatus: "error",
              lastError: message,
              lastCheckedAt: new Date(),
              latencyMs: null,
            },
          })
          .catch(() => {});
        return { id: row.id, ok: false as const };
      }
    })
  );

  const checked = results.length;
  const ok = results.filter(
    (r) => r.status === "fulfilled" && r.value.ok
  ).length;

  const all = await db.databaseConnection.findMany();
  const chain = chainSort(all);
  const connections = chain.map((r, i) => serializeConnection(r, i + 1));

  return NextResponse.json({ checked, ok, connections });
}

/** GET: cek apakah ada koneksi aktif dengan usage basi/belum ada. */
export async function GET() {
  await requireAdmin();
  const rows = await db.databaseConnection.findMany({
    where: { type: "mongodb", active: true },
    select: { usageCheckedAt: true },
  });
  const stale = rows.some(
    (r) => !r.usageCheckedAt || Date.now() - r.usageCheckedAt.getTime() > STALE_MS
  );
  return NextResponse.json({ stale, count: rows.length });
}
