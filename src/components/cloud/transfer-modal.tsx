"use client";

// Modal Manajer Transfer — tombol di header halaman Cloud.
// Menampilkan semua job upload/download yang berjalan di background:
// progress bar (di-update tiap 1 detik oleh store), kontrol pause/resume,
// cancel, retry, atur urutan antrean (naik/turun), dan bersihkan riwayat.

import { useState } from "react";
import { useTransferStore, transferStats, type TransferJob } from "@/lib/transfer-store";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Check,
  Download,
  Loader2,
  Pause,
  Play,
  RotateCcw,
  Trash2,
  Upload,
  X,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { formatBytes } from "@/lib/cloud-format";

// ───────────────────────── Tombol header + modal ─────────────────────────

export function TransferManagerButton() {
  const [open, setOpen] = useState(false);
  const jobs = useTransferStore((s) => s.jobs);
  const { active, queued, totalActivePct } = transferStats(jobs);
  const pending = active.length + queued.length;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          size="sm"
          variant="outline"
          className="relative gap-1.5"
          title="Manajer transfer — upload & download di latar belakang"
        >
          <ArrowUpDown className="size-4" />
          <span className="hidden sm:inline">Transfer</span>
          {pending > 0 ? (
            <span className="absolute -top-1.5 -right-1.5 min-w-4 h-4 px-1 rounded-full bg-primary text-primary-foreground text-[10px] font-semibold flex items-center justify-center tabular-nums">
              {pending}
            </span>
          ) : null}
          {active.length > 0 ? (
            <span className="hidden md:inline text-[10px] text-muted-foreground tabular-nums">
              {totalActivePct}%
            </span>
          ) : null}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg max-h-[85vh] flex flex-col p-0 gap-0 overflow-hidden">
        <DialogHeader className="px-4 py-3 border-b border-border">
          <DialogTitle className="flex items-center gap-2 text-base">
            <ArrowUpDown className="size-4" /> Manajer Transfer
          </DialogTitle>
          <DialogDescription>
            Upload dan download berjalan di latar belakang — progress bar
            diperbarui setiap 1 detik. Atur antrean: jeda, lanjutkan, batalkan,
            atau ubah urutan.
          </DialogDescription>
        </DialogHeader>
        <TransferList />
      </DialogContent>
    </Dialog>
  );
}

// ───────────────────────── Daftar job ─────────────────────────

