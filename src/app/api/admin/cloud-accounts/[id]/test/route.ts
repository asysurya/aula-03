import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/session";
import { db } from "@/lib/db";
import { testMegaAccount } from "@/lib/mega-storage";
import { testS3Account } from "@/lib/s3-storage";

// POST /api/admin/cloud-accounts/[id]/test
//
// Tes koneksi akun cloud (MEGA atau S3) dan PERBARUI status di DB secara
// jujur — baik sukses (connected + kuota) maupun gagal (error + lastError +
// lastCheckedAt). Tombol "Tes Akun" di panel admin memanggil route ini.
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  await requireAdmin();
  const { id } = await params;

  const account = await db.cloudAccount.findUnique({ where: { id } });
  if (!account) {
    return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
  }

  let ok = false;
  let error: string | null = null;
  let spaceTotal: number | null = null;
  let spaceUsed: number | null = null;

  if (account.provider === "s3") {
    const result = await testS3Account({
      id: account.id,
      endpoint: account.endpoint,
      region: account.region,
      bucket: account.bucket,
      accessKeyId: account.accessKeyId,
      secretAccessKey: account.secretAccessKey,
    });
    ok = result.ok;
    error = result.error ?? null;
  } else {
    // provider "mega" (default)
    if (!account.email || !account.password) {
      return NextResponse.json(
        { error: "Email/password MEGA belum diisi lengkap" },
        { status: 400 }
      );
    }
    const result = await testMegaAccount(account.email, account.password);
    ok = result.ok;
    error = result.error ?? null;
    spaceTotal = result.spaceTotal ?? null;
    spaceUsed = result.spaceUsed ?? null;
  }

  // Update status jujur — termasuk kegagalan, supaya panel tidak
  // menampilkan "Terhubung" basi.
  const updated = await db.cloudAccount.update({
    where: { id },
    data: {
      lastStatus: ok ? "connected" : "error",
      lastError: ok ? null : error,
      lastCheckedAt: new Date(),
      spaceTotal: ok ? spaceTotal : null,
      spaceUsed: ok ? spaceUsed : null,
    },
  });

  return NextResponse.json({
    ok,
    status: updated.lastStatus,
    error: updated.lastError,
    spaceTotal: updated.spaceTotal,
    spaceUsed: updated.spaceUsed,
    checkedAt: updated.lastCheckedAt,
  });
}
