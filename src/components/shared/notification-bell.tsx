"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Bell,
  BellRing,
  MessageSquare,
  AtSign,
  ClipboardList,
  Info,
  CheckCheck,
  Trash2,
  Volume2,
  VolumeX,
  Smartphone,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { useUIStore, type Conversation } from "@/stores/ui-store";
import {
  useNotifyStore,
  type NotifItem,
  notifPermission,
  requestNotifPermission,
} from "@/lib/notify";
import {
  getPushStatus,
  enableDevicePush,
  disableDevicePush,
  type PushStatus,
} from "@/lib/push-client";

// ─────────────────────────────────────────────────────────────────────────
// Lonceng notifikasi global — dipasang di header sidebar & topbar mobile.
// Panel: riwayat (pesan baru, @mention, kartu tugas), waktu relatif,
// buka percakapan terkait, aktifkan notifikasi browser, suara on/off.
// ─────────────────────────────────────────────────────────────────────────

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60_000);
  if (m < 1) return "baru saja";
  if (m < 60) return `${m} mnt lalu`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} jam lalu`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d} hari lalu`;
  return new Date(ts).toLocaleDateString("id-ID");
}

const KIND_ICON: Record<NotifItem["kind"], typeof MessageSquare> = {
  chat: MessageSquare,
  mention: AtSign,
  assignment: ClipboardList,
  system: Info,
};

const KIND_CLS: Record<NotifItem["kind"], string> = {
  chat: "text-sky-500 bg-sky-500/10",
  mention: "text-amber-500 bg-amber-500/10",
  assignment: "text-violet-500 bg-violet-500/10",
  system: "text-muted-foreground bg-muted",
};