function TransferList() {
  const jobs = useTransferStore((s) => s.jobs);
  const clearFinished = useTransferStore((s) => s.clearFinished);
  const [filter, setFilter] = useState<"all" | "upload" | "download">("all");

  const filtered = jobs.filter((j) =>
    filter === "all" ? true : j.kind === filter
  );
  const finishedCount = jobs.filter((j) =>
    j.status === "done" || j.status === "cancelled" || j.status === "error"
  ).length;

  return (
    <div className="flex flex-col min-h-0 flex-1">
      <div className="px-4 py-2 flex items-center gap-2 border-b border-border">
        <Tabs
          value={filter}
          onValueChange={(v) => setFilter(v as "all" | "upload" | "download")}
        >
          <TabsList className="h-8">
            <TabsTrigger value="all" className="text-xs">
              Semua ({jobs.length})
            </TabsTrigger>
            <TabsTrigger value="upload" className="text-xs">
              Unggah
            </TabsTrigger>
            <TabsTrigger value="download" className="text-xs">
              Unduh
            </TabsTrigger>
          </TabsList>
        </Tabs>
        {finishedCount > 0 ? (
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto h-7 text-xs"
            onClick={clearFinished}
          >
            <Trash2 className="size-3.5" /> Bersihkan selesai
          </Button>
        ) : null}
      </div>

      <ScrollArea className="flex-1 min-h-0">
        {filtered.length === 0 ? (
          <div className="p-10 text-center">
            <ArrowUpDown className="size-10 mx-auto text-muted-foreground/40 mb-3" />
            <p className="text-sm font-medium">Tidak ada transfer</p>
            <p className="text-xs text-muted-foreground mt-1">
              Unggah file atau unduh dari pratinjau — prosesnya muncul di sini
              dan berjalan di latar belakang.
            </p>
          </div>
        ) : (
          <div className="p-2 space-y-1.5">
            {filtered.map((j) => (
              <TransferRow key={j.id} job={j} />
            ))}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}

// ───────────────────────── Baris job ─────────────────────────

const STATUS_LABEL: Record<TransferJob["status"], string> = {
  queued: "Di antrean",
  active: "Berjalan",
  paused: "Dijeda",
  done: "Selesai",
  error: "Gagal",
  cancelled: "Dibatalkan",
};

function TransferRow({ job }: { job: TransferJob }) {
  const pauseJob = useTransferStore((s) => s.pauseJob);
  const resumeJob = useTransferStore((s) => s.resumeJob);
  const cancelJob = useTransferStore((s) => s.cancelJob);
  const retryJob = useTransferStore((s) => s.retryJob);
  const removeJob = useTransferStore((s) => s.removeJob);
  const moveJob = useTransferStore((s) => s.moveJob);

  const pct =
    job.size > 0 ? Math.min(100, Math.round((job.loaded / job.size) * 100)) : null;
  // Fase finalisasi upload: semua byte terkirim, server sedang merakit chunk
  // & menyimpan ke cloud (complete) — tampilkan pengganti speed/ETA.
  const isFinalizing =
    job.status === "active" &&
    (job.phase === "finalizing" ||
      (job.kind === "upload" && job.size > 0 && job.loaded >= job.size));
  const speedText =
    !isFinalizing && job.status === "active" && job.speed > 0
      ? `${formatBytes(job.speed)}/dtk`
      : "";
  // ETA hanya dihitung saat speed valid (>0) — tidak pernah NaN/Infinity.
  const etaText =
    !isFinalizing && job.status === "active" && job.speed > 0 && job.size > job.loaded
      ? `± ${etaFormat((job.size - job.loaded) / job.speed)}`
      : "";

  const isUp = job.kind === "upload";

  return (
    <div
      className={cn(
        "rounded-lg border px-3 py-2 flex gap-2.5 items-center",
        job.status === "done"
          ? "border-emerald-500/30 bg-emerald-500/5"
          : job.status === "error"
            ? "border-destructive/30 bg-destructive/5"
            : job.status === "cancelled"
              ? "border-border bg-muted/40 opacity-80"
              : "border-border bg-card/60"
      )}
    >
      {/* Ikon arah + spinner */}
      <span
        className={cn(
          "shrink-0 rounded-md p-1.5",
          isUp ? "bg-primary/10 text-primary" : "bg-blue-500/10 text-blue-500"
        )}
      >
        {job.status === "active" ? (
          <Loader2 className="size-4 animate-spin" />
        ) : isUp ? (
          <Upload className="size-4" />
        ) : (
          <Download className="size-4" />
        )}
      </span>

      {/* Info + progress */}
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <p className="text-sm font-medium truncate flex-1" title={job.name}>
            {job.name}
          </p>
          <Badge
            variant="outline"
            className={cn(
              "text-[10px] shrink-0",
              job.status === "done"
                ? "text-emerald-600 border-emerald-500/40"
                : job.status === "error"
                  ? "text-destructive border-destructive/40"
                  : job.status === "active"
                    ? "text-primary border-primary/40"
                    : ""
            )}
          >
            {STATUS_LABEL[job.status]}
          </Badge>
        </div>

        {job.status === "error" && job.error ? (
          <p className="text-[11px] text-destructive/90 truncate mt-0.5" title={job.error}>
            {job.error}
          </p>
        ) : null}

        <div className="flex items-center gap-2 mt-1 text-[11px] text-muted-foreground">
          <span className="tabular-nums">
            {job.status === "done"
              ? formatBytes(job.size || job.loaded)
              : `${formatBytes(job.loaded)}${
                  job.size > 0 ? ` / ${formatBytes(job.size)}` : ""
                }`}
          </span>
          {pct !== null && job.status !== "done" ? (
            <span className="tabular-nums">{pct}%</span>
          ) : null}
          {isFinalizing ? (
            <span className="text-primary/80">Menyimpan ke cloud…</span>
          ) : null}
          {speedText ? <span className="tabular-nums">{speedText}</span> : null}
          {etaText ? <span className="tabular-nums">{etaText}</span> : null}
          <span className="ml-auto text-[10px] opacity-70 shrink-0">{job.context}</span>
        </div>

        {(job.status === "active" || job.status === "paused") && job.size > 0 ? (
          <Progress
            value={pct ?? 0}
            className="h-1.5 mt-1.5"
          />
        ) : null}
      </div>

      {/* Kontrol */}
      <div className="flex items-center gap-0.5 shrink-0">
        {job.status === "queued" || job.status === "active" ? (
          <Button
            size="icon"
            variant="ghost"
            className="size-7"
            title="Jeda"
            onClick={() => pauseJob(job.id)}
          >
            <Pause className="size-3.5" />
          </Button>
        ) : null}
        {job.status === "paused" ? (
          <Button
            size="icon"
            variant="ghost"
            className="size-7"
            title="Lanjutkan"
            onClick={() => resumeJob(job.id)}
          >
            <Play className="size-3.5" />
          </Button>
        ) : null}
        {job.status === "error" ? (
          <Button
            size="icon"
            variant="ghost"
            className="size-7"
            title="Coba lagi"
            onClick={() => retryJob(job.id)}
          >
            <RotateCcw className="size-3.5" />
          </Button>
        ) : null}
        {job.status === "queued" || job.status === "paused" ? (
          <>
            <Button
              size="icon"
              variant="ghost"
              className="size-7"
              title="Naikkan urutan"
              onClick={() => moveJob(job.id, -1)}
            >
              <ArrowUp className="size-3.5" />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              className="size-7"
              title="Turunkan urutan"
              onClick={() => moveJob(job.id, 1)}
            >
              <ArrowDown className="size-3.5" />
            </Button>
          </>
        ) : null}
        {job.status === "queued" ||
        job.status === "active" ||
        job.status === "paused" ? (
          <Button
            size="icon"
            variant="ghost"
            className="size-7 text-destructive hover:text-destructive"
            title="Batalkan"
            onClick={() => {
              cancelJob(job.id);
              toast.info(`Transfer dibatalkan: ${job.name}`);
            }}
          >
            <XCircle className="size-3.5" />
          </Button>
        ) : (
          <Button
            size="icon"
            variant="ghost"
            className="size-7"
            title="Hapus dari daftar"
            onClick={() => removeJob(job.id)}
          >
            <X className="size-3.5" />
          </Button>
        )}
        {job.status === "done" ? (
          <Check className="size-4 text-emerald-500 shrink-0 ml-0.5" />
        ) : null}
      </div>
    </div>
  );
}

function etaFormat(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "—";
  if (seconds < 60) return `${Math.ceil(seconds)} dtk`;
  if (seconds < 3600) return `${Math.ceil(seconds / 60)} mnt`;
  return `${Math.ceil(seconds / 3600)} jam`;
}
