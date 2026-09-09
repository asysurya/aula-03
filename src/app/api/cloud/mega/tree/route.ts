import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import {
  megaList,
  megaAccountInfo,
  describeMegaError,
  type MegaAccountLike,
} from "@/lib/mega-storage";
import { formatBytes } from "@/lib/cloud-format";

// GET /api/cloud/mega/tree?accountId=<id>&nodeId=<id>
//
// Browse isi akun MEGA ("mount" MEGA Cloud di file browser).
//
// Hanya ADMIN & GURU — file di MEGA bisa berisi jawaban privat siswa
// (jawaban form upload, dsb.) yang tidak boleh dilihat siswa lain.
// Menampilkan struktur folder + file asli di akun MEGA.
//
// Saat gagal membuka (mis. akun EBLOCKED), status akun di DB di-update
// jujur supaya panel admin tidak menampilkan "Terhubung" basi.

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
        },
        select: selectAccount(),
      })
    : await db.cloudAccount.findFirst({
        where: {
          provider: "mega",
          active: true,
          email: { not: null },
          lastStatus: { not: "error" },
        },
        orderBy: { fileCount: "asc" },
        select: selectAccount(),
      });

  if (!account || !account.email) {
    return NextResponse.json(
      {
        error:
          "Belum ada akun MEGA aktif. Tambahkan/aktifkan lewat Admin Panel → Data & Cloud.",
      },
      { status: 404 }
    );
  }

  const accountLike: MegaAccountLike = {
    id: account.id,
    email: account.email,
    password: account.password,
    sessionData: account.sessionData,
  };

  const quota = await megaAccountInfo(accountLike).catch(() => null);

  try {
    const listing = await megaList(accountLike, nodeId);
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
  } catch (e) {
    const detail = describeMegaError(e);
    // Update status jujur — supaya panel admin & pemilihan akun
    // otomatis melewati akun yang bermasalah.
    try {
      await db.cloudAccount.update({
        where: { id: account.id },
        data: {
          lastStatus: "error",
          lastError: detail,
          lastCheckedAt: new Date(),
        },
      });
    } catch {
      /* best-effort */
    }
    return NextResponse.json(
      {
        error: `Gagal membuka MEGA: ${detail}`,
        hint: "Bisa ganti akun MEGA baru atau tambahkan provider S3 (R2/B2) lewat Admin Panel → Data & Cloud.",
      },
      { status: 502 }
    );
  }
}

function selectAccount() {
  return {
    id: true,
    email: true,
    password: true,
    sessionData: true,
    name: true,
    lastStatus: true,
    fileCount: true,
    active: true,
  };
}
