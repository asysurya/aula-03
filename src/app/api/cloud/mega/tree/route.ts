import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import {
  canViewMount,
  normalizeMountMode,
  normalizeVisibleTo,
} from "@/lib/mount-access";
import {
  megaList,
  megaAccountInfo,
  describeMegaError,
  isAccountLevelMegaError,
  type MegaAccountLike,
} from "@/lib/mega-storage";
import { formatBytes } from "@/lib/cloud-format";

// GET /api/cloud/mega/tree?accountId=<id>&nodeId=<id>
//
// Browse isi akun MEGA ("mount" MEGA Cloud di file browser).
//
// Hak akses diatur per-akun lewat Admin Panel (mountVisibleTo):
// admin saja / guru+admin / semua user. Pemilik akun (admin) selalu boleh.
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

  // ── Hak akses mount (diatur per-akun di Admin Panel) ──
  if (!canViewMount(account, role)) {
    return NextResponse.json(
      {
        error:
          "FORBIDDEN — kamu tidak punya izin membuka mount akun cloud ini. Minta admin mengatur hak aksesnya.",
      },
      { status: 403 }
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
        // Hak akses efektif untuk user ini (mount read-only? dsb.)
        mountMode: normalizeMountMode(account.mountMode),
        mountVisibleTo: normalizeVisibleTo(account.mountVisibleTo),
        canWrite:
          normalizeMountMode(account.mountMode) === "WRITE",
      },
      nodeId: listing.nodeId,
      path: listing.path,
      entries: listing.entries,
    });
  } catch (e) {
    const detail = describeMegaError(e);
    // Update status jujur — tapi HANYA untuk error level-akun (diblokir /
    // kredensial). Error sesi (ESID dsb.) tidak menandai akun error
    // supaya akun tetap dipakai setelah relogin otomatis.
    try {
      await db.cloudAccount.update({
        where: { id: account.id },
        data: {
          lastStatus: isAccountLevelMegaError(e) ? "error" : account.lastStatus,
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
    mountVisibleTo: true,
    mountMode: true,
  };
}
