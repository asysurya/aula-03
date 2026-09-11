import webpush from "web-push";
import { db } from "@/lib/db";

// ─────────────────────────────────────────────────────────────────────────
// Web Push (PWA) — sisi server.
// • Kunci VAPID disimpan di AppSetting key "push.vapid" (JSON:
//   { publicKey, privateKey, subject }) — dibuat otomatis saat pertama kali
//   dibutuhkan, lalu di-cache modul (tidak query DB tiap kali).
// • HANYA kunci publik yang boleh keluar dari modul ini (lihat
//   getVapidPublicKey). Private key tidak pernah diekspor.
// • sendPushToUsers TIDAK PERNAH melempar error ke pemanggil — kegagalan
//   push tidak boleh menggagalkan fitur utama (mis. kirim pesan chat).
// • Langganan yang ditolak push service (404/410) dihapus otomatis.
// ─────────────────────────────────────────────────────────────────────────

const VAPID_SETTING_KEY = "push.vapid";
const VAPID_SUBJECT = "mailto:admin@aula.local";
/** TTL pesan push di push service (24 jam) — pesan sampai walau perangkat
 *  offline beberapa jam. */
const PUSH_TTL_SECONDS = 24 * 60 * 60;
/** Batas jumlah subscription per pengiriman (terbaru duluan). */
const MAX_SUBSCRIPTIONS = 200;

export interface PushPayload {
  title: string;
  body: string;
  /** URL yang dibuka saat notifikasi diklik. */
  url?: string;
  /** Tag untuk menggabungkan notifikasi per percakapan. */
  tag?: string;
}

interface VapidKeys {
  publicKey: string;
  privateKey: string;
  subject: string;
}

export interface SendPushResult {
  attempted: number;
  sent: number;
  failed: number;
  removed: number;
}

let cachedKeys: VapidKeys | null = null;

/** Muat (atau buat + simpan) kunci VAPID. Tidak diekspor — private key
 *  tidak boleh keluar dari modul ini. */
async function loadVapidKeys(): Promise<VapidKeys | null> {
  if (cachedKeys) return cachedKeys;
  try {
    const row = await db.appSetting.findUnique({
      where: { key: VAPID_SETTING_KEY },
    });
    if (row) {
      try {
        const parsed = JSON.parse(row.value) as Partial<VapidKeys>;
        if (parsed.publicKey && parsed.privateKey) {
          cachedKeys = {
            publicKey: String(parsed.publicKey),
            privateKey: String(parsed.privateKey),
            subject: String(parsed.subject || VAPID_SUBJECT),
          };
          return cachedKeys;
        }
      } catch {
        // JSON korup → regenerasi di bawah.
      }
    }
    // Belum ada / korup → generate & simpan (best-effort; bila gagal
    // menyimpan tetap dipakai untuk request ini).
    const generated = webpush.generateVAPIDKeys();
    const keys: VapidKeys = { ...generated, subject: VAPID_SUBJECT };
    try {
      await db.appSetting.upsert({
        where: { key: VAPID_SETTING_KEY },
        update: { value: JSON.stringify(keys) },
        create: { key: VAPID_SETTING_KEY, value: JSON.stringify(keys) },
      });
    } catch (e) {
      console.error("[push] gagal menyimpan kunci VAPID:", e);
    }
    cachedKeys = keys;
    return keys;
  } catch (e) {
    console.error("[push] gagal memuat kunci VAPID:", e);
    return null;
  }
}

/** Kunci PUBLIK VAPID — untuk pushManager.subscribe di browser. */
export async function getVapidPublicKey(): Promise<string | null> {
  const keys = await loadVapidKeys();
  return keys?.publicKey ?? null;
}

/**
 * Kirim push ke semua langganan milik `userIds` (kecuali `excludeUserId`,
 * biasanya pengirim pesan — jangan notifikasi diri sendiri).
 * Selalu resolve (tidak pernah melempar). Return ringkasan untuk logging.
 */
export async function sendPushToUsers(
  userIds: string[],
  payload: PushPayload,
  opts: { excludeUserId?: string } = {}
): Promise<SendPushResult> {
  const result: SendPushResult = {
    attempted: 0,
    sent: 0,
    failed: 0,
    removed: 0,
  };
  try {
    const targets = [...new Set(userIds)].filter(
      (id) => id && id !== opts.excludeUserId
    );
    if (targets.length === 0) return result;

    const keys = await loadVapidKeys();
    if (!keys) return result;

    const subs = await db.pushSubscription.findMany({
      where: { userId: { in: targets } },
      orderBy: { createdAt: "desc" },
      take: MAX_SUBSCRIPTIONS,
    });
    if (subs.length === 0) return result;
    result.attempted = subs.length;

    const json = JSON.stringify(payload);
    const settled = await Promise.allSettled(
      subs.map((s) =>
        webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          json,
          {
            vapidDetails: {
              subject: keys.subject,
              publicKey: keys.publicKey,
              privateKey: keys.privateKey,
            },
            TTL: PUSH_TTL_SECONDS,
          }
        )
      )
    );

    const staleIds: string[] = [];
    settled.forEach((r, i) => {
      if (r.status === "fulfilled") {
        result.sent++;
        return;
      }
      result.failed++;
      const status = (r.reason as { statusCode?: number } | undefined)
        ?.statusCode;
      // 404/410 = langganan tidak lagi valid (browser unsubscribe / app
      // dihapus) → bersihkan barisnya.
      if (status === 404 || status === 410) staleIds.push(subs[i].id);
    });

    if (staleIds.length > 0) {
      try {
        await db.pushSubscription.deleteMany({
          where: { id: { in: staleIds } },
        });
        result.removed = staleIds.length;
      } catch (e) {
        console.error("[push] gagal menghapus langganan basi:", e);
      }
    }
  } catch (e) {
    console.error("[push] sendPushToUsers error:", e);
  }
  return result;
}
