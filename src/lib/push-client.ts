"use client";

// ─────────────────────────────────────────────────────────────────────────
// Web Push (PWA) — sisi client.
// • initPushWorker(): pasang service worker /sw.js (sekali, diam-diam) —
//   dipanggil dari startOverviewPoller supaya SW siap sejak login.
// • enableDevicePush(): minta izin → subscribe pushManager (kunci publik
//   VAPID dari GET /api/push/subscribe) → POST langganan ke server.
// • disableDevicePush(): unsubscribe lokal + DELETE dari server.
// • getPushStatus(): status untuk UI (didukung / izin / terlanggani).
// ─────────────────────────────────────────────────────────────────────────

export interface PushStatus {
  supported: boolean;
  permission: NotificationPermission | "unsupported";
  subscribed: boolean;
}

function pushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof navigator !== "undefined" &&
    "serviceWorker" in navigator &&
    typeof Notification !== "undefined"
  );
}

/** base64url (tanpa padding) → Uint8Array untuk applicationServerKey. */
function urlBase64ToUint8Array(base64url: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64url.length % 4)) % 4);
  const base64 = (base64url + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

// ── Service worker ──

let workerPromise: Promise<ServiceWorkerRegistration | null> | null = null;

/** Daftarkan /sw.js sekali per halaman. Tidak pernah melempar. */
export function initPushWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!pushSupported()) return Promise.resolve(null);
  if (!workerPromise) {
    workerPromise = navigator.serviceWorker
      .register("/sw.js", { scope: "/" })
      .catch((e) => {
        console.warn("[push] SW gagal terpasang:", e);
        return null;
      });
  }
  return workerPromise;
}

// ── Kirim langganan ke server ──

async function postSubscription(sub: PushSubscription): Promise<boolean> {
  try {
    const json = sub.toJSON() as {
      endpoint?: string;
      keys?: { p256dh?: string; auth?: string };
    };
    if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
      return false;
    }
    const res = await fetch("/api/push/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        endpoint: json.endpoint,
        keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ── Aktifkan / nonaktifkan ──

/**
 * Aktifkan notifikasi push di perangkat ini:
 * izin → SW ready → subscribe → simpan ke server.
 * Return status agar UI bisa menampilkan pesan yang tepat.
 */
export async function enableDevicePush(): Promise<{
  ok: boolean;
  error?: string;
}> {
  if (!pushSupported()) return { ok: false, error: "unsupported" };
  try {
    const permission = await Notification.requestPermission();
    if (permission !== "granted") return { ok: false, error: permission };

    const reg = await initPushWorker();
    if (!reg) return { ok: false, error: "no-worker" };
    // Pastikan SW aktif sebelum subscribe.
    const ready = reg.active ? reg : await navigator.serviceWorker.ready;

    // Sudah terlangganan? cukup pastikan server punya barisnya.
    const existing = await ready.pushManager.getSubscription();
    if (existing) {
      const posted = await postSubscription(existing);
      return posted ? { ok: true } : { ok: false, error: "server" };
    }

    const res = await fetch("/api/push/subscribe", { cache: "no-store" });
    if (!res.ok) return { ok: false, error: "server" };
    const data = (await res.json()) as { publicKey?: string };
    if (!data.publicKey) return { ok: false, error: "server" };

    const sub = await ready.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(data.publicKey),
    });
    const posted = await postSubscription(sub);
    return posted ? { ok: true } : { ok: false, error: "server" };
  } catch (e) {
    console.warn("[push] aktifasi gagal:", e);
    return { ok: false, error: "unknown" };
  }
}

/** Matikan push di perangkat ini (unsubscribe lokal + hapus di server). */
export async function disableDevicePush(): Promise<boolean> {
  if (!pushSupported()) return false;
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg) return true;
    const sub = await reg.pushManager.getSubscription();
    if (!sub) return true;
    const endpoint = sub.endpoint;
    const ok = await sub.unsubscribe();
    try {
      await fetch("/api/push/subscribe", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint }),
      });
    } catch {
      // server gagal — langganan lokal sudah mati, biarkan.
    }
    return ok;
  } catch (e) {
    console.warn("[push] nonaktifasi gagal:", e);
    return false;
  }
}

/** Status push untuk UI (dipanggil saat panel notifikasi dibuka). */
export async function getPushStatus(): Promise<PushStatus> {
  if (!pushSupported()) {
    return { supported: false, permission: "unsupported", subscribed: false };
  }
  const permission = Notification.permission;
  let subscribed = false;
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    if (reg) subscribed = !!(await reg.pushManager.getSubscription());
  } catch {
    /* abaikan */
  }
  return { supported: true, permission, subscribed };
}
