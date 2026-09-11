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
  ArrowDownUp,
  ArrowLeftRight,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import type { CloudFileItem } from "@/lib/cloud-format";
import type { OfficeCacheEntry } from "@/components/cloud/buffer-loader";
import {
  ANNO_COLORS,
  type AnnoTool,
  type Annotation,
  useAnnotations,
  newId,
} from "./annotations";
import { AnnotationLayer } from "./annotation-layer";
import { useSelectionMenu, SelectionToolbar } from "./selection-actions";
import type { PDFDocumentProxy } from "pdfjs-dist";

// ─────────────────────────────────────────────────────────────────────────
// Aula Reader — PDF.
// - Render cepat via pdf.js (worker terpisah): hanya halaman yang terlihat
//   yang dirender (render-on-visible + cache bitmap) → PDF 100 halaman /
//   40 MB tetap lancar bahkan di Smart TV / HP kentang.
// - LAPISAN TEKS transparan di atas kanvas → teks bisa diseleksi,
//   lalu menu muncul: Bacakan (TTS) · Stabilo · Salin.
// - Dua mode tampilan: VERTIKAL (gulir ke bawah) & HORIZONTAL (halaman
//   ke samping + snap/swipe — nyaman di ponsel).
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

export type ViewMode = "vertical" | "horizontal";
const VM_KEY = "aula.reader.viewmode";