export function NotificationBell({ compact = false }: { compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const items = useNotifyStore((s) => s.items);
  const unread = items.filter((i) => !i.read).length;
  const soundEnabled = useNotifyStore((s) => s.soundEnabled);
  const setSound = useNotifyStore((s) => s.setSound);
  const markAllRead = useNotifyStore((s) => s.markAllRead);
  const clearAll = useNotifyStore((s) => s.clearAll);
  const openConversation = useUIStore((s) => s.openConversation);
  const router = useRouter();
  const [perm, setPerm] = useState(() => notifPermission());

  // ── Notifikasi perangkat (Web Push PWA) ──
  const [push, setPush] = useState<PushStatus | null>(null);
  const [pushBusy, setPushBusy] = useState(false);
  const [pushError, setPushError] = useState<string | null>(null);

  const refreshPush = useCallback(async () => {
    try {
      setPush(await getPushStatus());
    } catch {
      setPush({ supported: false, permission: "unsupported", subscribed: false });
    }
  }, []);

  useEffect(() => {
    if (open) void refreshPush();
  }, [open, refreshPush]);

  async function onTogglePush(checked: boolean) {
    setPushBusy(true);
    setPushError(null);
    try {
      if (checked) {
        const res = await enableDevicePush();
        if (!res.ok) {
          setPushError(
            res.error === "denied"
              ? "Izin notifikasi ditolak browser — ubah di pengaturan situs lalu coba lagi."
              : res.error === "unsupported"
                ? "Browser/perangkat ini tidak mendukung Web Push."
                : "Gagal mengaktifkan notifikasi perangkat — coba lagi."
          );
        }
      } else {
        await disableDevicePush();
      }
    } finally {
      await refreshPush();
      setPushBusy(false);
    }
  }

  function onItemClick(item: NotifItem) {
    if (item.conv) {
      const c: Conversation =
        item.conv.kind === "dm"
          ? {
              kind: "dm",
              id: item.conv.id,
              peerId: item.conv.id, // diperbaiki routing utama; dm jarang via bell
              peerName: item.conv.name,
            }
          : {
              kind: item.conv.kind,
              id: item.conv.id,
              name: item.conv.name,
            };
      openConversation(c);
      setOpen(false);
    }
    markAllRead();
  }

  async function enableBrowser() {
    const p = await requestNotifPermission();
    setPerm(p);
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className={cn("relative", compact ? "h-8 w-8" : "h-9 w-9")}
          title="Notifikasi"
          aria-label={`Notifikasi${unread > 0 ? ` (${unread} belum dibaca)` : ""}`}
        >
          {unread > 0 ? (
            <BellRing className="size-[18px] text-primary" />
          ) : (
            <Bell className="size-[18px]" />
          )}
          {unread > 0 ? (
            <span className="absolute -top-0.5 -right-0.5 min-w-4 h-4 px-0.5 rounded-full bg-destructive text-destructive-foreground text-[10px] font-semibold leading-none flex items-center justify-center">
              {unread > 99 ? "99+" : unread}
            </span>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0">
        <div className="flex items-center justify-between px-3 py-2 border-b border-border">
          <p className="text-sm font-semibold">Notifikasi</p>
          <div className="flex items-center gap-0.5">
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              onClick={() => setSound(!soundEnabled)}
              title={soundEnabled ? "Matikan bunyi" : "Nyalakan bunyi"}
            >
              {soundEnabled ? (
                <Volume2 className="size-3.5" />
              ) : (
                <VolumeX className="size-3.5" />
              )}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              onClick={markAllRead}
              disabled={unread === 0}
              title="Tandai semua dibaca"
            >
              <CheckCheck className="size-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              onClick={clearAll}
              disabled={items.length === 0}
              title="Bersihkan riwayat"
            >
              <Trash2 className="size-3.5" />
            </Button>
          </div>
        </div>

        {/* Izin notifikasi browser */}
        {perm === "default" ? (
          <div className="px-3 py-2.5 border-b border-border bg-muted/40">
            <p className="text-xs text-muted-foreground mb-1.5">
              Biarkan Aula mengirim notifikasi ke perangkat ini (muncul saat
              tab tersembunyi / browser ditutup di beberapa platform).
            </p>
            <Button size="sm" className="h-7 w-full" onClick={() => void enableBrowser()}>
              <BellRing className="size-3.5" /> Aktifkan notifikasi browser
            </Button>
          </div>
        ) : perm === "denied" ? (
          <div className="px-3 py-2 border-b border-border bg-muted/40 text-xs text-muted-foreground">
            Notifikasi browser diblokir — buka izin situs di browser untuk
            mengaktifkan kembali. Notifikasi dalam aplikasi tetap berjalan.
          </div>
        ) : null}

        {/* Notifikasi perangkat — Web Push (PWA) */}
        <div className="px-3 py-2.5 border-b border-border bg-muted/40">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-xs font-medium flex items-center gap-1.5">
                <Smartphone className="size-3.5 text-primary shrink-0" />
                Notifikasi perangkat
              </p>
              <p className="text-[11px] text-muted-foreground mt-0.5">
                Muncul walau browser ditutup (PWA)
              </p>
            </div>
            <Switch
              checked={!!push?.subscribed}
              disabled={pushBusy || !push?.supported || push?.permission === "denied"}
              onCheckedChange={(v) => void onTogglePush(v)}
              aria-label="Notifikasi perangkat (muncul walau browser ditutup)"
            />
          </div>

          {!push ? (
            <p className="text-[11px] text-muted-foreground mt-1.5">Memeriksa…</p>
          ) : !push.supported ? (
            <p className="text-[11px] text-muted-foreground mt-1.5">
              Browser/perangkat ini tidak mendukung notifikasi push.
            </p>
          ) : push.permission === "denied" ? (
            <p className="text-[11px] text-destructive mt-1.5">
              Izin notifikasi diblokir — ubah di pengaturan situs browser
              untuk mengaktifkan.
            </p>
          ) : push.subscribed ? (
            <p className="text-[11px] text-emerald-600 dark:text-emerald-400 mt-1.5">
              Aktif di perangkat ini — pesan baru diterima walau aplikasi
              tidak dibuka.
            </p>
          ) : (
            <p className="text-[11px] text-muted-foreground mt-1.5">
              Nonaktif — nyalakan untuk menerima pesan baru di perangkat ini.
            </p>
          )}

          {pushError ? (
            <p className="text-[11px] text-destructive mt-1">{pushError}</p>
          ) : null}

          <p className="text-[10px] text-muted-foreground/80 mt-1.5">
            Android/iOS: instal aplikasi dari menu browser ("Tambahkan ke
            layar utama") supaya notifikasi tetap berjalan saat browser
            ditutup.
          </p>
        </div>

        <div className="max-h-80 overflow-auto">
          {items.length === 0 ? (
            <div className="px-4 py-10 text-center">
              <Bell className="size-8 mx-auto text-muted-foreground/50" />
              <p className="text-xs text-muted-foreground mt-2">
                Belum ada notifikasi. Pesan baru, @mention, dan kartu tugas
                akan muncul di sini.
              </p>
            </div>
          ) : (
            items.map((item) => {
              const Icon = KIND_ICON[item.kind];
              return (
                <button
                  key={item.id}
                  className={cn(
                    "w-full text-left px-3 py-2.5 flex gap-2.5 border-b border-border/60 last:border-0 hover:bg-accent/60",
                    !item.read && "bg-primary/5"
                  )}
                  onClick={() => onItemClick(item)}
                >
                  <span
                    className={cn(
                      "size-7 shrink-0 rounded-full flex items-center justify-center",
                      KIND_CLS[item.kind]
                    )}
                  >
                    <Icon className="size-3.5" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline justify-between gap-2">
                      <span className="text-xs font-medium truncate">
                        {item.title}
                      </span>
                      <span className="text-[10px] text-muted-foreground shrink-0">
                        {timeAgo(item.ts)}
                      </span>
                    </span>
                    <span className="block text-xs text-muted-foreground line-clamp-2 mt-0.5">
                      {item.body}
                    </span>
                  </span>
                  {!item.read ? (
                    <span className="size-2 rounded-full bg-primary shrink-0 mt-1.5" />
                  ) : null}
                </button>
              );
            })
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
