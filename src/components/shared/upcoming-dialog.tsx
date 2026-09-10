"use client";

// Jadwal Tugas — agenda tenggat semua tugas dari semua kelas yang diikuti,
// dikelompokkan (Terlambat / Hari ini / Besok / Minggu ini / Nanti),
// lengkap dengan status pengerjaan + tombol buka.

import { useQuery } from "@tanstack/react-query";
import { format, isToday, isTomorrow } from "date-fns";
import { id as localeId } from "date-fns/locale";
import {
  AlertTriangle,
  CalendarDays,
  CheckCircle2,
  ClipboardList,
  ExternalLink,
  Hourglass,
  Loader2,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useUIStore } from "@/stores/ui-store";
import { cn } from "@/lib/utils";

interface UpcomingItem {
  id: string;
  folderId: string;
  title: string;
  deadline: string;
  maxScore: number | null;
  classroomName: string;
  hasForm: boolean;
  deadlinePassed: boolean;
  myStatus: "NOT_STARTED" | "IN_PROGRESS" | "SUBMITTED";
}

function countdown(deadline: string): { text: string; urgent: boolean } {
  const ms = new Date(deadline).getTime() - Date.now();
  if (ms < 0) return { text: "sudah lewat", urgent: true };
  const m = Math.floor(ms / 60000);
  if (m < 60) return { text: `${m} menit`, urgent: true };
  const h = Math.floor(m / 60);
  if (h < 24) return { text: `${h} jam`, urgent: h <= 6 };
  return { text: `${Math.floor(h / 24)} hari`, urgent: false };
}

export function UpcomingDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const openCloudFolder = useUIStore((s) => s.openCloudFolder);
  const { data, isLoading } = useQuery<{ items: UpcomingItem[] }>({
    queryKey: ["cloud", "assignments-upcoming"],
    queryFn: async () => {
      const res = await fetch("/api/cloud/assignments/upcoming", {
        cache: "no-store",
      });
      if (!res.ok) throw new Error("Gagal memuat jadwal tugas");
      return res.json();
    },
    enabled: open,
  });

  const items = data?.items ?? [];
  const overdue = items.filter((i) => i.deadlinePassed);
  const today = items.filter((i) => !i.deadlinePassed && isToday(new Date(i.deadline)));
  const tomorrow = items.filter(
    (i) => !i.deadlinePassed && isTomorrow(new Date(i.deadline))
  );
  const soon = items.filter((i) => {
    const d = new Date(i.deadline);
    return (
      !i.deadlinePassed && !isToday(d) && !isTomorrow(d) && d.getTime() < Date.now() + 7 * 86400_000
    );
  });
  const later = items.filter((i) => {
    const d = new Date(i.deadline);
    return (
      !i.deadlinePassed && !isToday(d) && !isTomorrow(d) && d.getTime() >= Date.now() + 7 * 86400_000
    );
  });

  function ItemRow({ item }: { item: UpcomingItem }) {
    const cd = countdown(item.deadline);
    return (
      <button
        type="button"
        onClick={() => {
          onOpenChange(false);
          openCloudFolder(item.folderId);
        }}
        className="flex items-center gap-3 w-full px-3 py-2.5 text-left hover:bg-accent/50 transition-colors"
      >
        <div
          className={cn(
            "rounded-md p-2 shrink-0",
            item.deadlinePassed
              ? "bg-muted text-muted-foreground"
              : "bg-primary/10 text-primary"
          )}
        >
          <ClipboardList className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium truncate">{item.title}</p>
          <p className="text-[10px] text-muted-foreground truncate">
            {item.classroomName} ·{" "}
            {format(new Date(item.deadline), "EEE d MMM, HH:mm", {
              locale: localeId,
            })}
          </p>
        </div>
        <div className="flex flex-col items-end gap-1 shrink-0">
          {item.myStatus === "SUBMITTED" ? (
            <Badge className="bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-transparent text-[9px] gap-1">
              <CheckCircle2 className="size-3" /> selesai
            </Badge>
          ) : item.myStatus === "IN_PROGRESS" ? (
            <Badge className="bg-amber-500/15 text-amber-600 dark:text-amber-400 border-transparent text-[9px] gap-1">
              <Hourglass className="size-3" /> berlangsung
            </Badge>
          ) : item.deadlinePassed ? (
            <Badge variant="secondary" className="text-[9px] gap-1">
              <XCircle className="size-3" /> belum dikerjakan
            </Badge>
          ) : (
            <Badge
              variant="outline"
              className={cn("text-[9px]", cd.urgent && "text-destructive")}
            >
              {cd.text}
            </Badge>
          )}
          <span className="text-[9px] text-muted-foreground inline-flex items-center gap-0.5">
            <ExternalLink className="size-2.5" /> buka
          </span>
        </div>
      </button>
    );
  }

  function Section({
    title,
    arr,
    icon,
  }: {
    title: string;
    arr: UpcomingItem[];
    icon: React.ReactNode;
  }) {
    if (arr.length === 0) return null;
    return (
      <div>
        <p className="px-3 pt-3 pb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-1.5">
          {icon} {title} ({arr.length})
        </p>
        <div className="divide-y divide-border">
          {arr.map((i) => (
            <ItemRow key={i.id} item={i} />
          ))}
        </div>
      </div>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CalendarDays className="size-5 text-primary" /> Jadwal Tugas
          </DialogTitle>
          <DialogDescription>
            Agenda tenggat dari semua kelasmu — termasuk status pengerjaanmu.
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 min-h-0 overflow-y-auto rounded-lg border border-border">
          {isLoading ? (
            <div className="p-3 space-y-2">
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </div>
          ) : items.length === 0 ? (
            <div className="p-6 text-center text-sm text-muted-foreground">
              <CalendarDays className="size-6 mx-auto mb-2 opacity-40" />
              Tidak ada tugas yang menunggu — santai dulu!
            </div>
          ) : (
            <>
              <Section
                title="Terlambat"
                arr={overdue}
                icon={<AlertTriangle className="size-3 text-destructive" />}
              />
              <Section
                title="Hari ini"
                arr={today}
                icon={<CalendarDays className="size-3 text-primary" />}
              />
              <Section
                title="Besok"
                arr={tomorrow}
                icon={<CalendarDays className="size-3" />}
              />
              <Section
                title="Minggu ini"
                arr={soon}
                icon={<CalendarDays className="size-3" />}
              />
              <Section
                title="Nanti"
                arr={later}
                icon={<CalendarDays className="size-3 opacity-50" />}
              />
            </>
          )}
        </div>

        <p className="text-[10px] text-muted-foreground flex items-center gap-1">
          <Loader2 className="size-3 opacity-0" />
          Klik tugas untuk membukanya di Cloud &amp; Tugas.
        </p>
      </DialogContent>
    </Dialog>
  );
}
