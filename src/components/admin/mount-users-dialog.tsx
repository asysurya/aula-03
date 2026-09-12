"use client";

// ─────────────────────────────────────────────────────────────────────────
// Dialog editor izin PER ORANG untuk satu akun cloud (mount MEGA).
//
// Melengkapi izin per-PERAN (mountVisibleTo/mountMode) pada panel yang sama:
// orang yang dicentang di sini tetap boleh MEMBUKA mount walau perannya
// tidak termasuk — dan bisa diberi hak TULIS khusus (menimpa mode baca-saja
// akun). Grant bersifat TAMBAHAN: tidak pernah memangkas hak dari peran.
//
// Sumber data user: GET /api/users (direktori semua user).
// Simpan: PATCH /api/admin/cloud-accounts/:id { mountUserIds,
// mountUserWriteIds } — server memvalidasi bahwa semua id user dikenal.
// ─────────────────────────────────────────────────────────────────────────

import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2, Search, ShieldCheck, UserPlus, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
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

interface UserRow {
  id: string;
  username: string;
  name: string;
  role: string;
  avatarColor?: string;
  avatarUrl?: string | null;
}

export interface MountUsersTarget {
  id: string;
  name: string;
  provider?: string;
  mountVisibleTo?: "ADMIN" | "GURU" | "ALL" | null;
  mountMode?: "READ" | "WRITE" | null;
  mountUserIds?: string[];
  mountUserWriteIds?: string[];
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

export function MountUsersDialog({
  account,
  onClose,
  onSaved,
}: {
  account: MountUsersTarget;
  onClose: () => void;
  onSaved: () => void;
}) {
  // userId → boleh menulis? (masuk daftar = boleh membuka)
  const [grants, setGrants] = useState<Record<string, boolean>>(() => {
    const g: Record<string, boolean> = {};
    for (const id of account.mountUserIds ?? []) {
      g[id] = (account.mountUserWriteIds ?? []).includes(id);
    }
    for (const id of account.mountUserWriteIds ?? []) g[id] = true;
    return g;
  });
  const [search, setSearch] = useState("");

  const usersQuery = useQuery<{ users: UserRow[] }>({
    queryKey: ["users-directory"],
    queryFn: async () => {
      const res = await fetch("/api/users", { cache: "no-store" });
      if (!res.ok) throw new Error("Gagal memuat daftar user");
      return res.json();
    },
  });

  const users = usersQuery.data?.users ?? [];
  const q = search.trim().toLowerCase();

  // Yang sudah di-grant selalu tampil di atas (walau tidak cocok pencarian),
  // sisanya difilter pencarian.
  const rows = useMemo(() => {
    const granted = users.filter((u) => grants[u.id] !== undefined);
    const rest = users
      .filter((u) => grants[u.id] === undefined)
      .filter(
        (u) =>
          !q ||
          u.name.toLowerCase().includes(q) ||
          u.username.toLowerCase().includes(q)
      );
    return { granted, rest };
  }, [users, grants, q]);

  const grantedCount = Object.keys(grants).length;
  const writeCount = Object.values(grants).filter(Boolean).length;
  const dirty = useMemo(() => {
    const origIds = new Set([
      ...(account.mountUserIds ?? []),
      ...(account.mountUserWriteIds ?? []),
    ]);
    const nowIds = new Set(Object.keys(grants));
    if (origIds.size !== nowIds.size) return true;
    for (const id of nowIds) if (!origIds.has(id)) return true;
    // bandingkan mode tulis
    for (const [id, canWrite] of Object.entries(grants)) {
      const origWrite = (account.mountUserWriteIds ?? []).includes(id);
      if (canWrite !== origWrite) return true;
    }
    return false;
  }, [grants, account]);

  const saveMut = useMutation({
    mutationFn: async () => {
      const ids = Object.keys(grants);
      const res = await fetch(`/api/admin/cloud-accounts/${account.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mountUserIds: ids,
          mountUserWriteIds: ids.filter((id) => grants[id]),
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error || "Gagal menyimpan izin per orang");
      return json;
    },
    onSuccess: () => {
      toast.success(
        grantedCount === 0
          ? "Izin per orang dikosongkan"
          : `Izin per orang disimpan: ${grantedCount} orang (${writeCount} bisa menulis)`
      );
      onSaved();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  function toggleGrant(user: UserRow) {
    setGrants((prev) => {
      const next = { ...prev };
      if (next[user.id] !== undefined) delete next[user.id];
      else next[user.id] = false;
      return next;
    });
  }

  function toggleWrite(userId: string) {
    setGrants((prev) => ({
      ...prev,
      [userId]: !prev[userId],
    }));
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldCheck className="size-5 text-primary" />
            Izin Per Orang — {account.name}
          </DialogTitle>
          <DialogDescription>
            Orang yang dicentang tetap bisa membuka mount ini walau perannya
            tidak termasuk. Centang &ldquo;bisa menulis&rdquo; untuk memberi
            hak unggah/ubah (menimpa mode baca-saja akun). Izin ini hanya
            MENAMBAH — tidak pernah memangkas hak yang berasal dari peran.
          </DialogDescription>
        </DialogHeader>

        {/* Ringkasan + pencarian */}
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>
              {grantedCount === 0 ? (
                "Belum ada orang khusus — akses mengikuti peran."
              ) : (
                <>
                  <span className="font-medium text-foreground">
                    {grantedCount} orang
                  </span>{" "}
                  diizinkan khusus · {writeCount} bisa menulis
                </>
              )}
            </span>
            {dirty ? (
              <Badge className="bg-amber-500/15 text-amber-600 dark:text-amber-400 border-0">
                ada perubahan
              </Badge>
            ) : null}
          </div>
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Cari nama / username…"
              className="pl-8 h-9"
            />
          </div>
        </div>

        {/* Daftar user */}
        <div className="flex-1 min-h-0">
          {usersQuery.isLoading ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin inline mr-2" />
              Memuat daftar user…
            </div>
          ) : usersQuery.error ? (
            <div className="py-8 text-center text-sm text-destructive">
              Gagal memuat user.{" "}
              <Button variant="link" onClick={() => usersQuery.refetch()}>
                Coba lagi
              </Button>
            </div>
          ) : (
            <ScrollArea className="h-[46vh] rounded-lg border border-border">
              <div className="divide-y divide-border">
                {rows.granted.length > 0 ? (
                  <div className="px-2 py-1.5 bg-muted/50">
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground px-2">
                      Diizinkan khusus ({rows.granted.length})
                    </p>
                  </div>
                ) : null}
                {rows.granted.map((u) => (
                  <UserGrantRow
                    key={u.id}
                    user={u}
                    granted
                    canWrite={grants[u.id]}
                    onToggle={() => toggleGrant(u)}
                    onToggleWrite={() => toggleWrite(u.id)}
                  />
                ))}
                {rows.rest.length > 0 ? (
                  <div className="px-2 py-1.5 bg-muted/50">
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground px-2">
                      Semua user {q ? `(cocok pencarian)` : ""}
                    </p>
                  </div>
                ) : null}
                {rows.rest.map((u) => (
                  <UserGrantRow
                    key={u.id}
                    user={u}
                    granted={false}
                    canWrite={false}
                    onToggle={() => toggleGrant(u)}
                    onToggleWrite={() => toggleWrite(u.id)}
                  />
                ))}
                {rows.granted.length === 0 && rows.rest.length === 0 ? (
                  <div className="py-8 text-center text-sm text-muted-foreground">
                    Tidak ada user yang cocok.
                  </div>
                ) : null}
              </div>
            </ScrollArea>
          )}
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" onClick={onClose} disabled={saveMut.isPending}>
            Batal
          </Button>
          <Button
            onClick={() => saveMut.mutate()}
            disabled={!dirty || saveMut.isPending || usersQuery.isLoading}
            className="gap-1.5"
          >
            {saveMut.isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <ShieldCheck className="size-4" />
            )}
            Simpan
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function UserGrantRow({
  user,
  granted,
  canWrite,
  onToggle,
  onToggleWrite,
}: {
  user: UserRow;
  granted: boolean;
  canWrite: boolean;
  onToggle: () => void;
  onToggleWrite: () => void;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-3 px-3 py-2",
        granted && "bg-primary/5"
      )}
    >
      <button
        type="button"
        onClick={onToggle}
        className={cn(
          "flex size-7 shrink-0 items-center justify-center rounded-md border transition-colors",
          granted
            ? "bg-primary text-primary-foreground border-primary"
            : "border-input hover:bg-accent"
        )}
        title={granted ? "Hapus izin khusus" : "Izinkan membuka mount ini"}
        aria-label={granted ? `Hapus izin ${user.name}` : `Izinkan ${user.name}`}
      >
        {granted ? <X className="size-3.5" /> : <UserPlus className="size-3.5" />}
      </button>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium truncate leading-tight">
          {user.name}
        </p>
        <p className="text-[11px] text-muted-foreground truncate">
          @{user.username}
        </p>
      </div>
      <Badge
        className={cn("border-0 text-[10px] shrink-0", roleBadgeClass(user.role))}
      >
        {roleLabel(user.role)}
      </Badge>
      {granted ? (
        <label
          className="flex items-center gap-1.5 shrink-0 cursor-pointer select-none"
          title="Bisa menulis (unggah/ubah) — menimpa mode baca-saja akun"
        >
          <span className="text-[11px] text-muted-foreground hidden sm:inline">
            bisa menulis
          </span>
          <Switch checked={canWrite} onCheckedChange={onToggleWrite} />
        </label>
      ) : null}
    </div>
  );
}
