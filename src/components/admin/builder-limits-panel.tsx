"use client";

// ─────────────────────────────────────────────────────────────────────────
// Admin Panel → tab AI Builder: kartu "Batas Proyek Mingguan".
//
// - Batas GLOBAL untuk semua siswa (default 5, reset Senin 00:00 WIB).
// - Dialog "Atur per orang": batas KHUSUS per user menimpa global;
//   kolom kosong = ikut global; admin selalu bebas.
// - Menampilkan pemakaian minggu ini per user (sesi tercatat walau
//   proyek tidak disimpan — 1 sesi chat = 1 proyek).
// ─────────────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { CalendarClock, Loader2, Search, UserRoundCog, Info } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

interface LimitsUserRow {
  id: string;
  username: string;
  name: string;
  role: string;
  limit: number | null; // null = ikut global (admin selalu null)
  used: number;
}

interface LimitsData {
  weeklyLimit: number | null;
  users: LimitsUserRow[];
}

function roleBadgeClass(role: string) {
  if (role === "ADMIN") return "bg-red-500/10 text-red-600 dark:text-red-400";
  if (role === "GURU") return "bg-blue-500/10 text-blue-600 dark:text-blue-400";
  return "bg-zinc-500/10 text-zinc-600 dark:text-zinc-400";
}

function roleLabel(role: string) {
  if (role === "ADMIN") return "Admin";
  if (role === "GURU") return "Guru";
  return "Siswa";
}

