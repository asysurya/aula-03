"use client";

// ─────────────────────────────────────────────────────────────────────
// tts-player.tsx — Pemutar "Bacakan" Aula Reader dengan 2 MODE (Task 31):
//
//   • device — suara SpeechSynthesis BROWSER (mode lama: instan, offline,
//     kualitas tergantung perangkat);
//   • ai     — SUARA AI: disintesis server (provider /audio/speech atau
//     Piper lokal) → tempo & intonasi enak didengar, murid paham.
//     Potongan kalimat di-prefetch supaya nyaris tanpa jeda.
//
// Dipakai bersama oleh pdf-reader / text-reader / image-reader /
// selection-actions. Mode tersimpan di localStorage ("aula:tts-mode").
// ─────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useRef, useState } from "react";
import { Volume2, Loader2, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import type { TtsChunk } from "@/lib/reader/tts-text";

export type TtsMode = "device" | "ai";

const MODE_KEY = "aula:tts-mode";

/** Cache object-URL audio per teks (seumur sesi, lintas komponen). */
const aiAudioCache = new Map<string, string>();

function readStoredMode(): TtsMode {
  try {
    const v = localStorage.getItem(MODE_KEY);
    return v === "ai" ? "ai" : "device";
  } catch {
    return "device";
  }
}

export interface UseAulaTts {
  mode: TtsMode;
  setMode: (m: TtsMode) => void;
  playing: boolean;
  /** true saat audio AI sedang disintesis/diunduh (bukan sedang bunyi). */
  loading: boolean;
  /** Unduhan model suara lokal pertama kali berjalan. */
  aiPreparing: boolean;
  aiProgress: number;
  aiStage: string;
  speakChunks: (chunks: TtsChunk[], opts?: { onFinish?: () => void }) => void;
  stop: () => void;
}

export function useAulaTts(): UseAulaTts {
  const [mode, setModeState] = useState<TtsMode>("device");
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const [aiPreparing, setAiPreparing] = useState(false);
  const [aiProgress, setAiProgress] = useState(0);
  const [aiStage, setAiStage] = useState("");

  const stopRef = useRef(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const modeRef = useRef<TtsMode>("device");
  const prepareRef = useRef<Promise<void> | null>(null);

  useEffect(() => {
    const m = readStoredMode();
    setModeState(m);
    modeRef.current = m;
  }, []);

  const setMode = useCallback((m: TtsMode) => {
    setModeState(m);
    modeRef.current = m;
    try {
      localStorage.setItem(MODE_KEY, m);
    } catch {
      /* abaikan */
    }
    toast.info(
      m === "ai"
        ? "Mode Suara AI aktif — suara dibuat server (tempo enak didengar)."
        : "Mode suara perangkat aktif."
    );
  }, []);

  const clearTimer = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  const stop = useCallback(() => {
    stopRef.current = true;
    clearTimer();
    if (typeof window !== "undefined") window.speechSynthesis?.cancel();
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.onended = null;
      audioRef.current = null;
    }
    setPlaying(false);
    setLoading(false);
  }, []);

  // Hentikan saat komponen lepas.
  useEffect(() => {
    return () => {
      stopRef.current = true;
      clearTimer();
      if (typeof window !== "undefined") window.speechSynthesis?.cancel();
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current.onended = null;
        audioRef.current = null;
      }
    };
  }, []);

  // ── Suara AI: unduh audio potongan (dengan cache + prefetch) ──

  const preparePiper = useCallback(async (): Promise<void> => {
    if (prepareRef.current) return prepareRef.current;
    const p = (async () => {
      setAiPreparing(true);
      setAiProgress(0);
      setAiStage("menyiapkan unduhan…");
      toast.info("Mengunduh suara AI lokal (±90 MB — sekali saja)…", {
        description: "Mohon tunggu, progresnya tampil di tombol Suara AI.",
        duration: 8000,
      });
      try {
        const start = await fetch("/api/ai/tts/prepare", { method: "POST" });
        if (!start.ok) throw new Error("gagal memulai unduhan");
        // Polling sampai siap / galat / 15 menit.
        const t0 = Date.now();
        for (;;) {
          await new Promise((r) => setTimeout(r, 1500));
          if (stopRef.current) return;
          const res = await fetch("/api/ai/tts/prepare", { cache: "no-store" });
          if (!res.ok) throw new Error("status tidak terbaca");
          const s = (await res.json()) as {
            ready: boolean;
            downloading: boolean;
            pct: number;
            stage: string;
            error: string | null;
          };
          setAiProgress(Math.max(0, Math.min(100, s.pct ?? 0)));
          setAiStage(String(s.stage ?? ""));
          if (s.ready) {
            toast.success("Suara AI lokal siap — lanjut membacakan.");
            return;
          }
          if (s.error && !s.downloading) throw new Error(s.error);
          if (Date.now() - t0 > 15 * 60_000) throw new Error("waktu unduhan habis");
        }
      } finally {
        setAiPreparing(false);
        prepareRef.current = null;
      }
    })();
    prepareRef.current = p;
    return p;
  }, []);

  const getAiAudio = useCallback(
    async (text: string): Promise<string> => {
      const cached = aiAudioCache.get(text);
      if (cached) return cached;
      const doFetch = () =>
        fetch("/api/ai/tts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text }),
        });
      let res = await doFetch();
      if (res.status === 423) {
        // Model lokal belum terunduh → unduh dulu, lalu ulangi.
        await preparePiper();
        res = await doFetch();
      }
      if (!res.ok) {
        let msg = "sintesis suara gagal";
        try {
          const j = await res.json().catch(() => null);
          if (j?.error) msg = String(j.error);
        } catch {
          /* abaikan */
        }
        throw new Error(msg);
      }
      const blob = await res.blob();
      if (!blob.size) throw new Error("audio kosong");
      const url = URL.createObjectURL(blob);
      aiAudioCache.set(text, url);
      return url;
    },
    [preparePiper]
  );

  // ── Mode perangkat (SpeechSynthesis) ──────────────────────────────

  const speakDevice = useCallback(
    (chunks: TtsChunk[], i: number, onFinish?: () => void) => {
      if (stopRef.current || i >= chunks.length) {
        if (!stopRef.current) onFinish?.();
        setPlaying(false);
        return;
      }
      if (typeof window === "undefined" || !window.speechSynthesis) {
        setPlaying(false);
        return;
      }
      const u = new SpeechSynthesisUtterance(chunks[i].text);
      const voices = window.speechSynthesis.getVoices();
      const id = voices.find((v) => v.lang?.toLowerCase().startsWith("id"));
      if (id) u.voice = id;
      u.lang = id?.lang ?? "id-ID";
      u.rate = 1;
      const next = () => {
        clearTimer();
        timerRef.current = setTimeout(
          () => speakDevice(chunks, i + 1, onFinish),
          chunks[i].pauseAfterMs ?? 120
        );
      };
      u.onend = next;
      u.onerror = () => {
        setPlaying(false);
      };
      window.speechSynthesis.speak(u);
    },
    []
  );

  // ── Mode Suara AI ─────────────────────────────────────────────────

  const speakAi = useCallback(
    async (chunks: TtsChunk[], i: number, onFinish?: () => void) => {
      if (stopRef.current || i >= chunks.length) {
        if (!stopRef.current) onFinish?.();
        setPlaying(false);
        setLoading(false);
        return;
      }
      const chunk = chunks[i];
      setLoading(true);
      let url: string;
      try {
        url = await getAiAudio(chunk.text);
      } catch (e) {
        setLoading(false);
        toast.error("Suara AI gagal — melanjutkan dengan suara perangkat.", {
          description: String((e as Error)?.message ?? "").slice(0, 160),
        });
        speakDevice(chunks, i, onFinish);
        return;
      }
      setLoading(false);
      if (stopRef.current) return;
      setPlaying(true);
      const audio = new Audio(url);
      audioRef.current = audio;
      audio.onended = () => {
        clearTimer();
        timerRef.current = setTimeout(
          () => void speakAi(chunks, i + 1, onFinish),
          chunk.pauseAfterMs ?? 150
        );
      };
      audio.onerror = () => {
        setPlaying(false);
        toast.error("Pemutaran audio gagal — coba mode suara perangkat.");
      };
      try {
        await audio.play();
        // Prefetch potongan berikutnya (nyaris tanpa jeda antar kalimat).
        const nx = chunks[i + 1];
        if (nx) void getAiAudio(nx.text).catch(() => undefined);
      } catch {
        setPlaying(false);
        toast.error("Browser memblokir pemutaran — coba lagi atau pakai suara perangkat.");
      }
    },
    [getAiAudio, speakDevice]
  );

  const speakChunks = useCallback(
    (chunks: TtsChunk[], opts?: { onFinish?: () => void }) => {
      if (!chunks.length) return;
      stop();
      stopRef.current = false;
      setPlaying(true);
      if (modeRef.current === "ai") {
        void speakAi(chunks, 0, opts?.onFinish);
      } else {
        speakDevice(chunks, 0, opts?.onFinish);
      }
    },
    [speakAi, speakDevice, stop]
  );

  return {
    mode,
    setMode,
    playing,
    loading,
    aiPreparing,
    aiProgress,
    aiStage,
    speakChunks,
    stop,
  };
}

