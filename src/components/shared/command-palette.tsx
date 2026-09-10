"use client";

// Command palette global (Ctrl+K / Cmd+K) — navigasi cepat ala VSCode /
// Discord: lompat ke kelas, grup, DM, halaman Cloud/Anggota/Profil/Admin,
// jadwal tugas, dan aksi ganti tema. ↑↓ pilih, Enter buka, Esc tutup.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTheme } from "next-themes";
import { useDmConversations } from "@/hooks/use-dm-conversations";
import { useMe, type MeResponse } from "@/hooks/use-me";
import { useUIStore } from "@/stores/ui-store";
import {
  CalendarDays,
  Cloud,
  Command,
  Hash,
  Lock,
  Moon,
  Search,
  Shield,
  Sun,
  UserCircle,
  Users,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { UserAvatar } from "@/components/shared/user-avatar";
import { cn } from "@/lib/utils";
import { UpcomingDialog } from "./upcoming-dialog";

type PaletteItem = {
  key: string;
  group: string;
  label: string;
  hint?: string;
  icon: React.ReactNode;
  run: () => void;
};

export function CommandPalette({ me }: { me: MeResponse }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [index, setIndex] = useState(0);
  const [upcomingOpen, setUpcomingOpen] = useState(false);
  const { resolvedTheme, setTheme } = useTheme();
  const {
    openConversation,
    openCloudFolder,
    openMembers,
    openProfile,
    openAdmin,
  } = useUIStore();
  const { data: dms } = useDmConversations(true);

  // Ctrl+K / Cmd+K untuk buka; Esc untuk tutup (Dialog default).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Reset isi saat palette DIBUKA — pola render (adjust state during
  // render), bukan efek.
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) {
      setQ("");
      setIndex(0);
    }
  }

  const items = useMemo<PaletteItem[]>(() => {
    const out: PaletteItem[] = [];
    // Aksi
    out.push({
      key: "act-upcoming",
      group: "Aksi",
      label: "Jadwal Tugas (tenggat)",
      hint: "agenda semua kelas",
      icon: <CalendarDays className="size-4" />,
      run: () => setUpcomingOpen(true),
    });
    out.push({
      key: "act-cloud",
      group: "Aksi",
      label: "Buka Cloud & Tugas",
      icon: <Cloud className="size-4" />,
      run: () => openCloudFolder(null, me.classrooms[0]?.id ?? null),
    });
    out.push({
      key: "act-members",
      group: "Aksi",
      label: "Buka Anggota",
      icon: <Users className="size-4" />,
      run: () => openMembers(me.classrooms[0]?.id ?? null),
    });
    out.push({
      key: "act-profile",
      group: "Aksi",
      label: "Buka Profil Saya",
      icon: <UserCircle className="size-4" />,
      run: () => openProfile(),
    });
    if (me.user?.role === "ADMIN") {
      out.push({
        key: "act-admin",
        group: "Aksi",
        label: "Buka Admin Panel",
        icon: <Shield className="size-4" />,
        run: () => openAdmin(),
      });
    }
    out.push({
      key: "act-theme",
      group: "Aksi",
      label:
        resolvedTheme === "dark"
          ? "Ganti ke tema terang"
          : "Ganti ke tema gelap",
      icon:
        resolvedTheme === "dark" ? (
          <Sun className="size-4" />
        ) : (
          <Moon className="size-4" />
        ),
      run: () => setTheme(resolvedTheme === "dark" ? "light" : "dark"),
    });

    // Kelas
    for (const c of me.classrooms) {
      out.push({
        key: `class-${c.id}`,
        group: "Kelas",
        label: c.name,
        hint: c.memberRole === "TEACHER" ? "guru" : undefined,
        icon: <Hash className="size-4" />,
        run: () =>
          openConversation({ kind: "classroom", id: c.id, name: c.name }),
      });
    }
    // Grup
    for (const g of me.groups) {
      out.push({
        key: `group-${g.id}`,
        group: "Grup",
        label: g.name,
        icon: <Lock className="size-4" />,
        run: () => openConversation({ kind: "group", id: g.id, name: g.name }),
      });
    }
    // DM
    for (const d of dms?.conversations ?? []) {
      out.push({
        key: `dm-${d.id}`,
        group: "Pesan Langsung",
        label: d.peer.name,
        icon: (
          <UserAvatar
            name={d.peer.name}
            username={d.peer.username}
            avatarUrl={d.peer.avatarUrl}
            size="xs"
          />
        ),
        run: () =>
          openConversation({
            kind: "dm",
            id: d.id,
            peerId: d.peer.id,
            peerName: d.peer.name,
          }),
      });
    }
    return out;
  }, [me, dms, resolvedTheme, openConversation, openCloudFolder, openMembers, openProfile, openAdmin, setTheme]);

  const needle = q.trim().toLowerCase();
  const filtered = needle
    ? items.filter(
        (it) =>
          it.label.toLowerCase().includes(needle) ||
          it.group.toLowerCase().includes(needle)
      )
    : items;

  // Kembalikan seleksi ke atas saat hasil berubah — pola render.
  const [prevLen, setPrevLen] = useState(filtered.length);
  if (filtered.length !== prevLen) {
    setPrevLen(filtered.length);
    setIndex(0);
  }

  const runAt = useCallback(
    (i: number) => {
      const item = filtered[i];
      if (!item) return;
      setOpen(false);
      // Tunda sedikit supaya Dialog sempat tertutup sebelum navigasi.
      setTimeout(() => item.run(), 60);
    },
    [filtered]
  );

  return (
    <>
      {/* Tombol pintasan (mobile & desktop) */}
      <Button
        variant="outline"
        size="sm"
        onClick={() => setOpen(true)}
        className="gap-2 text-muted-foreground"
        title="Pencarian cepat (Ctrl+K)"
      >
        <Search className="size-3.5" />
        <span className="hidden sm:inline">Cari…</span>
        <kbd className="hidden md:inline-flex items-center gap-0.5 rounded border bg-muted px-1 py-0.5 text-[10px] font-mono">
          <Command className="size-2.5" />K
        </kbd>
      </Button>

      {open ? (
        <div className="fixed inset-0 z-[60] flex items-start justify-center pt-[12vh] px-4">
          <div
            className="fixed inset-0 bg-black/50 backdrop-blur-sm"
            onClick={() => setOpen(false)}
          />
          <div className="relative w-full max-w-lg rounded-xl border border-border bg-popover shadow-2xl overflow-hidden">
            <div className="flex items-center gap-2 border-b border-border px-3">
              <Search className="size-4 text-muted-foreground shrink-0" />
              <input
                autoFocus
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setIndex((i) => Math.min(filtered.length - 1, i + 1));
                  } else if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setIndex((i) => Math.max(0, i - 1));
                  } else if (e.key === "Enter") {
                    e.preventDefault();
                    runAt(index);
                  }
                }}
                placeholder="Ketik untuk melompat… (kelas, grup, orang, aksi)"
                className="w-full bg-transparent py-3 text-sm outline-none placeholder:text-muted-foreground"
              />
              <kbd className="rounded border bg-muted px-1 py-0.5 text-[10px] font-mono text-muted-foreground shrink-0">
                Esc
              </kbd>
            </div>
            <div className="max-h-[45vh] overflow-y-auto p-1.5">
              {filtered.length === 0 ? (
                <p className="p-6 text-center text-sm text-muted-foreground">
                  Tidak ada hasil untuk “{q}”.
                </p>
              ) : (
                filtered.slice(0, 30).map((it, i) => (
                  <button
                    key={it.key}
                    type="button"
                    onMouseEnter={() => setIndex(i)}
                    onClick={() => runAt(i)}
                    className={cn(
                      "flex items-center gap-3 w-full rounded-lg px-3 py-2 text-left text-sm transition-colors",
                      i === index ? "bg-accent" : "hover:bg-accent/50"
                    )}
                  >
                    <span className="shrink-0 text-muted-foreground">
                      {it.icon}
                    </span>
                    <span className="flex-1 truncate">{it.label}</span>
                    {it.hint ? (
                      <span className="text-[10px] text-muted-foreground shrink-0">
                        {it.hint}
                      </span>
                    ) : null}
                    <span className="text-[10px] uppercase tracking-wide text-muted-foreground/60 shrink-0">
                      {it.group}
                    </span>
                  </button>
                ))
              )}
            </div>
          </div>
        </div>
      ) : null}

      <UpcomingDialog open={upcomingOpen} onOpenChange={setUpcomingOpen} />
    </>
  );
}
