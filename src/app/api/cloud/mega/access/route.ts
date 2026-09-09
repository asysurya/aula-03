import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import {
  canViewMount,
  canWriteMount,
  normalizeMountMode,
  normalizeVisibleTo,
} from "@/lib/mount-access";

// GET /api/cloud/mega/access
//
// Cek ringan: apakah user saat ini boleh melihat kartu "MEGA Cloud" mount
// di halaman Cloud, dan apakah mount-nya baca-saja. Dipakai file-browser
// supaya kartu mount hanya tampil bagi user yang diizinkan (pengaturan
// per-akun di Admin Panel), tanpa perlu membuka tree dulu.

export async function GET() {
  const user = await requireUser().catch(() => null);
  if (!user) {
    return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
  }
  const role = (user as { role?: string }).role;

  const account = await db.cloudAccount.findFirst({
    where: {
      provider: "mega",
      active: true,
      email: { not: null },
      lastStatus: { not: "error" },
    },
    orderBy: { fileCount: "asc" },
    select: {
      id: true,
      name: true,
      mountVisibleTo: true,
      mountMode: true,
    },
  });

  if (!account) {
    return NextResponse.json({ visible: false, reason: "NO_ACCOUNT" });
  }

  const visible = canViewMount(account, role);
  return NextResponse.json({
    visible,
    accountId: account.id,
    accountName: account.name,
    mountVisibleTo: normalizeVisibleTo(account.mountVisibleTo),
    mountMode: visible ? normalizeMountMode(account.mountMode) : null,
    canWrite: canWriteMount(account, role),
    reason: visible ? null : "FORBIDDEN",
  });
}