// ── Toggle mode di toolbar reader ─────────────────────────────────────

export function TtsModeToggle({
  mode,
  onChange,
  preparing,
  progress,
  stage,
}: {
  mode: TtsMode;
  onChange: (m: TtsMode) => void;
  preparing?: boolean;
  progress?: number;
  stage?: string;
}) {
  const titleAi = preparing
    ? `Mengunduh suara AI lokal… ${progress ?? 0}% (${stage ?? ""})`
    : "Suara AI — disintesis server (tempo & intonasi enak didengar)";
  return (
    <div
      role="group"
      aria-label="Mode suara bacakan"
      data-tts-mode={mode}
      data-tts-preparing={preparing ? "true" : "false"}
      className="flex items-center rounded-md border h-9 p-0.5 gap-0.5"
    >
      <button
        type="button"
        data-tts-mode-option="device"
        aria-pressed={mode === "device"}
        title="Suara perangkat — cepat, tanpa unduhan (mode lama)"
        onClick={() => onChange("device")}
        className={cn(
          "flex items-center gap-1 rounded-sm px-2 h-8 text-xs transition-colors",
          mode === "device"
            ? "bg-secondary text-secondary-foreground"
            : "text-muted-foreground hover:text-foreground"
        )}
      >
        <Volume2 className="size-3.5" />
        <span className="hidden sm:inline">Perangkat</span>
      </button>
      <button
        type="button"
        data-tts-mode-option="ai"
        aria-pressed={mode === "ai"}
        title={titleAi}
        disabled={preparing}
        onClick={() => onChange("ai")}
        className={cn(
          "flex items-center gap-1 rounded-sm px-2 h-8 text-xs transition-colors",
          mode === "ai"
            ? "bg-primary text-primary-foreground"
            : "text-muted-foreground hover:text-foreground",
          preparing && "opacity-70"
        )}
      >
        {preparing ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : (
          <Sparkles className="size-3.5" />
        )}
        <span className="hidden sm:inline">Suara AI</span>
        {preparing ? (
          <span data-tts-ai-progress>{progress ?? 0}%</span>
        ) : null}
      </button>
    </div>
  );
}
