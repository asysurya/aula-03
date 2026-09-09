import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/session";
import { db } from "@/lib/db";
import { serializeCloudAccount } from "@/lib/cloud-account-serialize";

const patchSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  email: z.string().email().max(200).optional().or(z.literal("")),
  password: z.string().max(500).optional(),
  key: z.string().max(500).optional(),
  active: z.boolean().optional(),
  // ── Hak akses mount (file explorer akun cloud) ──
  mountVisibleTo: z.enum(["ADMIN", "GURU", "ALL"]).optional(),
  mountMode: z.enum(["READ", "WRITE"]).optional(),
  // ── S3-compatible ──
  endpoint: z.string().max(300).optional().or(z.literal("")),
  region: z.string().max(60).optional().or(z.literal("")),
  bucket: z.string().max(120).optional().or(z.literal("")),
  accessKeyId: z.string().max(200).optional().or(z.literal("")),
  secretAccessKey: z.string().max(200).optional().or(z.literal("")),
});

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
  return NextResponse.json({ account: serializeCloudAccount(row) });
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
  const d = parsed.data;
  const data: Record<string, unknown> = {};
  if (d.name !== undefined) data.name = d.name;
  if (d.email !== undefined) {
    data.email = d.email.length > 0 ? d.email : null;
  }
  // Only update password if a non-empty string was supplied.
  if (d.password !== undefined && d.password.length > 0) {
    data.password = d.password;
    // Password berubah → session MEGA lama tetap valid (sid tidak tergantung
    // password), tapi reset supaya bersih bila akunnya berbeda.
    data.sessionData = null;
  }
  if (d.key !== undefined) {
    data.key = d.key.length > 0 ? d.key : null;
  }
  if (d.active !== undefined) data.active = d.active;

  // Hak akses mount — perubahan TIDAK me-reset session/status (bukan
  // perubahan kredensial).
  if (d.mountVisibleTo !== undefined) data.mountVisibleTo = d.mountVisibleTo;
  if (d.mountMode !== undefined) data.mountMode = d.mountMode;

  // S3 fields — string kosong berarti "hapus nilai".
  if (d.endpoint !== undefined) {
    data.endpoint = d.endpoint.length > 0 ? d.endpoint : null;
  }
  if (d.region !== undefined) {
    data.region = d.region.length > 0 ? d.region : null;
  }
  if (d.bucket !== undefined) {
    data.bucket = d.bucket.length > 0 ? d.bucket : null;
  }
  if (d.accessKeyId !== undefined) {
    data.accessKeyId = d.accessKeyId.length > 0 ? d.accessKeyId : null;
  }
  if (d.secretAccessKey !== undefined && d.secretAccessKey.length > 0) {
    // Only update secret when non-empty (mirrors password behaviour).
    data.secretAccessKey = d.secretAccessKey;
  }

  // Perubahan kredensial → status kembali "unknown" supaya admin
  // terdorong menekan "Tes Akun" lagi.
  const credChanged =
    d.password !== undefined ||
    d.email !== undefined ||
    d.endpoint !== undefined ||
    d.bucket !== undefined ||
    d.accessKeyId !== undefined ||
    d.secretAccessKey !== undefined;
  if (credChanged) {
    data.lastStatus = "unknown";
    data.lastError = null;
    data.sessionData = null;
  }

  const updated = await db.cloudAccount.update({ where: { id }, data });
  return NextResponse.json({ account: serializeCloudAccount(updated) });
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
  // become orphaned (their storageKey would no longer resolve to a cloud
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
