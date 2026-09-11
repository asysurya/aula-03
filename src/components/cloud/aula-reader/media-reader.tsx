"use client";

import { useRef, useState } from "react";
import {
  Rewind,
  FastForward,
  Gauge,
  Repeat,
  PlaySquare,
  PictureInPicture2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// ─────────────────────────────────────────────────────────────────────────
// Aula Reader — Audio / Video.
// Kontrol belajar: kecepatan putar 0.5×–2× (tonton materi lebih cepat),
// lompat ±10 detik, ulang (loop), PiP (video), layar penuh otomatis besar.
// ─────────────────────────────────────────────────────────────────────────

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

export function MediaReader({
  url,
  kind,
  name,
}: {
  url: string;
  kind: "video" | "audio";
  name: string;
}) {
  const ref = useRef<HTMLVideoElement | HTMLAudioElement | null>(null);
  const [rateIdx, setRateIdx] = useState(2); // 1×
  const [loop, setLoop] = useState(false);

  function setRate(delta: number) {
    const el = ref.current;
    if (!el) return;
    const next = Math.min(SPEEDS.length - 1, Math.max(0, rateIdx + delta));
    setRateIdx(next);
    el.playbackRate = SPEEDS[next];
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
      </div>

      <div className="flex-1 min-h-0 overflow-auto flex items-center justify-center bg-neutral-200 dark:bg-neutral-900/60 p-4">
        {kind === "video" ? (
          <video
            ref={ref as React.RefObject<HTMLVideoElement>}
            controls
            preload="metadata"
            src={url}
            className="max-w-full max-h-full rounded-lg shadow-lg"
          />
        ) : (
          <div className="w-full max-w-xl flex flex-col items-center gap-4">
            <PlaySquare className="size-20 text-muted-foreground" />
            <audio
              ref={ref as React.RefObject<HTMLAudioElement>}
              controls
              preload="metadata"
              src={url}
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
