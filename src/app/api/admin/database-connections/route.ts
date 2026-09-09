import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/session";
import { db } from "@/lib/db";

// Mask a connection URI for safe display. Shows the scheme + last 8 chars of
// the user/host segment (we never return the password).
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

const createSchema = z.object({
  name: z.string().min(1).max(120),
  type: z.string().min(1).max(40).default("mongodb"),
  uri: z.string().min(1).max(2000),
  isPrimary: z.boolean().optional(),
});

export async function GET() {
  await requireAdmin();
  const rows = await db.databaseConnection.findMany({
    orderBy: [{ isPrimary: "desc" }, { createdAt: "desc" }],
  });
  const masked = rows.map((r) => ({
    id: r.id,
    name: r.name,
    type: r.type,
    uriMasked: maskUri(r.uri),
    isPrimary: r.isPrimary,
    active: r.active,
    lastStatus: r.lastStatus,
    lastCheckedAt: r.lastCheckedAt,
    lastError: r.lastError,
    latencyMs: r.latencyMs,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }));
  return NextResponse.json({ connections: masked });
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
  const { name, type, uri, isPrimary } = parsed.data;
  if (isPrimary) {
    await db.databaseConnection.updateMany({
      where: { isPrimary: true },
      data: { isPrimary: false },
    });
  }
  const row = await db.databaseConnection.create({
    data: { name, type, uri, isPrimary: !!isPrimary },
  });
  return NextResponse.json(
    {
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
    },
    { status: 201 }
  );
}
