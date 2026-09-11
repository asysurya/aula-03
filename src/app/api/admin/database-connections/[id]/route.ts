import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/session";
import { db } from "@/lib/db";
import {
  chainNormalizePriorities,
  chainSort,
  serializeConnection,
} from "@/lib/db-connections";

const patchSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  uri: z.string().min(1).max(2000).optional(),
  isPrimary: z.boolean().optional(),
  active: z.boolean().optional(),
  quotaBytes: z.number().int().min(0).max(10 ** 15).nullable().optional(),
  // Aksi rantai prioritas: naik / turun satu posisi.
  move: z.enum(["up", "down"]).optional(),
});

// GET single connection (uri masked).
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  await requireAdmin();
  const { id } = await params;
  const rows = await db.databaseConnection.findMany();
  const row = rows.find((r) => r.id === id);
  if (!row) {
    return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
  }
  const idx = chainSort(rows).findIndex((r) => r.id === id);
  return NextResponse.json({ connection: serializeConnection(row, idx + 1) });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  await requireAdmin();
  const { id } = await params;
  const body = await req.json();
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Data tidak valid", details: parsed.error.flatten() },
      { status: 400 }
    );
  }
  const existing = await db.databaseConnection.findUnique({ where: { id } });
  if (!existing) {
    return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
  }

  // ── Aksi pindah posisi dalam rantai prioritas ──
  if (parsed.data.move) {
    const all = await db.databaseConnection.findMany();
    const chain = chainSort(all);
    const idx = chain.findIndex((r) => r.id === id);
    if (idx >= 0) {
      const to = parsed.data.move === "up" ? idx - 1 : idx + 1;
      if (to >= 0 && to < chain.length) {
        [chain[idx], chain[to]] = [chain[to], chain[idx]];
      }
      const ops = chainNormalizePriorities(chain);
      await Promise.all(
        ops
          .filter((o) => {
            const row = chain.find((r) => r.id === o.id);
            return row?.priority !== o.priority;
          })
          .map((o) =>
            db.databaseConnection.update({
              where: { id: o.id },
              data: { priority: o.priority },
            })
          )
      );
    }
    const rows = await db.databaseConnection.findMany();
    const sorted = chainSort(rows);
    const me = sorted.findIndex((r) => r.id === id);
    return NextResponse.json({
      connection: me >= 0 ? serializeConnection(sorted[me], me + 1) : null,
    });
  }

  // If marking as primary, demote others first.
  if (parsed.data.isPrimary) {
    await db.databaseConnection.updateMany({
      where: { isPrimary: true, NOT: { id } },
      data: { isPrimary: false },
    });
  }

  const { move: _move, ...data } = parsed.data;
  const updated = await db.databaseConnection.update({
    where: { id },
    data: {
      ...data,
      quotaBytes:
        data.quotaBytes != null
          ? BigInt(data.quotaBytes)
          : data.quotaBytes === null
            ? null
            : undefined,
    },
  });
  const rows = await db.databaseConnection.findMany();
  const idx = chainSort(rows).findIndex((r) => r.id === id);
  return NextResponse.json({
    connection: serializeConnection(updated, idx + 1),
  });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  await requireAdmin();
  const { id } = await params;
  await db.databaseConnection.delete({ where: { id } }).catch(() => {});
  // Rapikan urutan priority setelah hapus.
  const all = await db.databaseConnection.findMany();
  const ops = chainNormalizePriorities(all);
  await Promise.all(
    ops
      .filter((o) => {
        const row = all.find((r) => r.id === o.id);
        return row?.priority !== o.priority;
      })
      .map((o) =>
        db.databaseConnection.update({
          where: { id: o.id },
          data: { priority: o.priority },
        })
      )
  );
  return NextResponse.json({ ok: true });
}
