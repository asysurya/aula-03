import { db } from "@/lib/db";

// ─────────────────────────────────────────────────────────────────────
// Kuota proyek AI Builder per minggu (reset Senin 00:00 WIB).
//
// - 1 proyek = 1 SESI chat (BuilderSession) — tercatat sejak potongan
//   kode pertama mengalir, walau siswa tidak menekan "Simpan".
// - Batas berlapis: khusus per-user (User.builderWeeklyLimit) menang
//   atas batas global (AppSetting "ai.builder.limits"); tanpa keduanya
//   dipakai default 5. Admin selalu bebas (unlimited).
// - weekKey = tanggal Senin pekan berjalan dalam WIB (UTC+7) — dihitung
//   manual tanpa lib timezone agar konsisten di server mana pun.
// ─────────────────────────────────────────────────────────────────────

export const DEFAULT_WEEKLY_LIMIT = 5;
export const LIMITS_SETTING_KEY = "ai.builder.limits";
export const LIMIT_MAX = 1000;

const WIB_MS = 7 * 60 * 60 * 1000; // UTC+7
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Kunci minggu berjalan: tanggal SENIN (WIB) format YYYY-MM-DD.
 * Semua sesi satu pekan (Senin–Minggu WIB) berbagi kunci ini; kuota
 * "ter-reset" karena Senin baru menghasilkan kunci baru.
 */
export function mondayKeyJakarta(now: Date = new Date()): string {
  // Geser ke WIB lalu ambil tanggal UTC-nya (trik tanpa lib timezone).
  const shifted = new Date(now.getTime() + WIB_MS);
  const day = shifted.getUTCDay(); // 0 = Minggu … 1 = Senin
  const back = (day + 6) % 7; // hari sejak Senin pekan ini
  return new Date(shifted.getTime() - back * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

/** Senin BERIKUTNYA pukul 00:00 WIB (untuk pesan "reset pada …"). */
export function nextMondayJakarta(now: Date = new Date()): Date {
  const shifted = new Date(now.getTime() + WIB_MS);
  const day = shifted.getUTCDay();
  const back = (day + 6) % 7;
  const monday = new Date(shifted.getTime() - back * DAY_MS);
  monday.setUTCHours(0, 0, 0, 0);
  return new Date(monday.getTime() + 7 * DAY_MS - WIB_MS);
}

/** Batas global dari AppSetting "ai.builder.limits" (null = belum diatur). */
export async function readGlobalLimit(): Promise<number | null> {
  const row = await db.appSetting.findUnique({
    where: { key: LIMITS_SETTING_KEY },
  });
  if (!row) return null;
  try {
    const raw = JSON.parse(row.value) as { weeklyLimit?: unknown };
    const n = Number(raw?.weeklyLimit);
    if (Number.isFinite(n) && n >= 0 && n <= LIMIT_MAX) {
      return Math.floor(n);
    }
  } catch {
    /* nilai rusak → anggap belum diatur */
  }
  return null;
}

export interface BuilderQuotaStatus {
  /** jumlah sesi (proyek) minggu ini */
  used: number;
  /** batas efektif — null = bebas (admin) */
  limit: number | null;
  /** sisa — null = bebas */
  remaining: number | null;
  unlimited: boolean;
  weekKey: string;
}

/**
 * Status kuota user minggu ini.
 * Prioritas batas: admin → bebas; khusus user → global → default 5.
 */
export async function builderQuotaStatus(user: {
  id: string;
  role: string;
}): Promise<BuilderQuotaStatus> {
  const weekKey = mondayKeyJakarta();
  const unlimited = user.role === "ADMIN";

  const [global, userRow, used] = await Promise.all([
    readGlobalLimit(),
    db.user.findUnique({
      where: { id: user.id },
      select: { builderWeeklyLimit: true },
    }),
    db.builderSession.count({ where: { userId: user.id, weekKey } }),
  ]);

  const perUser = userRow?.builderWeeklyLimit ?? null;
  const limit = unlimited ? null : (perUser ?? global ?? DEFAULT_WEEKLY_LIMIT);

  return {
    used,
    limit,
    remaining: limit === null ? null : Math.max(0, limit - used),
    unlimited,
    weekKey,
  };
}
