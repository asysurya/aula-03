import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/session";
import { db } from "@/lib/db";

const patchSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  email: z.string().email().max(200).optional().or(z.literal("")),
  password: z.string().max(500).optional(),
  key: z.string().max(500).optional(),
  active: z.boolean().optional(),
});

function serialize(r: {
  id: string;
  name: string;
  provider: string;
  email: string | null;
  password: string | null;
  key: string | null;
  active: boolean;
  lastStatus: string;
  lastCheckedAt: Date | null;
  lastError: string | null;
  spaceTotal: number | null;
  spaceUsed: number | null;
  fileCount: number;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: r.id,
    name: r.name,
    provider: r.provider,
    email: r.email,
    hasPassword: !!r.password,
    hasKey: !!r.key,
    active: r.active,
    lastStatus: r.lastStatus,
    lastCheckedAt: r.lastCheckedAt,
    lastError: r.lastError,
    spaceTotal: r.spaceTotal,
    spaceUsed: r.spaceUsed,
    fileCount: r.fileCount,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  await requireAdmin();
  const { id } = await params;
  const row = await db.cloudAccount.findUnique({ where: { id } });
  if (!row) {
    return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
  }
  return NextResponse.json({ account: serialize(row) });
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
  const existing = await db.cloudAccount.findUnique({ where: { id } });
  if (!existing) {
    return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
  }
  const data: Record<string, unknown> = {};
  if (parsed.data.name !== undefined) data.name = parsed.data.name;
  if (parsed.data.email !== undefined) {
    data.email = parsed.data.email.length > 0 ? parsed.data.email : null;
  }
  // Only update password if a non-empty string was supplied.
  if (parsed.data.password !== undefined && parsed.data.password.length > 0) {
    data.password = parsed.data.password;
  }
  if (parsed.data.key !== undefined) {
    data.key = parsed.data.key.length > 0 ? parsed.data.key : null;
  }
  if (parsed.data.active !== undefined) data.active = parsed.data.active;

  const updated = await db.cloudAccount.update({ where: { id }, data });
  return NextResponse.json({ account: serialize(updated) });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  await requireAdmin();
  const { id } = await params;
  const row = await db.cloudAccount.findUnique({ where: { id } });
  if (!row) {
    return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
  }
  // Block delete when there are files stored on this account — they would
  // become orphaned (their storageKey would no longer resolve to a MEGA
  // account, so downloads would 404).
  if (row.fileCount > 0) {
    return NextResponse.json(
      {
        error: "Pindahkan/hapus file dulu",
        fileCount: row.fileCount,
      },
      { status: 409 }
    );
  }
  await db.cloudAccount.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
