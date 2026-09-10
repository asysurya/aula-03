"use client";

// Dialog "Lampirkan Tugas" — pilih tugas dari semua kelas yang diikuti
// untuk dibagikan sebagai kartu di dalam pesan chat.

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { id as localeId } from "date-fns/locale";
import {
  CalendarClock,
  ClipboardList,
  ListChecks,
  Loader2,
  Search,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { AssignmentCard } from "./types";
import { cn } from "@/lib/utils";

export function AssignmentAttachDialog({
  open,
  onOpenChange,
  onAttach,
  currentAssignmentId,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onAttach: (assignment: AssignmentCard) => void;
  currentAssignmentId: string | null;
}) {
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");

  useEffect(() => {
    const t = setTimeout(() => setQ(search.trim().toLowerCase()), 250);
    return () => clearTimeout(t);
  }, [search]);

  const { data, isLoading, error } = useQuery<{ assignments: AssignmentCard[] }>({
    queryKey: ["chat-assignments-picker", q],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (q) params.set("q", q);
      const res = await fetch(
        `/api/chat/assignments/picker?${params.toString()}`,
        { cache: "no-store" }
      );
      if (!res.ok) throw new Error("Gagal memuat daftar tugas");
      return res.json();
    },
    enabled: open,
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ClipboardList className="size-5 text-primary" /> Lampirkan Tugas
          </DialogTitle>
          <DialogDescription>
            Bagikan tugas sebagai kartu di pesan — penerima bisa langsung
            membuka tugasnya dari kartu ini.
          </DialogDescription>
        </DialogHeader>

        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Cari judul tugas…"
            className="pl-8 h-9"
          />
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto rounded-lg border border-border divide-y divide-border">
          {isLoading ? (
            <div className="p-3 space-y-2">
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </div>
          ) : error || !data ? (
            <div className="p-4 text-center text-sm text-destructive">
              Gagal memuat daftar tugas.
            </div>
          ) : data.assignments.length === 0 ? (
            <div className="p-6 text-center text-sm text-muted-foreground">
              <ClipboardList className="size-6 mx-auto mb-2 opacity-50" />
              {q
                ? `Tidak ada tugas yang cocok dengan "${q}".`
                : "Belum ada tugas di kelas-kelasmu — guru membuat tugas lewat halaman Cloud."}
            </div>
          ) : (
            data.assignments.map((a) => (
              <button
                key={a.id}
                type="button"
                disabled={a.id === currentAssignmentId}
                onClick={() => {
                  onAttach(a);
                  onOpenChange(false);
                }}
                className={cn(
                  "flex items-center gap-3 w-full px-3 py-2.5 text-left transition-colors",
                  a.id === currentAssignmentId
                    ? "opacity-40 cursor-not-allowed"
                    : "hover:bg-accent/50"
                )}
              >
                <div
                  className={cn(
                    "rounded-md p-2 shrink-0",
                    a.deadlinePassed
                      ? "bg-muted text-muted-foreground"
                      : "bg-primary/10 text-primary"
                  )}
                >
                  <ListChecks className="size-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium truncate">{a.title}</p>
                  <p className="text-[10px] text-muted-foreground truncate flex items-center gap-1">
                    <CalendarClock className="size-3" />
                    {a.classroomName ? `${a.classroomName} · ` : ""}
                    {format(new Date(a.deadline), "d MMM yyyy HH:mm", {
                      locale: localeId,
                    })}
                    {a.questionCount != null ? ` · ${a.questionCount} soal` : ""}
                  </p>
                </div>
                {a.deadlinePassed ? (
                  <Badge variant="secondary" className="text-[10px] shrink-0">
                    lewat
                  </Badge>
                ) : (
                  <Badge variant="outline" className="text-[10px] shrink-0">
                    tugas
                  </Badge>
                )}
              </button>
            ))
          )}
        </div>

        <DialogFooter>
          <span className="text-xs text-muted-foreground mr-auto flex items-center gap-1">
            <Loader2 className="size-3 opacity-0" />
            1 tugas per pesan
          </span>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            <X className="size-3.5 mr-1" /> Tutup
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
