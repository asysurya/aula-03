import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { megaList, megaAccountInfo } from "@/lib/mega-storage";
import { formatBytes } from "@/lib/cloud-format";

// GET /api/cloud/mega/tree?accountId=<id>&nodeId=<id>
//
// Browse isi akun MEGA ("mount" MEGA Cloud di file browser).
//
// Hanya ADMIN & GURU — file di MEGA bisa berisi jawaban privat siswa
// (jawaban form upload, dsb.) yang tidak boleh dilihat siswa lain.
// Read-only: menampilkan struktur folder + file asli di akun MEGA.
//
// Response:
// {
//   account: { id, email, label, status, fileCount, spaceUsed, spaceTotal,
//              spaceUsedLabel, spaceTotalLabel },
//   nodeId, path: [{id, name}], entries: [{nodeId, name, isFolder, size, timestamp}]
// }

export async function GET(req: NextRequest) {
  const user = await requireUser().catch(() => null);
  if (!user) {
    return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
  }
  const role = (user as { role?: string }).role;
  if (role !== "ADMIN" && role !== "GURU") {
    return NextResponse.json(
      { error: "FORBIDDEN — hanya guru/admin yang dapat membuka MEGA Cloud" },
      { status: 403 }
    );
  }

  const url = new URL(req.url);
  const accountIdParam = url.searchParams.get("accountId");
  const nodeId = url.searchParams.get("nodeId");

  // Pilih akun: eksplisit via param, atau akun aktif pertama.
  const account = accountIdParam
    ? await db.cloudAccount.findFirst({
        where: {
          id: accountIdParam,
          provider: "mega",
          email: { not: null },
          password: { not: null },
        },
        select: {
          id: true,
          email: true,
          password: true,
          name: true,
          lastStatus: true,
          fileCount: true,
          active: true,
        },
      })
    : await db.cloudAccount.findFirst({
        where: {
          provider: "mega",
          active: true,
          email: { not: null },
          password: { not: null },
          lastStatus: { not: "error" },
        },
        orderBy: { fileCount: "asc" },
        select: {
          id: true,
          email: true,
          password: true,
          name: true,
          lastStatus: true,
          fileCount: true,
          active: true,
        },
      });

  if (!account || !account.email || !account.password) {
    return NextResponse.json(
      { error: "Belum ada akun MEGA aktif. Tambahkan lewat Admin Panel → Data & Cloud." },
      { status: 404 }
    );
  }

  const accountLike = {
    id: account.id,
    email: account.email,
    password: account.password,
  };

  const [listing, quota] = await Promise.all([
    megaList(accountLike, nodeId),
    megaAccountInfo(accountLike),
  ]);

  if (!listing) {
    return NextResponse.json(
      {
        error:
          "Gagal membuka MEGA (akun ter-block/koneksi gagal). Coba lagi sebentar lagi.",
      },
      { status: 502 }
    );
  }

  return NextResponse.json({
    ok: true,
    account: {
      id: account.id,
      email: account.email,
      name: account.name,
      status: account.lastStatus,
      fileCount: account.fileCount ?? 0,
      spaceUsed: quota?.spaceUsed ?? null,
      spaceTotal: quota?.spaceTotal ?? null,
      spaceUsedLabel: quota ? formatBytes(quota.spaceUsed) : null,
      spaceTotalLabel: quota ? formatBytes(quota.spaceTotal) : null,
    },
    nodeId: listing.nodeId,
    path: listing.path,
    entries: listing.entries,
  });
}