function loadViewMode(): ViewMode {
  try {
    return localStorage.getItem(VM_KEY) === "horizontal"
      ? "horizontal"
      : "vertical";
  } catch {
    return "vertical";
  }
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
  const [zoom, setZoom] = useState(1); // 1 = pas lebar (vertikal) / pas tinggi (horizontal)
  const [page, setPage] = useState(1);
  const [night, setNight] = useState(false);
  const [tool, setTool] = useState<AnnoTool>("none");
  const [color, setColor] = useState(ANNO_COLORS[0]);
  const [containerW, setContainerW] = useState(0);
  const [containerH, setContainerH] = useState(0);
  const [visible, setVisible] = useState<Set<number>>(new Set([1]));
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<
    { page: number; snippet: string }[] | null
  >(null);
  const [searching, setSearching] = useState(false);
  const [ttsPlaying, setTtsPlaying] = useState(false);
  const [flashPage, setFlashPage] = useState<number | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>(loadViewMode);

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
          try {
            (loaded as unknown as { cleanup?: () => void }).cleanup?.();
          } catch {
            /* abaikan */
          }
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
      // pdfjs-dist 6: PDFDocumentProxy tidak lagi punya destroy() publik —
      // bebaskan memori via cleanup() bila tersedia, selalu dalam try/catch
      // supaya error API tidak merusak unmount.
      const d = loaded as unknown as { cleanup?: () => void; destroy?: () => void };
      try {
        d?.cleanup?.();
      } catch {
        /* abaikan */
      }
    };
  }, [entry.buffer, file.storageKey]);

  // ── Ukuran container (responsive; TV besar → halaman besar) ──
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const en of entries) {
        setContainerW(en.contentRect.width);
        setContainerH(en.contentRect.height);
      }
    });
    ro.observe(el);
    setContainerW(el.clientWidth);
    setContainerH(el.clientHeight);
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

  const ratioOf = useCallback(
    (i: number) => {
      const d = dims[i];
      return d ? d.h / d.w : defaultRatio;
    },
    [dims]
  );

  // ── Lebar halaman per mode ──
  // Vertikal: pas-lebar (w). Horizontal: pas-TINGGI (h) → lebar = h/rasio.
  const pageWidthOf = useCallback(
    (i: number) => {
      if (viewMode === "horizontal") {
        const h = containerH > 100 ? (containerH - 32) * zoom : 360;
        return Math.max(120, h / ratioOf(i));
      }
      return Math.max(280, containerW - 32) * zoom;
    },
    [viewMode, containerW, containerH, zoom, ratioOf]
  );

  // ── Halaman aktif (saat scroll — mendukung kedua mode) ──
  const onScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    let cur = 1;
    if (viewMode === "horizontal") {
      const center = el.scrollLeft + el.clientWidth / 2;
      for (let i = 1; i <= numPages; i++) {
        const node = pageRefs.current.get(i);
        if (!node) continue;
        if (node.offsetLeft <= center) cur = i;
        else break;
      }
    } else {
      const mid = el.scrollTop + el.clientHeight * 0.35;
      for (let i = 1; i <= numPages; i++) {
        const node = pageRefs.current.get(i);
        if (!node) continue;
        if (node.offsetTop <= mid) cur = i;
        else break;
      }
    }
    setPage(cur);
  }, [numPages, viewMode]);

  // ── Jump ke halaman ──
  const gotoPage = useCallback(
    (n: number) => {
      const target = Math.min(Math.max(1, n), numPages || 1);
      const node = pageRefs.current.get(target);
      if (node) {
        node.scrollIntoView({
          behavior: "smooth",
          block: viewMode === "horizontal" ? "nearest" : "start",
          inline: viewMode === "horizontal" ? "center" : "nearest",
        });
      }
      setPage(target);
    },
    [numPages, viewMode]
  );

  // ── Zoom ──
  const changeZoom = useCallback(
    (delta: number) => {
      setZoom((z) => Math.min(4, Math.max(0.5, +(z + delta).toFixed(2))));
    },
    []
  );

  // ── Mode tampilan (persist) ──
  const toggleViewMode = useCallback(() => {
    setViewMode((m) => {
      const next = m === "vertical" ? "horizontal" : "vertical";
      try {
        localStorage.setItem(VM_KEY, next);
      } catch {
        /* abaikan */
      }
      toast.success(
        next === "vertical"
          ? "Mode vertikal — gulir ke bawah antar halaman"
          : "Mode horizontal — geser ke samping antar halaman"
      );
      return next;
    });
  }, []);

  // Ganti mode → posisi scroll lama (mis. scrollLeft horizontal) tidak boleh
  // terbawa ke mode baru (dulu: halaman tergeser keluar layar setelah toggle).
  const pageRef = useRef(page);
  pageRef.current = page;
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    el.scrollTo({ left: 0, top: 0 });
    const node = pageRefs.current.get(pageRef.current);
    if (node)
      node.scrollIntoView({
        block: viewMode === "horizontal" ? "nearest" : "start",
        inline: viewMode === "horizontal" ? "center" : "start",
      });
  }, [viewMode]);

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

  // ── Menu seleksi teks (Bacakan / Stabilo / Salin) ──
  const sel = useSelectionMenu({
    containerRef,
    withinSelector: ".pdf-text-layer",
    onHighlight: ({ page: p, rects }) => {
      // Satu anotasi per baris seleksi — presisi mengikuti teks.
      for (const rect of rects) {
        anno.add({
          id: newId(),
          page: p,
          tool: "hl",
          color,
          rect,
          created: Date.now(),
        });
      }
      toast.success(`Teks ditandai stabilo ${color === ANNO_COLORS[0] ? "kuning" : ""}`.trim());
    },
    activeColor: color,
  });

  // TTS seleksi & TTS halaman berbagi speechSynthesis → hentikan yang lain.
  const speakSelection = useCallback(
    (text: string) => {
      if (ttsPlaying) {
        ttsStop.current = true;
        window.speechSynthesis.cancel();
        setTtsPlaying(false);
      }
      sel.speak(text);
    },
    [ttsPlaying, sel]
  );

  // ── Keyboard (remote TV / keyboard) ──
  // Shift+panah dibiarkan untuk seleksi teks via keyboard.
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.shiftKey) return;
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
      } else if (e.key.toLowerCase() === "h") {
        toggleViewMode();
      }
    },
    [page, gotoPage, changeZoom, toggleViewMode]
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
    <div className="flex flex-col flex-1 h-full min-h-0">
      {/* ── Toolbar (satu baris, bisa digulir ke samping di layar sempit —
          dulu flex-wrap: 4 baris di HP memakan ruang file & menutup tool) ── */}
      <div
        className={cn(
          "flex items-center gap-1.5 px-3 py-2 border-b border-border bg-background/95 z-20",
          "flex-nowrap overflow-x-auto",
          "[scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden"
        )}
      >
        <div className="flex items-center gap-1 shrink-0">
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

        <div className="flex items-center gap-1 shrink-0">
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
            title="Pas layar"
          >
            <Maximize className="size-4" />
          </Button>
          {/* Mode tampilan: vertikal ⇅ / horizontal ⇄ */}
          <Button
            variant={viewMode === "horizontal" ? "secondary" : "outline"}
            size="icon"
            className="h-9 w-9"
            onClick={toggleViewMode}
            title={
              viewMode === "vertical"
                ? "Mode horizontal — halaman bergeser ke samping (tekan H)"
                : "Mode vertikal — halaman bergulir ke bawah (tekan H)"
            }
          >
            {viewMode === "vertical" ? (
              <ArrowDownUp className="size-4" />
            ) : (
              <ArrowLeftRight className="size-4" />
            )}
          </Button>
        </div>

        <div className="flex items-center gap-1 shrink-0">
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
        <div className="flex items-center gap-1 shrink-0">
          <Button
            variant={tool === "hl" ? "secondary" : "outline"}
            size="icon"
            className="h-9 w-9"
            onClick={() => setTool(tool === "hl" ? "none" : "hl")}
            title="Stabilo — seret di halaman, atau blok teks lalu pilih Stabilo"
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
          <div className="flex items-center gap-1 px-1 shrink-0">
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
          "relative flex-1 min-h-0 overflow-auto outline-none",
          viewMode === "horizontal" && "snap-x snap-mandatory",
          night ? "bg-neutral-900 pdf-night" : "bg-neutral-200 dark:bg-neutral-900/60"
        )}
      >
        <div
          className={cn(
            viewMode === "vertical"
              ? "flex flex-col items-center gap-4 py-4 px-3"
              : "flex flex-row items-stretch h-full w-max gap-4 px-3 py-4"
          )}
        >
          {pageList.map((i) => (
            <PageView
              key={i}
              doc={doc}
              pageNo={i}
              width={pageWidthOf(i)}
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
              horizontal={viewMode === "horizontal"}
            />
          ))}
          {numPages > 0 && viewMode === "vertical" ? (
            <p className="text-xs text-muted-foreground pb-2 px-4">
              {numPages} halaman · {anno.count > 0 ? `${anno.count} anotasi tersimpan di perangkat ini · ` : ""}
              Blok teks lalu pilih Bacakan / Stabilo / Salin · gunakan ⯇ ⯈ atau geser
            </p>
          ) : null}
        </div>

        {/* Menu aksi teks terpilih */}
        {sel.menu ? (
          <SelectionToolbar
            menu={sel.menu}
            playing={sel.playing}
            onSpeak={speakSelection}
            onStopSpeak={sel.stopSpeak}
            onHighlight={sel.highlight}
            onCopy={(ok) =>
              ok ? toast.success("Teks tersalin") : toast.error("Gagal menyalin")
            }
            onClose={sel.closeMenu}
            activeColor={color}
          />
        ) : null}
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
  horizontal,
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
  horizontal: boolean;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  const [renderedFor, setRenderedFor] = useState<number | null>(null);
  const [textFor, setTextFor] = useState<number | null>(null);
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

  // ── Lapisan teks (agar bisa diseleksi / dibacakan / distabilo) ──
  // Span transparan diposisikan persis di atas tiap item teks pdf.js;
  // lebar disesuaikan dengan transform scaleX (teknik viewer resmi pdf.js).
  useEffect(() => {
    if (!visible || textFor === width) return;
    let cancelled = false;
    (async () => {
      try {
        const pdfjs = await getPdfjs();
        const p = await doc.getPage(pageNo);
        if (cancelled) return;
        const base = p.getViewport({ scale: 1 });
        // Skala CSS-pixel (tanpa dpr) — kanvas tampil selebar `width`.
        const viewport = p.getViewport({ scale: width / base.width });
        const tc = await p.getTextContent();
        const el = textLayerRef.current;
        if (!el || cancelled) return;
        el.replaceChildren();
        const frag = document.createDocumentFragment();
        const spans: [HTMLSpanElement, { left: number; top: number; fontHeight: number; angle: number; targetW: number }][] = [];
        for (const item of tc.items as unknown as Array<{
          str?: string;
          transform?: number[];
          width?: number;
        }>) {
          if (!item.str || !item.str.trim() || !item.transform) continue;
          const tx = pdfjs.Util.transform(
            viewport.transform,
            item.transform
          );
          const fontHeight = Math.hypot(tx[2], tx[3]);
          const left = tx[4];
          const top = tx[5] - fontHeight; // pdf.js: top = baseline - tinggi font
          const angle = Math.atan2(tx[1], tx[0]);
          const span = document.createElement("span");
          span.textContent = item.str;
          frag.appendChild(span);
          spans.push([
            span,
            {
              left,
              top,
              fontHeight,
              angle,
              targetW: (item.width ?? 0) * viewport.scale,
            },
          ]);
        }
        el.appendChild(frag);
        // Setelah di DOM → ukur lebar asli → sesuaikan dengan scaleX.
        for (const [span, m] of spans) {
          span.style.left = `${m.left}px`;
          span.style.top = `${m.top}px`;
          span.style.fontSize = `${m.fontHeight}px`;
          const naturalW = span.getBoundingClientRect().width || 1;
          const sx = m.targetW > 0 ? m.targetW / naturalW : 1;
          const t: string[] = [];
          if (Math.abs(m.angle) > 0.001) t.push(`rotate(${m.angle}rad)`);
          if (Math.abs(sx - 1) > 0.01) t.push(`scaleX(${sx})`);
          if (t.length) span.style.transform = t.join(" ");
        }
        if (!cancelled) setTextFor(width);
      } catch {
        /* teks tak tersedia — halaman tetap terlihat, hanya tak bisa diseleksi */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [visible, textFor, width, doc, pageNo]);

  return (
    <div
      ref={(el) => {
        wrapRef.current = el;
        registerRef(el);
      }}
      data-page={pageNo}
      className={cn(
        "relative shadow-lg",
        horizontal && "snap-center shrink-0 my-auto"
      )}
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
      {/* Lapisan teks: seleksi diaktifkan saat tak ada alat anotasi aktif */}
      <div
        ref={textLayerRef}
        className={cn(
          "pdf-text-layer",
          tool !== "none" && "tool-active"
        )}
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
