// ─────────────────────────────────────────────────────────────────────────
// Hak akses "mount" akun cloud (MEGA) — dipakai tree/ops/upload/storage.
// Diatur per-akun lewat Admin Panel (CloudAccount) supaya admin bisa memilih
// siapa saja yang boleh membuka mount dan apakah mereka boleh mengubah isinya.
//
// Dua lapis izin (digabung dengan sifat TAMBAHAN — grant tidak pernah
// memangkas hak yang sudah diberikan lapisan lain):
//   1. PER PERAN (mountVisibleTo + mountMode) — lapisan lama:
//      ADMIN = admin saja · GURU = guru + admin · ALL = semua user.
//   2. PER ORANG (mountUserIds + mountUserWriteIds) — lapisan baru:
//      mountUserIds      = orang yang boleh MEMBUKA mount walau perannya
//                         tidak termasuk (grant lihat).
//      mountUserWriteIds = orang yang boleh MENULIS walau mountMode READ
//                         (grant tulis; otomatis boleh membuka juga).
// ─────────────────────────────────────────────────────────────────────────

export interface MountAccessFields {
  mountVisibleTo?: string | null;
  mountMode?: string | null;
  mountUserIds?: string[] | null;
  mountUserWriteIds?: string[] | null;
}

export type MountVisibleTo = "ADMIN" | "GURU" | "ALL";
export type MountMode = "READ" | "WRITE";

/** Normalisasi nilai dari DB (tahan nilai lama/aneh). */
export function normalizeVisibleTo(v?: string | null): MountVisibleTo {
  return v === "ADMIN" || v === "ALL" ? v : "GURU";
}
export function normalizeMountMode(v?: string | null): MountMode {
  return v === "READ" ? "READ" : "WRITE";
}

/** Apakah userId mendapat grant khusus per-orang untuk membuka mount? */
function hasUserViewGrant(account: MountAccessFields, userId?: string | null): boolean {
  if (!userId) return false;
  return (
    account.mountUserIds?.includes(userId) === true ||
    account.mountUserWriteIds?.includes(userId) === true
  );
}

/** Apakah userId mendapat grant khusus per-orang untuk menulis? */
function hasUserWriteGrant(account: MountAccessFields, userId?: string | null): boolean {
  if (!userId) return false;
  return account.mountUserWriteIds?.includes(userId) === true;
}

/** Akses dari PERAN saja (tanpa memperhitungkan grant per-orang). */
function canViewByRole(
  account: MountAccessFields,
  role: string | undefined | null
): boolean {
  if (!role) return false;
  if (role === "ADMIN") return true;
  const visibleTo = normalizeVisibleTo(account.mountVisibleTo);
  if (visibleTo === "ALL") return true;
  if (visibleTo === "ADMIN") return false;
  return role === "GURU";
}

/**
 * Boleh MEMBUKA mount (melihat tree, pratinjau, unduh)?
 * Admin selalu boleh. Selain itu: grant per-orang ATAU peran.
 */
export function canViewMount(
  account: MountAccessFields,
  role: string | undefined | null,
  userId?: string | null
): boolean {
  if (hasUserViewGrant(account, userId)) return true;
  return canViewByRole(account, role);
}

/**
 * Boleh MENGUBAH isi mount (unggah/rename/move/copy/tempel/hapus)?
 *
 * Aturan (lapisan diambil yang PALING longgar):
 *  · grant tulis per-orang → selalu boleh (menimpa mountMode READ).
 *  · akses dari peran       → boleh tulis hanya bila mountMode WRITE
 *                             (perilaku lama, termasuk untuk admin).
 *  · grant LIHAT per-orang murni (peran tidak memberi akses sama sekali)
 *    → hanya baca, karena grant-nya memang hanya "lihat".
 */
export function canWriteMount(
  account: MountAccessFields,
  role: string | undefined | null,
  userId?: string | null
): boolean {
  if (!canViewMount(account, role, userId)) return false;
  if (hasUserWriteGrant(account, userId)) return true;
  const byRole = canViewByRole(account, role);
  if (!byRole) {
    // Hanya punya grant "lihat" per-orang (tanpa grant tulis, tanpa akses
    // peran) → jelas baca-saja.
    return false;
  }
  return normalizeMountMode(account.mountMode) === "WRITE";
}

/**
 * Ringkasan akses efektif satu user untuk satu akun mount — dipakai UI
 * (badge/label) dan pengujian. `via` menjelaskan dari mana akses berasal.
 */
export function mountAccessSummary(
  account: MountAccessFields,
  role: string | undefined | null,
  userId?: string | null
): { level: "none" | "read" | "write"; via: "admin" | "role" | "user" | null } {
  if (!canViewMount(account, role, userId)) {
    return { level: "none", via: null };
  }
  const canWrite = canWriteMount(account, role, userId);
  if (role === "ADMIN") return { level: canWrite ? "write" : "read", via: "admin" };
  if (hasUserViewGrant(account, userId) && !canViewByRole(account, role)) {
    // Akses murni dari grant per-orang.
    return { level: canWrite ? "write" : "read", via: "user" };
  }
  return { level: canWrite ? "write" : "read", via: "role" };
}

/** Label singkat Indonesia untuk tampilan admin. */
export function mountVisibleToLabel(v?: string | null): string {
  switch (normalizeVisibleTo(v)) {
    case "ADMIN":
      return "Admin saja";
    case "ALL":
      return "Semua user (termasuk siswa)";
    default:
      return "Guru & Admin";
  }
}
export function mountModeLabel(m?: string | null): string {
  return normalizeMountMode(m) === "READ" ? "Baca-saja" : "Baca & tulis";
}
