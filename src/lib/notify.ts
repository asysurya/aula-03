"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { initPushWorker } from "@/lib/push-client";

// ─────────────────────────────────────────────────────────────────────────
// Notifikasi Aula — pusat notifikasi web.
// • Lonceng + panel notifikasi (riwayat pesan baru, @mention, kartu tugas).
// • Web Notification browser (saat tab tersembunyi / percakapan lain).
// • Bunyi lembut (WebAudio — tanpa file aset) + badge angka di judul tab.
// • Badge tidak-dibaca per percakapan di sidebar.
// • Poller /api/chat/overview mendeteksi pesan baru di percakapan yang
//   tidak sedang dibuka (kelas, grup, DM) — ±30 detik.
// ─────────────────────────────────────────────────────────────────────────

export type NotifKind = "chat" | "mention" | "assignment" | "system";

export interface NotifItem {
  id: string;
  kind: NotifKind;
  title: string;
  body: string;
  ts: number;
  read: boolean;
  conv?: {
    kind: "classroom" | "group" | "dm";
    id: string;
    name: string;
  };
}

export interface ConvRef {
  kind: "classroom" | "group" | "dm";
  id: string;
  name: string;
}

interface NotifyState {
  items: NotifItem[];
  /** badge belum-dibaca per "kind:id" percakapan */
  unreadByConv: Record<string, number>;
  soundEnabled: boolean;
  add: (
    item: Omit<NotifItem, "id" | "ts" | "read"> & { id?: string }
  ) => NotifItem;
  markAllRead: () => void;
  clearAll: () => void;
  clearUnread: (convKey: string) => void;
  setSound: (v: boolean) => void;
}

export const useNotifyStore = create<NotifyState>()(
  persist(
    (set, get) => ({
      items: [],
      unreadByConv: {},
      soundEnabled: true,
      add: (input) => {
        const item: NotifItem = {
          ...input,
          id: input.id ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
          ts: Date.now(),
          read: false,
        };
        set((s) => ({
          items: [item, ...s.items].slice(0, 100),
        }));
        if (item.conv) {
          const key = convKeyOf(item.conv);
          set((s) => ({
            unreadByConv: {
              ...s.unreadByConv,
              [key]: (s.unreadByConv[key] ?? 0) + 1,
            },
          }));
        }
        refreshTitleBadge(get().items.filter((i) => !i.read).length);
        return item;
      },
      markAllRead: () => {
        set((s) => ({
          items: s.items.map((i) => ({ ...i, read: true })),
          unreadByConv: {},
        }));
        refreshTitleBadge(0);
      },
      clearAll: () => {
        set({ items: [], unreadByConv: {} });
        refreshTitleBadge(0);
      },
      clearUnread: (key) => {
        set((s) => {
          if (!s.unreadByConv[key]) return s;
          const next = { ...s.unreadByConv };
          delete next[key];
          return { ...s, unreadByConv: next };
        });
      },
      setSound: (v) => set({ soundEnabled: v }),
    }),
    {
      name: "aula.notify.v1",
      partialize: (s) => ({
        items: s.items.slice(0, 60),
        unreadByConv: s.unreadByConv,
        soundEnabled: s.soundEnabled,
      }),
    }
  )
);

export function convKeyOf(c: ConvRef): string {
  return `${c.kind}:${c.id}`;
}

// ── Badge angka di judul tab ──

let baseTitle: string | null = null;

export function refreshTitleBadge(unread: number) {
  if (typeof document === "undefined") return;
  if (!baseTitle) baseTitle = document.title;
  const clean = baseTitle.replace(/^\(\d+\)\s*/, "");
  document.title = unread > 0 ? `(${unread}) ${clean}` : clean;
}

// ── Bunyi lembut (dua nada — WebAudio, tanpa file aset) ──

let audioCtx: AudioContext | null = null;

export function playChime() {
  try {
    if (!audioCtx) {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      if (!Ctor) return;
      audioCtx = new Ctor();
    }
    if (audioCtx.state === "suspended") void audioCtx.resume();
    const t0 = audioCtx.currentTime;
    const notes: [number, number][] = [
      [660, 0],
      [880, 0.12],
    ];
    for (const [freq, offset] of notes) {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t0 + offset);
      gain.gain.exponentialRampToValueAtTime(0.08, t0 + offset + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + offset + 0.25);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(t0 + offset);
      osc.stop(t0 + offset + 0.3);
    }
  } catch {
    /* abaikan */
  }
}

// ── Web Notification ──

export function notifPermission(): NotificationPermission | "unsupported" {
  if (typeof Notification === "undefined") return "unsupported";
  return Notification.permission;
}

export async function requestNotifPermission(): Promise<
  NotificationPermission | "unsupported"
> {
  if (typeof Notification === "undefined") return "unsupported";
  try {
    return await Notification.requestPermission();
  } catch {
    return "denied";
  }
}

export function showBrowserNotification(title: string, body: string, tag?: string) {
  if (typeof Notification === "undefined") return;
  if (Notification.permission !== "granted") return;
  try {
    const n = new Notification(title, {
      body: body.slice(0, 140),
      tag: tag ?? "aula",
      icon: "/logo.svg",
    });
    n.onclick = () => {
      window.focus();
      n.close();
    };
  } catch {
    /* abaikan */
  }
}

