"use client";

// Kartu tugas di dalam bubble pesan — tampil kaya: judul, kelas, tenggat
// live-countdown, jumlah soal, dan tombol "Buka Tugas" yang melompat ke
// folder tugas di halaman Cloud.

import { useEffect, useState } from "react";
import { format } from "date-fns";
import { id as localeId } from "date-fns/locale";
import {
  AlertTriangle,
  CalendarClock,
  ClipboardList,
  ListChecks,
  Lock,
  ExternalLink,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useUIStore } from "@/stores/ui-store";
import type { AssignmentCard } from "./types";
import { cn } from "@/lib/utils";

function countdownText(deadline: string): { text: string; urgent: boolean } {
  const ms = new Date(deadline).getTime() - Date.now();
  if (ms < 0) return { text: "Tenggat sudah lewat", urgent: true };
  const m = Math.floor(ms / 60000);
  if (m < 60) return { text: `${m} menit lagi`, urgent: true };
  const h = Math.floor(m / 60);
  if (h < 24) return { text: `${h} jam lagi`, urgent: h < 24 };
  const d = Math.floor(h / 24);
  return { text: `${d} hari lagi`, urgent: false };
}

export function AssignmentCardView({
  assignment,
  deleted,
}: {
  assignment: AssignmentCard | null;
  deleted: boolean;
}) {
  const openCloudFolder = useUIStore((s) => s.openCloudFolder);
  const [, setTick] = useState(0);

  // Refresh countdown tiap 30 dtk.
  useEffect(() => {
    if (!assignment) return;
    const t = setInterval(() => setTick((x) => x + 1), 30_000);
    return () => clearInterval(t);
  }, [assignment]);

  if (deleted && !assignment) {
    return (
      <div className="mt-1.5 flex items-center gap-2.5 rounded-lg border border-border bg-muted/40 px-3 py-2.5 max-w-full opacity-70">
        <AlertTriangle className="size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <p className="text-xs font-medium">Tugas terlampir sudah dihapus</p>
          <p className="text-[10px] text-muted-foreground">
            Tugas ini tidak lagi tersedia di cloud kelas.
          </p>
        </div>
      </div>
    );
  }
  if (!assignment) return null;

  const cd = countdownText(assignment.deadline);
  const overdue = assignment.deadlinePassed;

  return (
    <div
      className={cn(
        "mt-1.5 rounded-lg border max-w-full overflow-hidden",
        overdue
          ? "border-border bg-muted/30"
          : "border-primary/30 bg-primary/5"
      )}
    >
      <div className="flex items-start gap-3 p-3">
        <div
          className={cn(
            "rounded-md p-2.5 shrink-0",
            overdue ? "bg-muted text-muted-foreground" : "bg-primary/15 text-primary"
          )}
        >
          <ClipboardList className="size-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 flex-wrap">
            <p className="text-sm font-semibold truncate">{assignment.title}</p>
            {overdue ? (
              <Badge variant="secondary" className="text-[9px]">
                ditutup
              </Badge>
            ) : (
              <Badge className="bg-primary/15 text-primary border-transparent text-[9px]">
                tugas
              </Badge>
            )}
          </div>
          <p className="text-[11px] text-muted-foreground flex items-center gap-1 mt-0.5">
            <CalendarClock className="size-3 shrink-0" />
            {format(new Date(assignment.deadline), "d MMM yyyy HH:mm", {
              locale: localeId,
            })}
            <span className={cn("font-medium", overdue ? "" : cd.urgent ? "text-destructive" : "text-primary")}>
              · {cd.text}
            </span>
          </p>
          {assignment.questionCount != null || assignment.maxScore != null ? (
            <p className="text-[11px] text-muted-foreground flex items-center gap-1 mt-0.5">
              <ListChecks className="size-3 shrink-0" />
              {assignment.questionCount != null
                ? `${assignment.questionCount} soal`
                : "tugas unggahan"}
              {assignment.maxScore != null ? ` · maks ${assignment.maxScore}` : ""}
            </p>
          ) : null}
        </div>
      </div>
      <button
        type="button"
        onClick={() => openCloudFolder(assignment.folderId)}
        className="flex items-center justify-center gap-1.5 w-full border-t border-border/60 bg-background/60 hover:bg-accent/60 px-3 py-2 text-xs font-medium text-primary transition-colors"
        title="Buka tugas ini di halaman Cloud & Tugas"
      >
        <ExternalLink className="size-3.5" />
        Buka Tugas
        <Lock className="size-3 opacity-0" />
      </button>
    </div>
  );
}

// Tombol util untuk dipakai dialog lain (konsisten gaya).
export function AssignmentLinkButton({ folderId }: { folderId: string }) {
  const openCloudFolder = useUIStore((s) => s.openCloudFolder);
  return (
    <Button
      size="sm"
      variant="outline"
      className="h-8 gap-1.5"
      onClick={() => openCloudFolder(folderId)}
    >
      <ExternalLink className="size-3.5" /> Buka
    </Button>
  );
}
