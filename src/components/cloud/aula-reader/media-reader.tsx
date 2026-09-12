"use client";

import { useEffect, useRef, useState } from "react";
import {
  Rewind,
  FastForward,
  Gauge,
  Repeat,
  PlaySquare,
  PictureInPicture2,
  TriangleAlert,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAnnotations } from "./annotations";

// ─────────────────────────────────────────────────────────────────────────
// Aula Reader — Audio / Video.
// Kontrol belajar: kecepatan putar 0.5×–2× (tersimpan per perangkat),
// lompat ±10 detik, ulang (loop), PiP (video), layar penuh otomatis besar.
// LANJUT TONTON: posisi terakhir (detik) tersimpan di MongoDB — dulu
// selalu mulai dari 0:00 lagi tiap dibuka.
// ─────────────────────────────────────────────────────────────────────────

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
const RATE_KEY = "aula.media.rate";

function loadRateIdx(): number {
  try {
    const v = Number(localStorage.getItem(RATE_KEY));
    const i = SPEEDS.indexOf(v);
    return i >= 0 ? i : 2;
  } catch {
    return 2;
  }
}

export function MediaReader({
  storageKey,
  url,
  kind,
  name,
}: {
  storageKey: string;
  url: string;
  kind: "video" | "audio";
  name: string;
}) {
  const ref = useRef<HTMLVideoElement | HTMLAudioElement | null>(null);
  const [rateIdx, setRateIdx] = useState(loadRateIdx); // 1× default
  const [loop, setLoop] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resumedAt, setResumedAt] = useState<number | null>(null);

  // Posisi baca = kolom `page` ReaderDoc (detik, dibulatkan).
  const anno = useAnnotations(storageKey);
  /** Sudah coba resume? (jangan ulangi tiap re-render) */
  const resumed = useRef(false);
  /** Metadata media sudah termuat (duration valid)? */
  const [metaReady, setMetaReady] = useState(false);
  /** Throttle laporan posisi (tiap ±5 detik waktu putar). */
  const lastReport = useRef(0);

  // Terapkan kecepatan tersimpan saat elemen siap.
  useEffect(() => {
    const el = ref.current;
    if (el) el.playbackRate = SPEEDS[rateIdx];
  }, [rateIdx]);

  // ── Resume posisi terakhir ──
  // Menunggu metadata SIAP **dan** data server TIBA (loaded) — dulu:
  // onLoadedMetadata lokal instan jalan duluan padahal savedPage masih
  // nilai awal 1 → posisi tidak pernah dipulihkan.
  useEffect(() => {
    const el = ref.current;
    if (!el || !metaReady || !anno.loaded || resumed.current) return;
    const t = anno.savedPage;
    if (t > 1 && Number.isFinite(el.duration) && t < el.duration - 3) {
      resumed.current = true;
      el.currentTime = t;
      setResumedAt(t);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [metaReady, anno.loaded, anno.savedPage]);

  // Simpan posisi (throttled) + saat jeda.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onTime = () => {
      const now = Date.now();
      if (now - lastReport.current < 5000) return;
      lastReport.current = now;
      if (el.currentTime > 3) anno.reportPage(Math.max(1, Math.round(el.currentTime)));
    };
    const onPause = () => {
      if (el.currentTime > 3)
        anno.reportPage(Math.max(1, Math.round(el.currentTime)));
    };
    const onEnded = () => anno.reportPage(1); // selesai → mulai dari awal lain kali
    el.addEventListener("timeupdate", onTime);
    el.addEventListener("pause", onPause);
    el.addEventListener("ended", onEnded);
    return () => {
      el.removeEventListener("timeupdate", onTime);
      el.removeEventListener("pause", onPause);
      el.removeEventListener("ended", onEnded);
      // Terakhir kali: flush posisi saat ditutup.
      if (el.currentTime > 3 && Number.isFinite(el.duration) && el.currentTime < el.duration - 3)
        anno.reportPage(Math.max(1, Math.round(el.currentTime)));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anno.reportPage]);

  function setRate(delta: number) {
    const el = ref.current;
    const next = Math.min(SPEEDS.length - 1, Math.max(0, rateIdx + delta));
    setRateIdx(next);
    try {
      localStorage.setItem(RATE_KEY, String(SPEEDS[next]));
    } catch {
      /* abaikan */
    }
    if (el) el.playbackRate = SPEEDS[next];
  }

  function skip(sec: number) {
    const el = ref.current;
    if (!el) return;
    el.currentTime = Math.max(0, el.currentTime + sec);
  }

  async function pip() {
    const el = ref.current as HTMLVideoElement | null;
    if (!el || kind !== "video") return;
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
      } else {
        await el.requestPictureInPicture();
      }
    } catch {
      /* tidak didukung — abaikan */
    }
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 p-10 min-h-[40vh] text-center">
        <TriangleAlert className="size-10 text-destructive" />
        <p className="text-sm text-destructive">Gagal memutar {kind === "video" ? "video" : "audio"}.</p>
        <p className="text-xs text-muted-foreground max-w-sm">{error}</p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setError(null);
            const el = ref.current;
            if (el) {
              el.load();
            }
          }}
        >
          Coba lagi
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col flex-1 h-full min-h-0">
      <div className="flex items-center gap-1.5 flex-wrap px-3 py-2 border-b border-border bg-background/95 sticky top-0 z-20">
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="icon"
            className="h-9 w-9"
            onClick={() => skip(-10)}
            title="Mundur 10 detik"
          >
            <Rewind className="size-4" />
          </Button>
          <Button
            variant="outline"
            size="icon"
            className="h-9 w-9"
            onClick={() => skip(10)}
            title="Maju 10 detik"
          >
            <FastForward className="size-4" />
          </Button>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="icon"
            className="h-9 w-9"
            onClick={() => setRate(-1)}
            title="Lambatkan"
          >
            −
          </Button>
          <span className="text-xs tabular-nums w-12 text-center flex items-center justify-center gap-1">
            <Gauge className="size-3.5 text-muted-foreground" />
            {SPEEDS[rateIdx]}×
          </span>
          <Button
            variant="outline"
            size="icon"
            className="h-9 w-9"
            onClick={() => setRate(1)}
            title="Percepat"
          >
            +
          </Button>
        </div>
        <Button
          variant={loop ? "secondary" : "outline"}
          size="icon"
          className="h-9 w-9"
          onClick={() => {
            const v = !loop;
            setLoop(v);
            if (ref.current) ref.current.loop = v;
          }}
          title="Ulang terus (loop)"
        >
          <Repeat className="size-4" />
        </Button>
        {kind === "video" ? (
          <Button
            variant="outline"
            size="icon"
            className="h-9 w-9"
            onClick={() => void pip()}
            title="Picture-in-Picture"
          >
            <PictureInPicture2 className="size-4" />
          </Button>
        ) : null}
        {resumedAt !== null ? (
          <span className="text-xs text-muted-foreground ml-1">
            Melanjutkan dari {Math.floor(resumedAt / 60)}:
            {String(Math.floor(resumedAt % 60)).padStart(2, "0")}
          </span>
        ) : null}
      </div>

      <div className="flex-1 min-h-0 overflow-auto flex items-center justify-center bg-neutral-200 dark:bg-neutral-900/60 p-4">
        {kind === "video" ? (
          <video
            ref={ref as React.RefObject<HTMLVideoElement>}
            controls
            preload="metadata"
            src={url}
            onLoadedMetadata={() => setMetaReady(true)}
            onError={() =>
              setError("Format tidak didukung browser atau file rusak.")
            }
            className="max-w-full max-h-full rounded-lg shadow-lg"
          />
        ) : (
          <div className="w-full max-w-xl flex flex-col items-center gap-4">
            <PlaySquare className="size-20 text-muted-foreground" />
            <p className="text-sm text-muted-foreground truncate max-w-full" title={name}>
              {name}
            </p>
            <audio
              ref={ref as React.RefObject<HTMLAudioElement>}
              controls
              preload="metadata"
              src={url}
              onLoadedMetadata={() => setMetaReady(true)}
              onError={() =>
                setError("Format tidak didukung browser atau file rusak.")
              }
              className="w-full"
            >
              Browser tidak mendukung pemutaran audio.
            </audio>
          </div>
        )}
      </div>
    </div>
  );
}
