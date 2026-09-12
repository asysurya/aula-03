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
// Daftar akun cloud (mount MEGA) yang boleh DIBUKA user saat ini — dipakai
// untuk kartu mount di halaman Cloud + tombol "Ganti Akun" (switcher) di
// dalam mount explorer / attachment picker.
//
// Izin diperiksa di server per-akun: PER PERAN (mountVisibleTo) dan PER
// ORANG (mountUserIds / mountUserWriteIds — diatur admin di Admin Panel).
// Admin melihat semua akun aktif (termasuk yang statusnya "error" supaya
// bisa dikelola); user lain hanya akun sehat yang diizinkan.
//
// Bentuk respons (kompatibel dengan pemakai lama — field akun PERTAMA
// tetap ada di level atas; `accounts` = daftar lengkap untuk switcher).

export async function GET() {
  const user = await requireUser().catch(() => null);
  if (!user) {
    return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
  }
  const role = (user as { role?: string }).role;
  const userId = (user as { id?: string }).id ?? null;

  const rows = await db.cloudAccount.findMany({
    where: {
      provider: "mega",
      active: true,
      email: { not: null },
    },
    orderBy: { fileCount: "asc" },
    select: {
      id: true,
      name: true,
      email: true,
      lastStatus: true,
      mountVisibleTo: true,
      mountMode: true,
      mountUserIds: true,
      mountUserWriteIds: true,
    },
  });

  const isAdmin = role === "ADMIN";
  const accessible = rows.filter(
    (a) =>
      // Admin boleh melihat akun bermasalah juga (untuk diagnosis);
      // user lain hanya akun sehat + lolos cek izin (peran/per-orang).
      isAdmin ||
      (a.lastStatus !== "error" && canViewMount(a, role, userId))
  );

  if (accessible.length === 0) {
    return NextResponse.json({
      visible: false,
      reason: rows.length === 0 ? "NO_ACCOUNT" : "FORBIDDEN",
      accounts: [],
    });
  }

  const accounts = accessible.map((a) => ({
    id: a.id,
    name: a.name,
    email: a.email,
    status: a.lastStatus,
    canWrite: canWriteMount(a, role, userId),
  }));

  const first = accessible[0];
  const firstVisible = canViewMount(first, role, userId);
  return NextResponse.json({
    visible: true,
    reason: null,
    // ── Semua akun yang boleh dibuka (untuk tombol switch akun) ──
    accounts,
    // ── Field lama: akun pertama (default) ──
    accountId: first.id,
    accountName: first.name,
    mountVisibleTo: normalizeVisibleTo(first.mountVisibleTo),
    mountMode: firstVisible ? normalizeMountMode(first.mountMode) : null,
    canWrite: firstVisible ? canWriteMount(first, role, userId) : false,
  });
}
