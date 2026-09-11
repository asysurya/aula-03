import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/session";
import { db } from "@/lib/db";
import {
  chainSort,
  serializeConnection,
  DEFAULT_QUOTA_BYTES,
} from "@/lib/db-connections";

const createSchema = z.object({
  name: z.string().min(1).max(120),
  type: z.string().min(1).max(40).default("mongodb"),
  uri: z.string().min(1).max(2000),
  isPrimary: z.boolean().optional(),
  quotaBytes: z.number().int().min(0).max(10 ** 15).optional(),
});

export async function GET() {
  await requireAdmin();
  const rows = await db.databaseConnection.findMany();
  const chain = chainSort(rows);
  const connections = chain.map((r, i) => serializeConnection(r, i + 1));
  const anyLive = connections.some((c) => c.isLive);
  return NextResponse.json(
    { connections, liveMatched: anyLive },
    { headers: { "Cache-Control": "no-store" } }
  );
}

export async function POST(req: NextRequest) {
  await requireAdmin();
  const body = await req.json();
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Data tidak valid", details: parsed.error.flatten() },
      { status: 400 }
    );
  }
  const { name, type, uri, isPrimary, quotaBytes } = parsed.data;
  if (isPrimary) {
    await db.databaseConnection.updateMany({
      where: { isPrimary: true },
      data: { isPrimary: false },
    });
  }
  // Priority baru = paling bawah rantai (max existing + 1).
  const existing = await db.databaseConnection.findMany({
    select: { priority: true },
  });
  const nextPriority =
    existing.reduce((m, r) => Math.max(m, r.priority ?? 0), 0) + 1;
  const row = await db.databaseConnection.create({
    data: {
      name,
      type,
      uri,
      isPrimary: !!isPrimary,
      priority: nextPriority,
      quotaBytes:
        quotaBytes != null ? BigInt(quotaBytes) : BigInt(DEFAULT_QUOTA_BYTES),
    },
  });
  return NextResponse.json(
    { connection: serializeConnection(row, nextPriority) },
    { status: 201 }
  );
}