// ── Pengirim event notifikasi terpusat ──

export function notifyEvent(input: {
  kind: NotifKind;
  title: string;
  body: string;
  conv?: ConvRef;
  /** paksa bunyi + notifikasi browser walau tab terlihat */
  alert?: boolean;
}) {
  const { soundEnabled } = useNotifyStore.getState();
  const hidden = typeof document !== "undefined" && document.hidden;
  const alert = input.alert || hidden;

  useNotifyStore.getState().add(input);

  if (alert) {
    if (soundEnabled) playChime();
    showBrowserNotification(
      input.title,
      input.body,
      input.conv ? convKeyOf(input.conv) : "aula"
    );
  }
}

// ── Poller overview: pesan baru di percakapan yang tidak dibuka ──
// Dipasang SEKALI di AppShell. lastSeen per percakapan disimpan di
// localStorage ("aula.lastseen") — poll pertama hanya mengisi patokan
// tanpa menotifikasi (pesan lama tidak dianggap baru).
// Service worker /sw.js (Web Push PWA) juga dipasang di sini supaya
// siap sejak login — tanpa perlu menunggu user membuka panel notifikasi.

interface LastMsgInfo {
  id: string;
  content: string;
  createdAt: string;
  senderId: string;
  senderName: string;
  assignmentId: string | null;
  assignmentTitle: string | null;
}

const LASTSEEN_KEY = "aula.lastseen.v1";

function loadLastSeen(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(LASTSEEN_KEY) ?? "{}");
  } catch {
    return {};
  }
}

function saveLastSeen(map: Record<string, string>) {
  try {
    localStorage.setItem(LASTSEEN_KEY, JSON.stringify(map));
  } catch {
    /* penuh */
  }
}

let pollerStarted = false;

/**
 * Tandai percakapan sudah dilihat: hapus badge tidak-dibaca + reset
 * patokan lastSeen (poller berikutnya mengisi ulang tanpa menotifikasi).
 */
export function markConvSeen(convKey: string) {
  useNotifyStore.getState().clearUnread(convKey);
  try {
    const map = loadLastSeen();
    if (map[convKey] !== undefined) {
      delete map[convKey];
      saveLastSeen(map);
    }
  } catch {
    /* abaikan */
  }
}

export function startOverviewPoller(opts: {
  myId: string;
  myUsername?: string;
  myName?: string;
  isConversationActive: (c: ConvRef) => boolean;
}) {
  if (pollerStarted || typeof window === "undefined") return;
  pollerStarted = true;

  // Pasang service worker Web Push (sekali, guarded di dalamnya).
  void initPushWorker();

  const seen = loadLastSeen();
  let timer: ReturnType<typeof setTimeout> | null = null;

  async function tick() {
    try {
      if (document.hidden) return; // hemat: tab tersembunyi skip
      const res = await fetch("/api/chat/overview", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as {
        conversations: (ConvRef & { last: LastMsgInfo | null })[];
      };
      let changed = false;
      for (const conv of data.conversations) {
        const key = convKeyOf(conv);
        if (!conv.last) continue;
        const prevId = seen[key];
        if (!prevId) {
          // Patokan awal — jangan notifikasi pesan lama.
          seen[key] = conv.last.id;
          changed = true;
          continue;
        }
        if (prevId === conv.last.id) continue;
        seen[key] = conv.last.id;
        changed = true;
        // Pesan baru — abaikan pesan sendiri.
        if (conv.last.senderId === opts.myId) continue;
        // Percakapan sedang dibuka + tab terlihat → ChatView sudah
        // menangani realtime (SSE); tidak perlu notifikasi.
        if (opts.isConversationActive(conv) && !document.hidden) continue;

        const mention =
          opts.myUsername || opts.myName
            ? new RegExp(
                `@(?:${[opts.myUsername, opts.myName]
                  .filter((s): s is string => !!s)
                  .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
                  .join("|")})\\b`,
                "i"
              ).test(conv.last.content || "")
            : false;

        if (conv.last.assignmentId && conv.last.assignmentTitle) {
          notifyEvent({
            kind: "assignment",
            title: `Tugas baru di ${conv.name}`,
            body: ` "${conv.last.assignmentTitle}" dikirim oleh ${conv.last.senderName}`,
            conv,
          });
        } else if (mention) {
          notifyEvent({
            kind: "mention",
            title: `${conv.last.senderName} menyebutmu`,
            body: (conv.last.content || "").slice(0, 120),
            conv,
          });
        } else {
          notifyEvent({
            kind: "chat",
            title: `${conv.last.senderName} · ${conv.name}`,
            body: (conv.last.content || "mengirim lampiran").slice(0, 120),
            conv,
          });
        }
      }
      if (changed) saveLastSeen(seen);
    } catch {
      /* jaringan — coba lagi siklus berikutnya */
    } finally {
      timer = setTimeout(tick, 30_000);
    }
  }

  // Mulai agak delay biar tidak berebut dengan initial load aplikasi.
  timer = setTimeout(tick, 6_000);

  // Reset patokan saat kembali terlihat? Tidak — poll tetap jalan saat
  // visible saja; hidden ditangani saat ChatView aktif / saat kembali.
  window.addEventListener("beforeunload", () => {
    if (timer) clearTimeout(timer);
  });
}