export function BuilderLimitsPanel() {
  const qc = useQueryClient();

  const limitsQuery = useQuery<LimitsData>({
    queryKey: ["builder-limits"],
    queryFn: async () => {
      const res = await fetch("/api/admin/ai-builder/limits", { cache: "no-store" });
      if (!res.ok) throw new Error("Gagal memuat pengaturan batas proyek");
      return res.json();
    },
  });

  // ── batas global ──
  const [globalInput, setGlobalInput] = useState<string>("");
  const [globalDirty, setGlobalDirty] = useState(false);

  useEffect(() => {
    if (limitsQuery.data && !globalDirty) {
      setGlobalInput(
        limitsQuery.data.weeklyLimit === null ? "" : String(limitsQuery.data.weeklyLimit)
      );
    }
  }, [limitsQuery.data, globalDirty]);

  const saveGlobalMut = useMutation({
    mutationFn: async () => {
      const t = globalInput.trim();
      const v = t === "" ? null : Number(t);
      if (v !== null && (!Number.isFinite(v) || v < 0 || v > 1000)) {
        throw new Error("Isi angka 0–1000, atau kosongkan untuk kembali ke default (5).");
      }
      const res = await fetch("/api/admin/ai-builder/limits", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ weeklyLimit: v }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error || "Gagal menyimpan batas global");
      return json;
    },
    onSuccess: () => {
      toast.success("Batas proyek mingguan global tersimpan.");
      setGlobalDirty(false);
      qc.invalidateQueries({ queryKey: ["builder-limits"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // ── dialog per orang ──
  const [perOpen, setPerOpen] = useState(false);
  const users = limitsQuery.data?.users ?? [];

  return (
    <div className="rounded-xl border bg-card shadow-xs">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border p-4">
        <div className="min-w-0 space-y-1">
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <CalendarClock className="size-4 text-primary" />
            Batas Proyek Mingguan
          </h3>
          <p className="text-xs leading-relaxed text-muted-foreground">
            Batas jumlah proyek AI Builder per siswa per minggu — direset{" "}
            <strong>setiap Senin</strong> pukul 00:00 WIB. Satu proyek = satu sesi
            chat; tercatat walau tidak disimpan. Revisi pada sesi yang sama tidak
            dihitung ulang, dan admin tidak dibatasi.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5"
          onClick={() => setPerOpen(true)}
          disabled={limitsQuery.isLoading}
        >
          <UserRoundCog className="size-3.5" /> Atur per orang
        </Button>
      </div>

      <div className="flex flex-wrap items-end gap-2 p-4">
        <div className="space-y-1">
          <label htmlFor="adm-builder-limit" className="block text-xs font-medium text-muted-foreground">
            Batas global (semua siswa)
          </label>
          <Input
            id="adm-builder-limit"
            type="number"
            min={0}
            max={1000}
            value={globalInput}
            onChange={(e) => {
              setGlobalInput(e.target.value);
              setGlobalDirty(true);
            }}
            placeholder="5"
            disabled={limitsQuery.isLoading || saveGlobalMut.isPending}
            className="h-9 w-32 tabular-nums"
          />
        </div>
        <Button
          size="sm"
          className="gap-1.5"
          onClick={() => saveGlobalMut.mutate()}
          disabled={limitsQuery.isLoading || saveGlobalMut.isPending || !globalDirty}
        >
          {saveGlobalMut.isPending ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : null}
          Simpan batas
        </Button>
        <p className="flex items-center gap-1 text-[11px] text-muted-foreground">
          <Info className="size-3 shrink-0" />
          {limitsQuery.isLoading
            ? "memuat…"
            : limitsQuery.data?.weeklyLimit == null
              ? "belum diatur — default 5 per minggu"
              : `berlaku: ${limitsQuery.data.weeklyLimit} proyek per minggu`}
        </p>
      </div>

      <PerPersonDialog
        open={perOpen}
        onOpenChange={setPerOpen}
        users={users}
        globalLimit={limitsQuery.data?.weeklyLimit ?? null}
        onSaved={() => qc.invalidateQueries({ queryKey: ["builder-limits"] })}
      />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Dialog: batas khusus per orang
// ─────────────────────────────────────────────────────────────────────────

function PerPersonDialog({
  open,
  onOpenChange,
  users,
  globalLimit,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  users: LimitsUserRow[];
  globalLimit: number | null;
  onSaved: () => void;
}) {
  const [search, setSearch] = useState("");
  // userId → isi input (string). "" = ikut global (kosongkan batas khusus).
  const [vals, setVals] = useState<Record<string, string>>({});

  // Reset isi input tiap dialog dibuka (amb nilai segar dari server).
  useEffect(() => {
    if (open) setVals({});
  }, [open]);

  const q = search.trim().toLowerCase();

  // User yang sudah memakai kuota minggu ini SELALU tampil di atas
  // (pinned) — admin gampang melihat siapa yang aktif. Sisanya difilter
  // pencarian nama/username.
  const rows = useMemo(() => {
    const pinned = users.filter((u) => u.used > 0);
    const rest = users.filter((u) => u.used === 0).filter(
      (u) =>
        !q ||
        u.name.toLowerCase().includes(q) ||
        u.username.toLowerCase().includes(q)
    );
    return [...pinned, ...rest];
  }, [users, q]);

  const dirty = useMemo(
    () =>
      users.some((u) => {
        const v = (vals[u.id] ?? "").trim();
        const orig = u.limit === null ? "" : String(u.limit);
        return v !== orig;
      }),
    [users, vals]
  );

  const saveMut = useMutation({
    mutationFn: async () => {
      // Validasi dulu semua nilai yang berubah.
      const changes: { userId: string; limit: number | null }[] = [];
      for (const u of users) {
        if (u.role === "ADMIN") continue;
        const v = (vals[u.id] ?? "").trim();
        const orig = u.limit === null ? "" : String(u.limit);
        if (v === orig) continue;
        if (v === "") {
          changes.push({ userId: u.id, limit: null });
        } else {
          const n = Number(v);
          if (!Number.isFinite(n) || n < 0 || n > 1000) {
            throw new Error(`Nilai untuk @${u.username} harus angka 0–1000 atau kosong.`);
          }
          changes.push({ userId: u.id, limit: Math.floor(n) });
        }
      }
      if (changes.length === 0) return;
      for (const c of changes) {
        const res = await fetch("/api/admin/ai-builder/limits", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userLimit: c }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(json?.error || `Gagal menyimpan batas utk user ${c.userId}`);
        }
      }
    },
    onSuccess: () => {
      toast.success("Batas proyek per orang tersimpan.");
      onSaved();
      onOpenChange(false);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UserRoundCog className="size-5 text-primary" />
            Batas Proyek Per Orang
          </DialogTitle>
          <DialogDescription>
            Batas khusus menimpa batas global untuk orang tersebut. Kolom
            kosong = ikut global{" "}
            {globalLimit === null ? "(default 5)" : `(${globalLimit})`}. Admin
            tidak dibatasi. Baris bertanda pin adalah user yang sudah membuat
            proyek minggu ini.
          </DialogDescription>
        </DialogHeader>

        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Cari nama / username…"
            className="pl-8 h-9"
          />
        </div>

        <div className="relative h-[46vh] min-h-0 shrink rounded-lg border border-border">
          <ScrollArea className="absolute! inset-0">
            <div className="divide-y divide-border">
              {rows.map((u) => (
                <div
                  key={u.id}
                  className={cn(
                    "flex items-center gap-3 px-3 py-2",
                    u.used > 0 && "bg-primary/5"
                  )}
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium leading-tight">
                      {u.name}{" "}
                      {u.used > 0 ? (
                        <span
                          title="Sudah membuat proyek minggu ini"
                          className="ml-0.5 align-middle text-primary"
                        >
                          📌
                        </span>
                      ) : null}
                    </p>
                    <p className="text-[11px] text-muted-foreground truncate">
                      @{u.username} · pakai {u.used} proyek minggu ini
                    </p>
                  </div>
                  <Badge
                    className={cn("border-0 text-[10px] shrink-0", roleBadgeClass(u.role))}
                  >
                    {roleLabel(u.role)}
                  </Badge>
                  {u.role === "ADMIN" ? (
                    <Badge className="border-0 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 shrink-0">
                      bebas
                    </Badge>
                  ) : (
                    <Input
                      type="number"
                      min={0}
                      max={1000}
                      value={vals[u.id] ?? ""}
                      onChange={(e) =>
                        setVals((prev) => ({ ...prev, [u.id]: e.target.value }))
                      }
                      placeholder="ikut global"
                      disabled={saveMut.isPending}
                      className="h-8 w-28 shrink-0 tabular-nums"
                    />
                  )}
                </div>
              ))}
              {rows.length === 0 ? (
                <div className="py-8 text-center text-sm text-muted-foreground">
                  Tidak ada user yang cocok.
                </div>
              ) : null}
            </div>
          </ScrollArea>
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saveMut.isPending}>
            Tutup
          </Button>
          <Button
            onClick={() => saveMut.mutate()}
            disabled={saveMut.isPending || !dirty}
            className="gap-1.5"
          >
            {saveMut.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
            Simpan
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
