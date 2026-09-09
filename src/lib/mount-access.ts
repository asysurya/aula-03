// ─────────────────────────────────────────────────────────────────────────
// Hak akses "mount" akun cloud (MEGA) — dipakai tree/ops/upload/storage.
// Diatur per-akun lewat Admin Panel (mountVisibleTo + mountMode di
// CloudAccount) supaya admin bisa memilih siapa saja yang boleh membuka
// mount dan apakah mereka boleh mengubah isinya.
// ─────────────────────────────────────────────────────────────────────────

export interface MountAccessFields {
  mountVisibleTo?: string | null;
  mountMode?: string | null;
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

/** Boleh MEMBUKA mount (melihat tree, pratinjau, unduh)? */
export function canViewMount(
  account: MountAccessFields,
  role: string | undefined | null
): boolean {
  if (!role) return false;
  const visibleTo = normalizeVisibleTo(account.mountVisibleTo);
  if (visibleTo === "ALL") return true;
  if (visibleTo === "ADMIN") return role === "ADMIN";
  return role === "ADMIN" || role === "GURU";
}

/** Boleh MENGUBAH isi mount (unggah/rename/move/copy/tempel/hapus)? */
export function canWriteMount(
  account: MountAccessFields,
  role: string | undefined | null
): boolean {
  return (
    canViewMount(account, role) && normalizeMountMode(account.mountMode) === "WRITE"
  );
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
