"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ZoomIn,
  ZoomOut,
  Moon,
  Sun,
  Volume2,
  Square,
  Highlighter,
  Undo2,
  Trash2,
  FileText,
  Loader2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import ReactMarkdown from "react-markdown";
import { ANNO_COLORS } from "./annotations";
import { newId } from "./annotations";

// ─────────────────────────────────────────────────────────────────────────
// Aula Reader — Teks / Markdown / kode.
// - Ukuran font & tema baca (terang / kertas / malam) — nyaman di TV.
// - TTS: bacakan seluruh isi.
// - Stabilo teks: seleksi teks → tombol warna → tersimpan di perangkat.
// ─────────────────────────────────────────────────────────────────────────

interface TextHighlight {
  id: string;
  start: number;
  end: number;
  color: string;
  created: number;
}

const HL_PREFIX = "aula.t hl.v1:";

function loadHl(key: string): TextHighlight[] {
  try {
    const raw = localStorage.getItem(HL_PREFIX + key);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function TextReader({
  file,
  url,
  isMarkdown,
}: {
  file: { storageKey: string; name: string };
  url: string;
  isMarkdown: boolean;
}) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fontSize, setFontSize] = useState(15);
  const [theme, setTheme] = useState<"light" | "paper" | "dark">("paper");
  const [mono, setMono] = useState(false);
  const [ttsPlaying, setTtsPlaying] = useState(false);
  const [hls, setHls] = useState<TextHighlight[]>(() => loadHl(file.storageKey));
  const [selRange, setSelRange] = useState<{ start: number; end: number } | null>(null);
  const [selColor, setSelColor] = useState(ANNO_COLORS[0]);
  const [showHlBar, setShowHlBar] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const ttsStop = useRef(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const raw = await res.text();
        if (!cancelled) setText(raw.length > 2_000_000 ? raw.slice(0, 2_000_000) : raw);
      } catch (e) {
        if (!cancelled)
          setError(e instanceof Error ? e.message : "Gagal memuat teks");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [url]);

  // Persist stabilo teks (debounce).
  useEffect(() => {
    const t = setTimeout(() => {
      try {
        localStorage.setItem(HL_PREFIX + file.storageKey, JSON.stringify(hls.slice(-500)));
      } catch {}
    }, 400);
    return () => clearTimeout(t);
  }, [hls, file.storageKey]);

  const applyHighlight = useCallback(() => {
    if (!selRange) return;
    setHls((prev) => [
      ...prev,
      {
        id: newId(),
        start: selRange.start,
        end: selRange.end,
        color: selColor,
        created: Date.now(),
      },
    ]);
    setSelRange(null);
    setShowHlBar(false);
    if (typeof window !== "undefined") window.getSelection()?.removeAllRanges();
  }, [selRange, selColor]);

  // Seleksi teks → tampilkan bar stabilo.
  function onSelect() {
    if (mono) return; // offset pre-wrap stabil hanya pada tampilan teks
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !bodyRef.current) {
      setShowHlBar(false);
      setSelRange(null);
      return;
    }
    const anchor = sel.anchorNode;
    const focus = sel.focusNode;
    if (!anchor || !focus) return;
    if (!bodyRef.current.contains(anchor) || !bodyRef.current.contains(focus))
      return;
    // Hitung offset terhadap seluruh teks di body.
    const walker = document.createTreeWalker(
      bodyRef.current,
      NodeFilter.SHOW_TEXT
    );
    const nodes: Text[] = [];
    let n: Node | null;
    while ((n = walker.nextNode())) nodes.push(n as Text);
    let pos = 0;
    let start = -1;
    let end = -1;
    for (const node of nodes) {
      if (node === anchor) start = pos + (sel.anchorOffset ?? 0);
      if (node === focus) end = pos + (sel.focusOffset ?? 0);
      pos += node.length;
    }
    if (start >= 0 && end >= 0 && start !== end) {
      setSelRange({ start: Math.min(start, end), end: Math.max(start, end) });
      setShowHlBar(true);
    } else {
      setShowHlBar(false);
      setSelRange(null);
    }
  }

  // TTS
  const toggleTts = useCallback(() => {
    if (ttsPlaying) {
      ttsStop.current = true;
      window.speechSynthesis.cancel();
      setTtsPlaying(false);
      return;
    }
    if (!text) return;
    ttsStop.current = false;
    setTtsPlaying(true);
    // Potong per kalimat supaya mulai cepat & bisa dihentikan halus.
    const sentences = text.replace(/\s+/g, " ").match(/[^.!?]+[.!?]*/g) ?? [text];
    let idx = 0;
    const speakNext = () => {
      if (ttsStop.current) return setTtsPlaying(false);
      if (idx >= sentences.length) return setTtsPlaying(false);
      const u = new SpeechSynthesisUtterance(sentences[idx++].trim());
      const id = window.speechSynthesis
        .getVoices()
        .find((v) => v.lang?.toLowerCase().startsWith("id"));
      if (id) u.voice = id;
      u.lang = id?.lang ?? "id-ID";
      u.onend = speakNext;
      window.speechSynthesis.speak(u);
    };
    speakNext();
  }, [ttsPlaying, text]);

  useEffect(() => {
    return () => {
      ttsStop.current = true;
      if (typeof window !== "undefined") window.speechSynthesis?.cancel();
    };
  }, []);

  // Render teks dengan stabilo (potong berdasarkan offset).
  const segments = useMemo(() => {
    if (!text) return [];
    const sorted = [...hls].sort((a, b) => a.start - b.start);
    const out: { text: string; color?: string }[] = [];
    let pos = 0;
    for (const h of sorted) {
      if (h.start < pos) continue; // tumpang tindih — lewati
      if (h.start > pos) out.push({ text: text.slice(pos, h.start) });
      out.push({ text: text.slice(h.start, h.end), color: h.color });
      pos = h.end;
    }
    if (pos < text.length) out.push({ text: text.slice(pos) });
    return out;
  }, [text, hls]);

  const wordCount = useMemo(
    () => (text ? text.trim().split(/\s+/).filter(Boolean).length : 0),
    [text]
  );

  const themeCls =
    theme === "dark"
      ? "bg-neutral-900 text-neutral-200"
      : theme === "paper"
      ? "bg-[#f7f2e7] text-neutral-800"
      : "bg-white text-neutral-900";

  if (error) {
    return (
      <div className="p-8 text-center text-sm text-destructive">
        Gagal memuat teks: {error}
      </div>
    );
  }
  if (text === null) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 p-10 min-h-[40vh]">
        <Loader2 className="size-8 animate-spin text-muted-foreground" />
        <p className="text-sm text-muted-foreground">Memuat teks…</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Toolbar */}
      <div className="flex items-center gap-1.5 flex-wrap px-3 py-2 border-b border-border bg-background/95 sticky top-0 z-20">
        <Button
          variant="outline"
          size="icon"
          className="h-9 w-9"
          onClick={() => setFontSize((s) => Math.max(11, s - 2))}
          title="Perkecil teks"
        >
          <ZoomOut className="size-4" />
        </Button>
        <span className="text-xs tabular-nums w-10 text-center text-muted-foreground">
          {fontSize}px
        </span>
        <Button
          variant="outline"
          size="icon"
          className="h-9 w-9"
          onClick={() => setFontSize((s) => Math.min(34, s + 2))}
          title="Perbesar teks"
        >
          <ZoomIn className="size-4" />
        </Button>
        <Button
          variant="outline"
          size="icon"
          className="h-9 w-9"
          onClick={() =>
            setTheme((t) => (t === "light" ? "paper" : t === "paper" ? "dark" : "light"))
          }
          title="Ganti tema baca (terang / kertas / malam)"
        >
          {theme === "dark" ? <Moon className="size-4" /> : <Sun className="size-4" />}
        </Button>
        <Button
          variant="outline"
          size="icon"
          className="h-9 w-9"
          onClick={toggleTts}
          title="Bacakan (TTS)"
        >
          {ttsPlaying ? <Square className="size-4" /> : <Volume2 className="size-4" />}
        </Button>
        <Button
          variant={mono ? "secondary" : "outline"}
          size="icon"
          className="h-9 w-9"
          onClick={() => setMono((v) => !v)}
          title="Font monospace (untuk kode)"
        >
          <FileText className="size-4" />
        </Button>
        {!mono ? (
          <Button
            variant="outline"
            size="icon"
            className="h-9 w-9"
            onClick={() => {
              if (hls.length === 0) return;
              setHls((prev) => prev.slice(0, -1));
            }}
            disabled={hls.length === 0}
            title="Urungkan stabilo terakhir"
          >
            <Undo2 className="size-4" />
          </Button>
        ) : null}
        <Button
          variant="outline"
          size="icon"
          className="h-9 w-9"
          onClick={() => setHls([])}
          disabled={hls.length === 0}
          title="Hapus semua stabilo file ini"
        >
          <Trash2 className="size-4" />
        </Button>
        <span className="text-xs text-muted-foreground ml-auto pr-1">
          {wordCount.toLocaleString("id-ID")} kata
        </span>
      </div>

      {/* Bar stabilo (muncul saat teks diseleksi) */}
      {showHlBar && selRange ? (
        <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-border bg-muted/50">
          <Highlighter className="size-4 text-muted-foreground" />
          <span className="text-xs text-muted-foreground">Stabilo:</span>
          {ANNO_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              aria-label={`Warna ${c}`}
              onClick={() => setSelColor(c)}
              className={cn(
                "size-5 rounded-full border-2",
                selColor === c ? "border-foreground scale-110" : "border-transparent"
              )}
              style={{ backgroundColor: c }}
            />
          ))}
          <Button size="sm" className="h-8 ml-2" onClick={applyHighlight}>
            Tandai
          </Button>
        </div>
      ) : null}

      {/* Isi */}
      <div
        className="flex-1 min-h-0 overflow-auto"
        onMouseUp={onSelect}
        onTouchEnd={onSelect}
      >
        <div className="mx-auto max-w-3xl px-5 py-6">
          <div
            ref={bodyRef}
            className={cn("rounded-lg", themeCls)}
            style={{ fontSize: `${fontSize}px`, lineHeight: 1.75 }}
          >
            {mono ? (
              <pre className="whitespace-pre-wrap break-words font-mono p-4">
                {text}
              </pre>
            ) : isMarkdown ? (
              <div className="p-5">
                <ReactMarkdown>{text}</ReactMarkdown>
                <p className="mt-4 text-xs opacity-60">
                  Stabilo teks tersedia di tab Teks (non-markdown).
                </p>
              </div>
            ) : (
              <div className="whitespace-pre-wrap break-words p-5">
                {segments.map((s, i) =>
                  s.color ? (
                    <mark
                      key={i}
                      style={{ backgroundColor: s.color, color: "inherit" }}
                      className="rounded-sm px-0.5"
                    >
                      {s.text}
                    </mark>
                  ) : (
                    <span key={i}>{s.text}</span>
                  )
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
