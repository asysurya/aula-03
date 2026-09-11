"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  ZoomIn,
  ZoomOut,
  Maximize,
  Moon,
  Sun,
  Search,
  Highlighter,
  Pen,
  Eraser,
  Undo2,
  Trash2,
  Volume2,
  Square,
  X,
  Loader2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { CloudFileItem } from "@/lib/cloud-format";
import type { OfficeCacheEntry } from "@/components/cloud/buffer-loader";
import {
  ANNO_COLORS,
  type AnnoTool,
  type Annotation,
  useAnnotations,
} from "./annotations";
import { AnnotationLayer } from "./annotation-layer";
import type { PDFDocumentProxy } from "pdfjs-dist";

// ─────────────────────────────────────────────────────────────────────────
// Aula Reader — PDF.
// - Render cepat via pdf.js (worker terpisah): hanya halaman yang terlihat
//   yang dirender (render-on-visible + cache bitmap) → PDF 100 halaman /
//   40 MB tetap lancar bahkan di Smart TV / HP kentang.
// - Zoom, navigasi halaman, mode malam, pencarian teks (lompat halaman),
//   TTS "baca halaman" dengan lanjut otomatis ke halaman berikutnya.
// - Stabilo & pena: lapisan anotasi per halaman, tersimpan di perangkat.
// - Ramah TV/remote: tombol besar, semua bisa dijangkau keyboard/D-pad.
// ─────────────────────────────────────────────────────────────────────────

let workerConfigured = false;

async function getPdfjs() {
  const pdfjs = await import("pdfjs-dist");
  if (!workerConfigured && typeof window !== "undefined") {
    pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
    workerConfigured = true;
  }
  return pdfjs;
}

interface PageDim {
  w: number;
  h: number;
}

