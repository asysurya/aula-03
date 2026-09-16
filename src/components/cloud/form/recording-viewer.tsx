"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { format } from "date-fns";
import { toast } from "sonner";
import {
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Pause,
  Play,
  Radio,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { buildRecordingDoc } from "@/lib/rec-snapshot";
import type {
  FormRecordingDTO,
  FormRecordingFrameDTO,
} from "@/lib/form-types";
import { cn } from "@/lib/utils";

interface FramesResponse {
  recording: FormRecordingDTO;
  frames: FormRecordingFrameDTO[];
  hasMore: boolean;
}

// ── Viewer rekaman pengerjaan (guru) ─────────────────────────────────
// Dua mode, satu komponen:
//  • LIVE  — rekaman masih berjalan: polling frame tiap 3 dtk, selalu
//            menampilkan frame TERBARU (pemantauan langsung).
//  • SAVED — siswa sudah selesai: seluruh frame dimuat bertahap lalu
//            diputar ulang (timeline + play/pause/step).
// Beralih otomatis: saat polling mendapati status SAVED (siswa submit
// saat guru menonton), polling berhenti dan mode putar mengambil alih.

export function RecordingViewer({
  open,
  onOpenChange,
  folderId,
  user,
  recordings,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  folderId: string;
  user: { id: string; name: string; username: string };
  /** Semua rekaman siswa ini (terbaru duluan). */
  recordings: FormRecordingDTO[];
}) {
  // Rekaman terpilih: default LIVE pertama (kalau ada), selain itu terbaru.
  const [recId, setRecId] = useState<string | null>(null);
  const [meta, setMeta] = useState<FormRecordingDTO | null>(null);
  const [frames, setFrames] = useState<FormRecordingFrameDTO[]>([]);
  const [idx, setIdx] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [loadingFrames, setLoadingFrames] = useState(false);

  const lastSeqRef = useRef(0);
  const loadedAllRef = useRef(false);

  // Default rekaman saat dialog dibuka.
  useEffect(() => {
    if (!open) return;
    const live = recordings.find((r) => r.status === "LIVE");
    setRecId(live?.id ?? recordings[0]?.id ?? null);
  }, [open, recordings]);

  // Reset saat ganti rekaman / buka dialog.
  useEffect(() => {
    setMeta(null);
    setFrames([]);
    setIdx(0);
    setPlaying(false);
    setLoadingFrames(false);
    lastSeqRef.current = 0;
    loadedAllRef.current = false;
  }, [recId]);

  const initialStatus =
    recordings.find((r) => r.id === recId)?.status ?? "SAVED";
  const isLive = (meta?.status ?? initialStatus) === "LIVE";
  const currentIdx = isLive ? Math.max(0, frames.length - 1) : idx;
  const current = frames[currentIdx];
  const doc = useMemo(
    () => (current ? buildRecordingDoc(current.html) : ""),
    [current?.html, current?.seq]
  );

  // ── LIVE: polling frame baru tiap 3 detik ──────────────────────────
  useEffect(() => {
    if (!open || !recId || !isLive) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch(
          `/api/cloud/assignments/${folderId}/form/recordings/${recId}?after=${lastSeqRef.current}&limit=10`,
          { cache: "no-store" }
        );
        if (!res.ok) return;
        const json = (await res.json()) as FramesResponse;
        if (cancelled) return;
        const before = meta?.status;
        setMeta(json.recording);
        if (json.frames?.length) {
          const newFrames = json.frames;
          setFrames((prev) => [...prev, ...newFrames]);
          lastSeqRef.current = newFrames[newFrames.length - 1].seq;
        }
        // Siswa submit saat guru menonton → rekaman tersimpan.
        if (before === "LIVE" && json.recording?.status === "SAVED") {
          toast.success(
            `${user.name} selesai — rekaman tersimpan dan bisa diputar ulang.`
          );
        }
      } catch {
        /* polling gagal — dicoba lagi di tick berikutnya */
      }
    };
    void tick();
    const t = setInterval(() => void tick(), 3000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, recId, isLive, folderId]);

  // ── SAVED: muat seluruh frame bertahap (batch 50) ──────────────────
  useEffect(() => {
    if (!open || !recId || isLive || loadedAllRef.current) return;
    let cancelled = false;
    (async () => {
      setLoadingFrames(true);
      try {
        for (;;) {
          const res = await fetch(
            `/api/cloud/assignments/${folderId}/form/recordings/${recId}?after=${lastSeqRef.current}&limit=50`,
            { cache: "no-store" }
          );
          if (!res.ok) break;
          const json = (await res.json()) as FramesResponse;
          if (cancelled) return;
          setMeta(json.recording);
          const fr = json.frames ?? [];
          if (fr.length) {
            setFrames((prev) => [...prev, ...fr]);
            lastSeqRef.current = fr[fr.length - 1].seq;
          }
          if (!json.hasMore) {
            loadedAllRef.current = true;
            break;
          }
        }
      } catch {
        /* gagal memuat — user bisa tutup/buka lagi */
      } finally {
        if (!cancelled) setLoadingFrames(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, recId, isLive, folderId]);

  // ── Playback: play/pause (1 frame per detik) ──────────────────────
  useEffect(() => {
    if (!playing || frames.length < 2) return;
    const t = setInterval(() => {
      setIdx((i) => {
        if (i >= frames.length - 1) {
          setPlaying(false);
          return i;
        }
        return i + 1;
      });
    }, 1000);
    return () => clearInterval(t);
  }, [playing, frames.length]);

  const total = frames.length;
  const multi = recordings.length > 1;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 flex-wrap">
            <span>Rekaman pengerjaan — {user.name}</span>
            {isLive ? (
              <Badge className="bg-red-500/15 text-red-600 dark:text-red-400 border border-red-500/40 gap-1.5">
                <Radio className="size-3 animate-pulse" /> LIVE
              </Badge>
            ) : (
              <Badge className="bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border border-emerald-500/40 gap-1.5">
                <CheckCircle2 className="size-3" /> Tersimpan
              </Badge>
            )}
          </DialogTitle>
          <DialogDescription>
            {isLive
              ? "Siswa sedang mengerjakan — tampilan diperbarui otomatis tiap 3 detik."
              : "Rekaman tersimpan setelah siswa mengumpulkan jawaban — putar ulang atau geser timeline."}
          </DialogDescription>
        </DialogHeader>

        {/* Meta + pilih percobaan (bila siswa mengulang) */}
        <div className="flex items-center gap-2 flex-wrap text-xs text-muted-foreground">
          {meta?.startedAt ? (
            <span>Mulai {format(new Date(meta.startedAt), "d MMM HH:mm:ss")}</span>
          ) : null}
          {meta?.finishedAt ? (
            <span>
              · Selesai {format(new Date(meta.finishedAt), "HH:mm:ss")}
            </span>
          ) : null}
          <span>· {total} frame</span>
          {multi ? (
            <span className="flex items-center gap-1">
              ·
              <select
                aria-label="Pilih percobaan"
                className="rounded-md border border-border bg-background px-1.5 py-0.5 text-xs"
                value={recId ?? ""}
                onChange={(e) => setRecId(e.target.value)}
              >
                {recordings.map((r, i) => (
                  <option key={r.id} value={r.id}>
                    Percobaan {recordings.length - i}
                    {r.status === "LIVE" ? " (berlangsung)" : ""}
                  </option>
                ))}
              </select>
            </span>
          ) : null}
        </div>

        {/* Layar rekaman */}
        <div className="relative">
          {total === 0 ? (
            <div className="h-[420px] rounded-lg border border-border bg-muted/30 flex flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
              {loadingFrames ? (
                <>
                  <Loader2 className="size-6 animate-spin" />
                  Memuat frame rekaman…
                </>
              ) : isLive ? (
                <>
                  <Radio className="size-6 animate-pulse text-red-500" />
                  Menunggu frame pertama dari siswa…
                </>
              ) : (
                "Belum ada frame tersimpan."
              )}
            </div>
          ) : (
            <iframe
              key={`${recId}-${current?.seq}`}
              title={`Rekaman layar ${user.name}`}
              sandbox=""
              srcDoc={doc}
              className="w-full h-[420px] rounded-lg border border-border bg-background"
            />
          )}
          {isLive && total > 0 ? (
            <span className="absolute top-2 right-2 inline-flex items-center gap-1.5 rounded-full bg-red-500/90 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white">
              <span className="size-1.5 rounded-full bg-white animate-pulse" />
              Live
            </span>
          ) : null}
        </div>

        {/* Kontrol putar (mode tersimpan) */}
        {!isLive ? (
          <div className="flex items-center gap-2 flex-wrap">
            <Button
              size="sm"
              variant="outline"
              disabled={total < 2}
              onClick={() => setPlaying((p) => !p)}
              className="gap-1.5"
            >
              {playing ? (
                <>
                  <Pause className="size-3.5" /> Jeda
                </>
              ) : (
                <>
                  <Play className="size-3.5" /> Putar
                </>
              )}
            </Button>
            <Button
              size="icon"
              variant="ghost"
              className="size-8"
              aria-label="Frame sebelumnya"
              disabled={idx <= 0 || total === 0}
              onClick={() => {
                setPlaying(false);
                setIdx((i) => Math.max(0, i - 1));
              }}
            >
              <ChevronLeft className="size-4" />
            </Button>
            <input
              type="range"
              aria-label="Garis waktu rekaman"
              min={0}
              max={Math.max(0, total - 1)}
              value={currentIdx}
              disabled={total < 2}
              onChange={(e) => {
                setPlaying(false);
                setIdx(Number(e.target.value));
              }}
              className={cn("flex-1 min-w-[160px] accent-primary")}
            />
            <Button
              size="icon"
              variant="ghost"
              className="size-8"
              aria-label="Frame berikutnya"
              disabled={total === 0 || idx >= total - 1}
              onClick={() => {
                setPlaying(false);
                setIdx((i) => Math.min(total - 1, i + 1));
              }}
            >
              <ChevronRight className="size-4" />
            </Button>
            <span className="text-xs text-muted-foreground tabular-nums whitespace-nowrap">
              Frame {total === 0 ? 0 : currentIdx + 1}/{total}
              {current?.capturedAt
                ? ` · ${format(new Date(current.capturedAt), "HH:mm:ss")}`
                : ""}
            </span>
          </div>
        ) : null}

        <p className="text-[11px] text-muted-foreground">
          Snapshot diambil otomatis setiap beberapa detik selama siswa
          mengerjakan — termasuk saat jawaban berubah. Tampilan memakai
          gaya aplikasi saat frame diambil.
        </p>
      </DialogContent>
    </Dialog>
  );
}
