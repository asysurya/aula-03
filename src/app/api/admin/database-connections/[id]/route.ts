import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/session";
import { db } from "@/lib/db";

function maskUri(uri: string): string {
  if (!uri) return "";
  try {
    const tail = uri.slice(-8);
    const schemeMatch = uri.match(/^([a-z+]+:\/\/)/i);
    const scheme = schemeMatch ? schemeMatch[1] : "";
    return `${scheme}…${tail}`;
  } catch {
    return "••••";
  }
}

const patchSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  uri: z.string().min(1).max(2000).optional(),
  isPrimary: z.boolean().optional(),
  active: z.boolean().optional(),
});

// GET single connection (uri masked).
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  await requireAdmin();
  const { id } = await params;
  const row = await db.databaseConnection.findUnique({ where: { id } });
  if (!row) {
    return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
  }
  return NextResponse.json({
    connection: {
      id: row.id,
      name: row.name,
      type: row.type,
      uriMasked: maskUri(row.uri),
      isPrimary: row.isPrimary,
      active: row.active,
      lastStatus: row.lastStatus,
      lastCheckedAt: row.lastCheckedAt,
      lastError: row.lastError,
      latencyMs: row.latencyMs,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    },
  });
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
  // If marking as primary, demote others first.
  if (parsed.data.isPrimary) {
    await db.databaseConnection.updateMany({
      where: { isPrimary: true, NOT: { id } },
      data: { isPrimary: false },
    });
  }
  const updated = await db.databaseConnection.update({
    where: { id },
    data: parsed.data,
  });
  return NextResponse.json({
    connection: {
      id: updated.id,
      name: updated.name,
      type: updated.type,
      uriMasked: maskUri(updated.uri),
      isPrimary: updated.isPrimary,
      active: updated.active,
      lastStatus: updated.lastStatus,
      lastCheckedAt: updated.lastCheckedAt,
      lastError: updated.lastError,
      latencyMs: updated.latencyMs,
      createdAt: updated.createdAt,
      updatedAt: updated.updatedAt,
    },
  });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  await requireAdmin();
  const { id } = await params;
  await db.databaseConnection.delete({ where: { id } }).catch(() => {});
  return NextResponse.json({ ok: true });
}