export function PdfReader({
  file,
  entry,
}: {
  file: CloudFileItem;
  entry: OfficeCacheEntry;
}) {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [dims, setDims] = useState<Record<number, PageDim>>({});
  const defaultRatio = 1.414; // A4
  const [zoom, setZoom] = useState(1); // 1 = pas-lebar
  const [page, setPage] = useState(1);
  const [night, setNight] = useState(false);
  const [tool, setTool] = useState<AnnoTool>("none");
  const [color, setColor] = useState(ANNO_COLORS[0]);
  const [containerW, setContainerW] = useState(0);
  const [visible, setVisible] = useState<Set<number>>(new Set([1]));
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<
    { page: number; snippet: string }[] | null
  >(null);
  const [searching, setSearching] = useState(false);
  const [ttsPlaying, setTtsPlaying] = useState(false);
  const [flashPage, setFlashPage] = useState<number | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const pageRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const textCache = useRef<Map<number, string>>(new Map());
  const ttsStop = useRef(false);

  const anno = useAnnotations(file.storageKey);

  // ── Load dokumen ──
  useEffect(() => {
    let cancelled = false;
    let loaded: PDFDocumentProxy | null = null;
    setDoc(null);
    setError(null);
    setNumPages(0);
    setDims({});
    setPage(1);
    (async () => {
      try {
        const pdfjs = await getPdfjs();
        // Salin buffer — pdf.js memindahkan kepemilikan ArrayBuffer ke
        // worker (buffer asli di cache harus tetap utuh untuk mode lain).
        const copy = entry.buffer.slice(0);
        const task = pdfjs.getDocument({ data: new Uint8Array(copy) });
        loaded = await task.promise;
        if (cancelled) {
          void loaded.destroy();
          return;
        }
        setDoc(loaded);
        setNumPages(loaded.numPages);
      } catch (e) {
        if (!cancelled)
          setError(e instanceof Error ? e.message : "Gagal membuka PDF");
      }
    })();
    return () => {
      cancelled = true;
      ttsStop.current = true;
      if (typeof window !== "undefined") window.speechSynthesis?.cancel();
      void loaded?.destroy();
    };
  }, [entry.buffer, file.storageKey]);

  // ── Lebar container (responsive; TV besar → halaman besar) ──
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const en of entries) setContainerW(en.contentRect.width);
    });
    ro.observe(el);
    setContainerW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // ── Dimensi halaman (lazy: halaman pertama dulu, sisanya on-demand) ──
  useEffect(() => {
    if (!doc) return;
    let cancelled = false;
    (async () => {
      // Muat dimensi bertahap — jangan blok UI.
      for (let i = 1; i <= doc.numPages; i++) {
        if (cancelled) return;
        try {
          const p = await doc.getPage(i);
          const vp = p.getViewport({ scale: 1 });
          setDims((prev) => ({
            ...prev,
            [i]: { w: vp.width, h: vp.height },
          }));
        } catch {
          return;
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [doc]);

  const pageWidth = Math.max(280, containerW - 32) * zoom;
  const ratioOf = useCallback(
    (i: number) => {
      const d = dims[i];
      return d ? d.h / d.w : defaultRatio;
    },
    [dims]
  );

  // ── Halaman aktif (saat scroll) ──
  const onScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const mid = el.scrollTop + el.clientHeight * 0.35;
    let cur = 1;
    for (let i = 1; i <= numPages; i++) {
      const node = pageRefs.current.get(i);
      if (!node) continue;
      if (node.offsetTop <= mid) cur = i;
      else break;
    }
    setPage(cur);
  }, [numPages]);

  // ── Jump ke halaman ──
  const gotoPage = useCallback((n: number) => {
    const target = Math.min(Math.max(1, n), numPages || 1);
    const node = pageRefs.current.get(target);
    if (node) {
      node.scrollIntoView({ behavior: "smooth", block: "start" });
    }
    setPage(target);
  }, [numPages]);

  // ── Zoom ──
  const changeZoom = useCallback(
    (delta: number) => {
      setZoom((z) => Math.min(4, Math.max(0.5, +(z + delta).toFixed(2))));
    },
    []
  );

  // ── TTS: baca halaman, lanjut otomatis ──
  const speakPage = useCallback(
    async (n: number) => {
      if (!doc) return;
      try {
        let text = textCache.current.get(n);
        if (!text) {
          const p = await doc.getPage(n);
          const tc = await p.getTextContent();
          text = (tc.items as { str?: string }[])
            .map((it) => it.str ?? "")
            .join(" ")
            .replace(/\s+/g, " ")
            .trim();
          textCache.current.set(n, text);
        }
        if (!text) {
          if (n < numPages && !ttsStop.current) {
            setPage(n + 1);
            gotoPage(n + 1);
            void speakPage(n + 1);
          } else {
            setTtsPlaying(false);
          }
          return;
        }
        const u = new SpeechSynthesisUtterance(text);
        const voices = window.speechSynthesis.getVoices();
        const id = voices.find((v) => v.lang?.toLowerCase().startsWith("id"));
        if (id) u.voice = id;
        u.lang = id?.lang ?? "id-ID";
        u.rate = 1;
        u.onend = () => {
          if (ttsStop.current) return;
          if (n < numPages) {
            setPage(n + 1);
            gotoPage(n + 1);
            void speakPage(n + 1);
          } else {
            setTtsPlaying(false);
          }
        };
        window.speechSynthesis.speak(u);
      } catch {
        setTtsPlaying(false);
      }
    },
    [doc, numPages, gotoPage]
  );

  const toggleTts = useCallback(() => {
    if (ttsPlaying) {
      ttsStop.current = true;
      window.speechSynthesis.cancel();
      setTtsPlaying(false);
      return;
    }
    ttsStop.current = false;
    setTtsPlaying(true);
    void speakPage(page);
  }, [ttsPlaying, page, speakPage]);

  useEffect(() => {
    return () => {
      ttsStop.current = true;
      if (typeof window !== "undefined") window.speechSynthesis?.cancel();
    };
  }, []);

  // ── Pencarian ──
  const doSearch = useCallback(async () => {
    const q = query.trim().toLowerCase();
    if (!q || !doc) return;
    setSearching(true);
    setResults(null);
    const out: { page: number; snippet: string }[] = [];
    try {
      for (let i = 1; i <= doc.numPages; i++) {
        let text = textCache.current.get(i);
        if (!text) {
          const p = await doc.getPage(i);
          const tc = await p.getTextContent();
          text = (tc.items as { str?: string }[])
            .map((it) => it.str ?? "")
            .join(" ")
            .replace(/\s+/g, " ")
            .trim();
          textCache.current.set(i, text);
        }
        const idx = text.toLowerCase().indexOf(q);
        if (idx >= 0) {
          out.push({
            page: i,
            snippet:
              (idx > 40 ? "…" : "") +
              text.slice(Math.max(0, idx - 40), idx + q.length + 60) +
              "…",
          });
          if (out.length >= 50) break;
        }
      }
    } catch {
      /* abaikan */
    }
    setResults(out);
    setSearching(false);
  }, [query, doc]);

  function jumpResult(n: number) {
    gotoPage(n);
    setFlashPage(n);
    setTimeout(() => setFlashPage(null), 1400);
  }

  // ── Keyboard (remote TV / keyboard) ──
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "PageDown" || e.key === "ArrowRight") {
        e.preventDefault();
        gotoPage(page + 1);
      } else if (e.key === "PageUp" || e.key === "ArrowLeft") {
        e.preventDefault();
        gotoPage(page - 1);
      } else if (e.key === "+" || e.key === "=") {
        changeZoom(0.25);
      } else if (e.key === "-") {
        changeZoom(-0.25);
      } else if (e.key.toLowerCase() === "f") {
        setZoom(1);
      } else if (e.key.toLowerCase() === "n") {
        setNight((v) => !v);
      }
    },
    [page, gotoPage, changeZoom]
  );

  const pageList = useMemo(() => {
    const arr: number[] = [];
    for (let i = 1; i <= numPages; i++) arr.push(i);
    return arr;
  }, [numPages]);

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 p-10 min-h-[40vh] text-center">
        <p className="text-sm text-destructive">Gagal membuka PDF: {error}</p>
        <Button variant="outline" size="sm" onClick={() => setTool("none")}>
          Coba lagi dengan pratinjau bawaan
        </Button>
      </div>
    );
  }

  if (!doc) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 p-10 min-h-[40vh]">
        <Loader2 className="size-8 animate-spin text-muted-foreground" />
        <p className="text-sm text-muted-foreground">
          Menyiapkan dokumen PDF…
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* ── Toolbar ── */}
      <div className="flex items-center gap-1.5 flex-wrap px-3 py-2 border-b border-border bg-background/95 sticky top-0 z-20">
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="icon"
            className="h-9 w-9"
            onClick={() => gotoPage(page - 1)}
            disabled={page <= 1}
            title="Halaman sebelumnya"
          >
            <ChevronLeft className="size-4" />
          </Button>
          <span className="text-sm tabular-nums px-1 whitespace-nowrap">
            <input
              className="w-12 h-9 text-center rounded-md border border-input bg-transparent focus:outline-none focus:ring-1 focus:ring-ring"
              value={page}
              onChange={(e) => {
                const n = parseInt(e.target.value, 10);
                if (!Number.isNaN(n)) setPage(Math.min(Math.max(1, n), numPages));
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") gotoPage(page);
              }}
              aria-label="Nomor halaman"
            />
            <span className="text-muted-foreground"> / {numPages}</span>
          </span>
          <Button
            variant="outline"
            size="icon"
            className="h-9 w-9"
            onClick={() => gotoPage(page + 1)}
            disabled={page >= numPages}
            title="Halaman berikutnya"
          >
            <ChevronRight className="size-4" />
          </Button>
        </div>

        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="icon"
            className="h-9 w-9"
            onClick={() => changeZoom(-0.25)}
            title="Perkecil"
          >
            <ZoomOut className="size-4" />
          </Button>
          <span className="text-xs tabular-nums w-12 text-center text-muted-foreground">
            {Math.round(zoom * 100)}%
          </span>
          <Button
            variant="outline"
            size="icon"
            className="h-9 w-9"
            onClick={() => changeZoom(0.25)}
            title="Perbesar"
          >
            <ZoomIn className="size-4" />
          </Button>
          <Button
            variant="outline"
            size="icon"
            className="h-9 w-9"
            onClick={() => setZoom(1)}
            title="Pas lebar layar"
          >
            <Maximize className="size-4" />
          </Button>
        </div>

        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="icon"
            className="h-9 w-9"
            onClick={() => setNight((v) => !v)}
            title={night ? "Mode terang" : "Mode malam (nyaman di gelap)"}
          >
            {night ? <Sun className="size-4" /> : <Moon className="size-4" />}
          </Button>
          <Button
            variant={searchOpen ? "secondary" : "outline"}
            size="icon"
            className="h-9 w-9"
            onClick={() => setSearchOpen((v) => !v)}
            title="Cari teks di dokumen"
          >
            <Search className="size-4" />
          </Button>
          <Button
            variant={ttsPlaying ? "secondary" : "outline"}
            size="icon"
            className="h-9 w-9"
            onClick={toggleTts}
            title={ttsPlaying ? "Hentikan bacaan" : "Bacakan halaman (TTS)"}
          >
            {ttsPlaying ? <Square className="size-4" /> : <Volume2 className="size-4" />}
          </Button>
        </div>

        {/* Alat anotasi */}
        <div className="flex items-center gap-1">
          <Button
            variant={tool === "hl" ? "secondary" : "outline"}
            size="icon"
            className="h-9 w-9"
            onClick={() => setTool(tool === "hl" ? "none" : "hl")}
            title="Stabilo — seret di halaman untuk menandai"
          >
            <Highlighter className="size-4" />
          </Button>
          <Button
            variant={tool === "pen" ? "secondary" : "outline"}
            size="icon"
            className="h-9 w-9"
            onClick={() => setTool(tool === "pen" ? "none" : "pen")}
            title="Pena — gambar bebas di halaman"
          >
            <Pen className="size-4" />
          </Button>
          <Button
            variant={tool === "erase" ? "secondary" : "outline"}
            size="icon"
            className="h-9 w-9"
            onClick={() => setTool(tool === "erase" ? "none" : "erase")}
            title="Penghapus — sentuh anotasi untuk menghapus"
          >
            <Eraser className="size-4" />
          </Button>
          <div className="flex items-center gap-1 px-1">
            {ANNO_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                aria-label={`Warna ${c}`}
                onClick={() => setColor(c)}
                className={cn(
                  "size-5 rounded-full border-2 transition-transform",
                  color === c
                    ? "border-foreground scale-110"
                    : "border-transparent hover:scale-105"
                )}
                style={{ backgroundColor: c }}
              />
            ))}
          </div>
          <Button
            variant="outline"
            size="icon"
            className="h-9 w-9"
            onClick={() => anno.undo()}
            disabled={anno.count === 0}
            title="Urungkan anotasi terakhir"
          >
            <Undo2 className="size-4" />
          </Button>
          <Button
            variant="outline"
            size="icon"
            className="h-9 w-9"
            onClick={() => anno.clearAll()}
            disabled={anno.count === 0}
            title="Hapus semua anotasi file ini"
          >
            <Trash2 className="size-4" />
          </Button>
        </div>
      </div>

      {/* Panel pencarian */}
      {searchOpen ? (
        <div className="px-3 py-2 border-b border-border bg-muted/40">
          <div className="flex items-center gap-2">
            <Input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void doSearch();
              }}
              placeholder="Cari kata di seluruh dokumen…"
              className="h-9 max-w-sm"
            />
            <Button size="sm" className="h-9" onClick={() => void doSearch()}>
              {searching ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Search className="size-4" />
              )}
              Cari
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-9 w-9"
              onClick={() => {
                setSearchOpen(false);
                setResults(null);
              }}
              title="Tutup pencarian"
            >
              <X className="size-4" />
            </Button>
          </div>
          {results ? (
            <div className="mt-2 max-h-32 overflow-auto text-sm">
              {results.length === 0 ? (
                <p className="text-muted-foreground px-1 py-1">
                  Tidak ditemukan.
                </p>
              ) : (
                results.map((r, i) => (
                  <button
                    key={i}
                    className="block w-full text-left px-2 py-1.5 rounded-md hover:bg-accent"
                    onClick={() => jumpResult(r.page)}
                  >
                    <span className="text-[11px] font-medium text-primary mr-2">
                      Hlm {r.page}
                    </span>
                    <span className="text-muted-foreground">{r.snippet}</span>
                  </button>
                ))
              )}
            </div>
          ) : null}
        </div>
      ) : null}

      {/* ── Area halaman ── */}
      <div
        ref={containerRef}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onScroll={onScroll}
        className={cn(
          "flex-1 min-h-0 overflow-auto outline-none",
          night ? "bg-neutral-900" : "bg-neutral-200 dark:bg-neutral-900/60"
        )}
      >
        <div className="flex flex-col items-center gap-4 py-4 px-3">
          {pageList.map((i) => (
            <PageView
              key={i}
              doc={doc}
              pageNo={i}
              width={pageWidth}
              ratio={ratioOf(i)}
              visible={visible.has(i)}
              onVisible={(v) =>
                setVisible((prev) => {
                  const next = new Set(prev);
                  if (v) next.add(i);
                  else next.delete(i);
                  return next;
                })
              }
              registerRef={(el) => {
                if (el) pageRefs.current.set(i, el);
                else pageRefs.current.delete(i);
              }}
              tool={tool}
              color={color}
              items={anno.items}
              onAdd={anno.add}
              onErase={anno.remove}
              night={night}
              flash={flashPage === i}
            />
          ))}
          {numPages > 0 ? (
            <p className="text-xs text-muted-foreground pb-2">
              {numPages} halaman · {anno.count > 0 ? `${anno.count} anotasi tersimpan di perangkat ini · ` : ""}
              Gunakan tombol ⯇ ⯈ atau PageUp/PageDown untuk berpindah halaman
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

// ───────────────────────── Satu halaman (render-on-visible) ─────────────────────────

function PageView({
  doc,
  pageNo,
  width,
  ratio,
  visible,
  onVisible,
  registerRef,
  tool,
  color,
  items,
  onAdd,
  onErase,
  night,
  flash,
}: {
  doc: PDFDocumentProxy;
  pageNo: number;
  width: number;
  ratio: number;
  visible: boolean;
  onVisible: (v: boolean) => void;
  registerRef: (el: HTMLDivElement | null) => void;
  tool: AnnoTool;
  color: string;
  items: Annotation[];
  onAdd: (a: Annotation) => void;
  onErase: (id: string) => void;
  night: boolean;
  flash: boolean;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [renderedFor, setRenderedFor] = useState<number | null>(null);
  const renderTaskRef = useRef<{ cancel: () => void } | null>(null);
  const [renderError, setRenderError] = useState(false);

  const height = Math.round(width * ratio);

  // Observasi visibilitas (render saat mendekat viewport).
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const en of entries) onVisible(en.isIntersecting);
      },
      { root: null, rootMargin: "120% 0px" }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [onVisible]);

  // Render canvas saat terlihat / ukuran berubah.
  useEffect(() => {
    if (!visible || renderedFor === width) return;
    let cancelled = false;
    (async () => {
      try {
        const p = await doc.getPage(pageNo);
        if (cancelled) return;
        const base = p.getViewport({ scale: 1 });
        const dpr = Math.min(
          typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1,
          2
        );
        const scale = (width * dpr) / base.width;
        const viewport = p.getViewport({ scale });
        const canvas = canvasRef.current;
        if (!canvas) return;
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        renderTaskRef.current?.cancel();
        const task = p.render({ canvasContext: ctx, viewport });
        renderTaskRef.current = task;
        await task.promise;
        if (!cancelled) setRenderedFor(width);
      } catch {
        if (!cancelled) setRenderError(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [visible, renderedFor, width, doc, pageNo]);

  return (
    <div
      ref={(el) => {
        wrapRef.current = el;
        registerRef(el);
      }}
      data-page={pageNo}
      className="relative shadow-lg"
      style={{
        width: `${width}px`,
        height: renderedFor ? undefined : `${height}px`,
        background: night ? "#18181b" : "#fff",
      }}
    >
      {/* Nomor halaman kecil (muncul sebelum render) */}
      {renderedFor === null && !renderError ? (
        <div
          className="absolute inset-0 flex items-center justify-center text-xs text-neutral-400"
          style={{ background: night ? "#27272a" : "#f5f5f4" }}
        >
          {renderError ? "Gagal merender halaman" : `Halaman ${pageNo}`}
        </div>
      ) : null}
      <canvas
        ref={canvasRef}
        className="block w-full"
        style={{ display: renderedFor === null ? "none" : "block" }}
      />
      <AnnotationLayer
        page={pageNo}
        tool={tool}
        color={color}
        items={items}
        onAdd={onAdd}
        onErase={onErase}
      />
      {flash ? (
        <div className="pointer-events-none absolute inset-0 ring-4 ring-primary animate-pulse rounded-sm" />
      ) : null}
    </div>
  );
}
