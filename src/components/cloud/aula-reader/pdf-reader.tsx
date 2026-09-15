"use client";

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
  Focus,
  Columns2,
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
import { useReaderUiStore } from "@/stores/reader-ui-store";
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
const FOCUS_KEY = "aula.reader.focus";
const PERVIEW_KEY = "aula.reader.perview";

/** Jumlah halaman per layar: 1, atau 2 berdampingan (mode buku). */
type PerView = 1 | 2;

function loadBoolPref(key: string): boolean {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function loadPerView(): PerView {
  try {
    return localStorage.getItem(PERVIEW_KEY) === "2" ? 2 : 1;
  } catch {
    return 1;
  }
}

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
  /** Mode fokus — bilah alat melayang (auto-hide) + header jendela
   *  disembunyikan → area halaman maksimal. Persist per browser. */
  const [focus, setFocus] = useState(() => loadBoolPref(FOCUS_KEY));
  /** Bilah alat melayang terlihat? (mode fokus saja; auto-hide saat gulir) */
  const [toolbarVisible, setToolbarVisible] = useState(true);
  /** Halaman per layar (1 / 2 — mode buku). Persist per browser. */
  const [perView, setPerView] = useState<PerView>(loadPerView);
  /** Teks input nomor halaman saat sedang diedit (null = ikut page). */
  const [pageInput, setPageInput] = useState<string | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const pageRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  /** Mirror state `page` (dibaca callback stabil tanpa dependensi). */
  const pageRef = useRef(page);
  pageRef.current = page;
  /** Jangkar zoom: halaman aktif + fraksi posisi di dalamnya — agar
   *  halaman TIDAK "pindah" saat zoom (dulu: ukuran semua halaman berubah
   *  → konten bergeser sendiri & halaman aktif bisa berubah). */
  const zoomAnchor = useRef<{ page: number; frac: number } | null>(null);
  const textCache = useRef<Map<number, string>>(new Map());
  const ttsStop = useRef(false);
  /** Sudahkah laporan perubahan halaman pertama dilewati (init/restore). */
  const pageReportInit = useRef(false);
  /** Sudahkah posisi baca tersimpan di-restore untuk file ini. */
  const restored = useRef(false);

  const anno = useAnnotations(file.storageKey);

  // Mode fokus perlu dibaca PreviewWindow (untuk menyembunyikan header
  // jendelanya) — sinkronkan ke store global, di-key per storageKey.
  const setReaderFocus = useReaderUiStore((s) => s.setFocus);
  useEffect(() => {
    setReaderFocus(file.storageKey, focus);
  }, [focus, file.storageKey, setReaderFocus]);

  // ── Load dokumen ──
  useEffect(() => {
    let cancelled = false;
    let loaded: PDFDocumentProxy | null = null;
    setDoc(null);
    setError(null);
    setNumPages(0);
    setDims({});
    setPage(1);
    setPageInput(null);
    pageReportInit.current = false;
    restored.current = false;
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
  // Mode buku (perView 2): juga dibatasi lebar agar 2 halaman muat bersebelah.
  const pageWidthOf = useCallback(
    (i: number) => {
      const GAP = 16; // gap-4 antar halaman
      if (viewMode === "horizontal") {
        const h = containerH > 100 ? (containerH - 32) * zoom : 360;
        let w = h / ratioOf(i);
        if (perView === 2) {
          const wBySpread = (containerW - 24 - GAP) / 2;
          w = Math.min(w, wBySpread);
        }
        return Math.max(120, w);
      }
      if (perView === 2) {
        // Vertikal 2 kolom: tiap halaman separuh lebar wadah.
        return Math.max(120, (containerW - 24 - GAP) / 2) * zoom;
      }
      return Math.max(280, containerW - 32) * zoom;
    },
    [viewMode, containerW, containerH, zoom, ratioOf, perView]
  );

  // ── Laporkan halaman aktif → tersimpan di MongoDB (lanjut baca lain
  // waktu / perangkat). Laporan PERTAMA (init & restore) dilewati supaya
  // tidak menimpa posisi tersimpan dengan halaman 1.
  useEffect(() => {
    if (!doc || numPages === 0) return;
    if (!pageReportInit.current) {
      pageReportInit.current = true;
      return;
    }
    anno.reportPage(page);
    // reportPage stabil (debounce internal); page memicu effect ini.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, doc, numPages]);

  // ── Restore posisi baca terakhir (dari MongoDB) sekali per file ──
  useEffect(() => {
    if (!doc || numPages === 0 || restored.current) return;
    if (anno.savedPage > 1 && anno.savedPage <= numPages) {
      const el = containerRef.current;
      const belumScroll =
        !el || (el.scrollTop === 0 && el.scrollLeft === 0);
      if (belumScroll) {
        restored.current = true;
        gotoPage(anno.savedPage);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, numPages, anno.savedPage]);

  // ── Halaman aktif (saat scroll — mendukung kedua mode) ──
  const lastScrollPos = useRef(0);
  const onScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    // Mode fokus: gulir maju menyembunyikan bilah alat melayang; gulir
    // mundur menampilkannya kembali (pola bilah alat aplikasi modern).
    if (focus) {
      const pos = viewMode === "horizontal" ? el.scrollLeft : el.scrollTop;
      if (pos > lastScrollPos.current + 4) {
        setToolbarVisible(false);
        lastScrollPos.current = pos;
      } else if (pos < lastScrollPos.current - 4) {
        setToolbarVisible(true);
        lastScrollPos.current = pos;
      } else {
        lastScrollPos.current = pos;
      }
    }
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
    setPage((prev) => (prev === cur ? prev : cur));
  }, [numPages, viewMode, focus]);

  // ── Jump ke halaman (sadar-mode-buku: lompat ke spread berisi halaman) ──
  const spreadRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const registerSpread = useCallback((si: number, el: HTMLDivElement | null) => {
    if (el) spreadRefs.current.set(si, el);
    else spreadRefs.current.delete(si);
  }, []);

  const gotoPage = useCallback(
    (n: number) => {
      const target = Math.min(Math.max(1, n), numPages || 1);
      const spreadNode =
        viewMode === "horizontal" && perView === 2
          ? spreadRefs.current.get(Math.floor((target - 1) / 2))
          : null;
      if (spreadNode) {
        spreadNode.scrollIntoView({
          behavior: "smooth",
          block: "nearest",
          inline: "center",
        });
      } else {
        const node = pageRefs.current.get(target);
        if (node) {
          node.scrollIntoView({
            behavior: "smooth",
            block: viewMode === "horizontal" ? "nearest" : "start",
            inline: viewMode === "horizontal" ? "center" : "nearest",
          });
        }
      }
      setPage(target);
    },
    [numPages, viewMode, perView]
  );

  // ── Zoom ──
  // Sebelum zoom berubah, catat posisi relatif (fraksi 0..1) di dalam
  // halaman aktif → setelah layout baru dipasang, scroll dikembalikan ke
  // titik itu. Tanpa ini: tinggi/lebar SEMUA halaman berubah → halaman
  // aktif bergeser sendiri / "pindah" halaman saat zoom.
  const applyZoom = useCallback(
    (next: number) => {
      const z = Math.min(4, Math.max(0.5, +next.toFixed(2)));
      if (z === zoom) return;
      const el = containerRef.current;
      const node = pageRefs.current.get(pageRef.current);
      if (el && node) {
        zoomAnchor.current = {
          page: pageRef.current,
          frac:
            viewMode === "vertical"
              ? (el.scrollTop - node.offsetTop) /
                Math.max(1, node.offsetHeight)
              : (el.scrollLeft - node.offsetLeft) /
                Math.max(1, node.offsetWidth),
        };
      }
      setZoom(z);
    },
    [zoom, viewMode]
  );

  const changeZoom = useCallback(
    (delta: number) => applyZoom(zoom + delta),
    [applyZoom, zoom]
  );

  // Pulihkan jangkar zoom SEBELUM paint (useLayoutEffect — layout baru
  // sudah terpasang, belum terlihat → tak ada "loncatan").
  useLayoutEffect(() => {
    const a = zoomAnchor.current;
    if (!a) return;
    zoomAnchor.current = null;
    const el = containerRef.current;
    const node = pageRefs.current.get(a.page);
    if (!el || !node) return;
    if (viewMode === "vertical") {
      el.scrollTop = node.offsetTop + a.frac * node.offsetHeight;
    } else {
      // Horizontal: snap-mandatory menata ulang — cukup pastikan halaman
      // aktif yang berada di tengah viewport.
      el.scrollLeft = Math.max(
        0,
        node.offsetLeft - (el.clientWidth - node.offsetWidth) / 2
      );
    }
  }, [zoom, viewMode]);

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

  // Ganti mode / jumlah halaman per layar → posisi scroll lama (mis.
  // scrollLeft horizontal) tidak boleh terbawa ke mode baru (dulu: halaman
  // tergeser keluar layar setelah toggle).
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
  }, [viewMode, perView]);

  // ── Mode fokus & halaman per layar ──
  const toggleFocus = useCallback(() => {
    setFocus((v) => {
      const next = !v;
      try {
        localStorage.setItem(FOCUS_KEY, next ? "1" : "0");
      } catch {
        /* abaikan */
      }
      toast.success(
        next
          ? "Mode fokus aktif — halaman memenuhi layar (Esc untuk keluar)"
          : "Mode fokus dimatikan"
      );
      if (next) requestAnimationFrame(() => containerRef.current?.focus());
      return next;
    });
    setToolbarVisible(true);
  }, []);

  const togglePerView = useCallback(() => {
    setPerView((v) => {
      const next: PerView = v === 1 ? 2 : 1;
      try {
        localStorage.setItem(PERVIEW_KEY, String(next));
      } catch {
        /* abaikan */
      }
      toast.success(
        next === 2
          ? "2 halaman per layar — mode buku"
          : "1 halaman per layar"
      );
      return next;
    });
  }, []);

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

  // ── Keyboard (remote TV / keyboard / alat bantu) ──
  // Shift+panah dibiarkan untuk seleksi teks via keyboard.
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape" && focus) {
        // Mode fokus: Esc keluar dari fokus DULU (bukan menutup jendela).
        e.preventDefault();
        e.stopPropagation();
        toggleFocus();
        return;
      }
      if (e.shiftKey) return;
      if (e.key === "PageDown" || e.key === "ArrowRight") {
        e.preventDefault();
        // Mode buku horizontal: panah membalik per SPREAD (2 halaman).
        const step = viewMode === "horizontal" && perView === 2 ? perView : 1;
        gotoPage(page + step);
      } else if (e.key === "PageUp" || e.key === "ArrowLeft") {
        e.preventDefault();
        const step = viewMode === "horizontal" && perView === 2 ? perView : 1;
        gotoPage(page - step);
      } else if (e.key === "Home") {
        e.preventDefault();
        gotoPage(1);
      } else if (e.key === "End") {
        e.preventDefault();
        gotoPage(numPages);
      } else if (e.key === "+" || e.key === "=") {
        changeZoom(0.25);
      } else if (e.key === "-") {
        changeZoom(-0.25);
      } else if (e.key.toLowerCase() === "f") {
        applyZoom(1);
      } else if (e.key.toLowerCase() === "n") {
        setNight((v) => !v);
      } else if (e.key.toLowerCase() === "h") {
        toggleViewMode();
      }
    },
    [page, numPages, focus, viewMode, perView, gotoPage, changeZoom, toggleViewMode, applyZoom, toggleFocus]
  );

  const pageList = useMemo(() => {
    const arr: number[] = [];
    for (let i = 1; i <= numPages; i++) arr.push(i);
    return arr;
  }, [numPages]);

  /** Mode buku horizontal: kelompokkan halaman per spread (2 berdampingan). */
  const spreads = useMemo(() => {
    if (viewMode !== "horizontal" || perView !== 2) return null;
    const arr: number[][] = [];
    for (let i = 1; i <= numPages; i += 2) {
      arr.push([i, Math.min(i + 1, numPages)]);
    }
    return arr;
  }, [viewMode, perView, numPages]);

  // Callback stabil supaya PageView (React.memo) tidak re-render ketika
  // parent ganti state yang tak terkait. (Dulu: onVisible & registerRef
  // inline → SEMUA halaman re-render pada tiap scroll tick; observer
  // juga dibongkar-pasang terus.)
  const handleVisible = useCallback((i: number, v: boolean) => {
    setVisible((prev) => {
      const next = new Set(prev);
      if (v) next.add(i);
      else next.delete(i);
      return next;
    });
  }, []);
  const registerPage = useCallback(
    (i: number, el: HTMLDivElement | null) => {
      if (el) pageRefs.current.set(i, el);
      else pageRefs.current.delete(i);
    },
    []
  );

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
    <div className="relative flex flex-col flex-1 h-full min-h-0">
      {/* Pengumuman halaman aktif untuk pembaca layar / alat bantu */}
      <span className="sr-only" role="status" aria-live="polite">
        Halaman {page} dari {numPages}
      </span>
      {/* ── Toolbar (satu baris, bisa digulir ke samping di layar sempit —
          dulu flex-wrap: 4 baris di HP memakan ruang file & menutup tool).
          MODE FOKUS: melayang di atas halaman, transparan, auto-hide. ── */}
      <div
        role="toolbar"
        aria-label="Alat pembaca dokumen"
        className={cn(
          "flex items-center gap-1.5 px-3 py-2 z-30",
          "flex-nowrap overflow-x-auto",
          "[scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden",
          focus
            ? cn(
                "absolute left-1/2 top-2 -translate-x-1/2 rounded-full border border-border/70",
                "bg-background/90 backdrop-blur shadow-lg max-w-[calc(100%-16px)]",
                "transition-[opacity,translate] duration-300",
                !toolbarVisible && "opacity-0 pointer-events-none -translate-y-[130%]"
              )
            : "border-b border-border bg-background/95 z-20"
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
            aria-label="Halaman sebelumnya"
          >
            <ChevronLeft className="size-4" />
          </Button>
          <span className="text-sm tabular-nums px-1 whitespace-nowrap">
            <input
              className="w-12 h-9 text-center rounded-md border border-input bg-transparent focus:outline-none focus:ring-1 focus:ring-ring"
              value={pageInput ?? String(page)}
              inputMode="numeric"
              autoComplete="off"
              onFocus={(e) => {
                // Select-all saat diklik/fokus — ditunda satu frame karena
                // penempatan caret default dari click menimpa seleksi.
                const el = e.currentTarget;
                requestAnimationFrame(() => el.select());
              }}
              onChange={(e) =>
                setPageInput(e.target.value.replace(/[^\d]/g, "").slice(0, 6))
              }
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.currentTarget.blur(); // commit di onBlur
                } else if (e.key === "Escape") {
                  setPageInput(null);
                  e.currentTarget.blur();
                }
              }}
              onBlur={() => {
                if (pageInput === null) return;
                const n = parseInt(pageInput, 10);
                setPageInput(null);
                if (!Number.isNaN(n)) gotoPage(n);
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
            aria-label="Halaman berikutnya"
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
            aria-label="Perkecil tampilan"
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
            aria-label="Perbesar tampilan"
          >
            <ZoomIn className="size-4" />
          </Button>
          <Button
            variant="outline"
            size="icon"
            className="h-9 w-9"
            onClick={() => applyZoom(1)}
            title="Pas layar"
            aria-label="Pas layar"
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
            aria-label={
              viewMode === "vertical"
                ? "Ganti ke mode horizontal"
                : "Ganti ke mode vertikal"
            }
          >
            {viewMode === "vertical" ? (
              <ArrowDownUp className="size-4" />
            ) : (
              <ArrowLeftRight className="size-4" />
            )}
          </Button>
          {/* Halaman per layar: 1 / 2 (mode buku) */}
          <Button
            variant={perView === 2 ? "secondary" : "outline"}
            size="icon"
            className="h-9 w-9"
            onClick={togglePerView}
            disabled={numPages < 2}
            title={
              perView === 2
                ? "Satu halaman per layar"
                : "Dua halaman per layar (mode buku)"
            }
            aria-label={
              perView === 2
                ? "Satu halaman per layar"
                : "Dua halaman per layar, mode buku"
            }
          >
            <Columns2 className="size-4" />
          </Button>
          {/* Mode fokus: bilah alat auto-hide, halaman memenuhi layar */}
          <Button
            variant={focus ? "secondary" : "outline"}
            size="icon"
            className="h-9 w-9"
            onClick={toggleFocus}
            title="Mode fokus — halaman memenuhi layar, bilah alat disembunyikan (Esc keluar)"
            aria-label="Mode fokus"
          >
            <Focus className="size-4" />
          </Button>
        </div>

        <div className="flex items-center gap-1 shrink-0">
          <Button
            variant="outline"
            size="icon"
            className="h-9 w-9"
            onClick={() => setNight((v) => !v)}
            title={night ? "Mode terang" : "Mode malam (nyaman di gelap)"}
            aria-label={night ? "Mode terang" : "Mode malam"}
          >
            {night ? <Sun className="size-4" /> : <Moon className="size-4" />}
          </Button>
          <Button
            variant={searchOpen ? "secondary" : "outline"}
            size="icon"
            className="h-9 w-9"
            onClick={() => setSearchOpen((v) => !v)}
            title="Cari teks di dokumen"
            aria-label="Cari teks di dokumen"
          >
            <Search className="size-4" />
          </Button>
          <Button
            variant={ttsPlaying ? "secondary" : "outline"}
            size="icon"
            className="h-9 w-9"
            onClick={toggleTts}
            title={ttsPlaying ? "Hentikan bacaan" : "Bacakan halaman (TTS)"}
            aria-label={ttsPlaying ? "Hentikan bacaan" : "Bacakan halaman"}
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
            aria-label="Alat stabilo"
          >
            <Highlighter className="size-4" />
          </Button>
          <Button
            variant={tool === "pen" ? "secondary" : "outline"}
            size="icon"
            className="h-9 w-9"
            onClick={() => setTool(tool === "pen" ? "none" : "pen")}
            title="Pena — gambar bebas di halaman"
            aria-label="Alat pena"
          >
            <Pen className="size-4" />
          </Button>
          <Button
            variant={tool === "erase" ? "secondary" : "outline"}
            size="icon"
            className="h-9 w-9"
            onClick={() => setTool(tool === "erase" ? "none" : "erase")}
            title="Penghapus — sentuh anotasi untuk menghapus"
            aria-label="Alat penghapus"
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
            aria-label="Urungkan anotasi terakhir"
          >
            <Undo2 className="size-4" />
          </Button>
          <Button
            variant="outline"
            size="icon"
            className="h-9 w-9"
            onClick={() => anno.clearAll()}
            disabled={anno.count === 0}
            title="Hapus semua anotasi file ini (tersimpan di akunmu)"
            aria-label="Hapus semua anotasi"
          >
            <Trash2 className="size-4" />
          </Button>
        </div>
      </div>

      {/* Panel pencarian */}
      {searchOpen ? (
        <div
          className={cn(
            "px-3 py-2 border-b border-border bg-muted/40 z-30",
            focus &&
              "absolute left-1/2 top-14 -translate-x-1/2 rounded-xl border-border shadow-lg bg-background/95 backdrop-blur max-w-[calc(100%-16px)]"
          )}
        >
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
        role="region"
        aria-label="Halaman dokumen — panah kiri/kanan pindah halaman, tombol plus/minus zoom, tanda minus untuk Home/End"
        onKeyDown={onKeyDown}
        onScroll={onScroll}
        onMouseMove={(e) => {
          // Mode fokus: dekati tepi atas → tampilkan bilah alat melayang.
          if (!focus) return;
          const rect = e.currentTarget.getBoundingClientRect();
          if (e.clientY - rect.top < 96) setToolbarVisible(true);
        }}
        className={cn(
          "relative flex-1 min-h-0 overflow-auto outline-none",
          "focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
          // Snap HANYA saat pas-layar (zoom 1). Saat di-zoom, snap-mandatory
          // justru MENCEGAH pembaca menggeser/melihat detail halaman
          // (scroll selalu dipaksa kembali ke tengah halaman) — bug lama.
          viewMode === "horizontal" && zoom === 1 && "snap-x snap-mandatory",
          night ? "bg-neutral-900 pdf-night" : "bg-neutral-200 dark:bg-neutral-900/60"
        )}
      >
        <div
          className={cn(
            viewMode === "vertical"
              ? perView === 2
                ? "grid grid-cols-2 justify-items-center gap-4 py-4 px-3"
                : "flex flex-col items-center gap-4 py-4 px-3"
              : "flex flex-row items-stretch h-full w-max gap-4 px-3 py-4"
          )}
        >
          {spreads
            ? spreads.map((sp, si) => (
                <div
                  key={si}
                  ref={(el) => registerSpread(si, el)}
                  data-spread={si}
                  className="flex items-center h-full gap-4 snap-center shrink-0"
                >
                  {sp.map((i) => (
                    <PageView
                      key={i}
                      doc={doc}
                      pageNo={i}
                      width={pageWidthOf(i)}
                      ratio={ratioOf(i)}
                      visible={visible.has(i)}
                      onVisible={handleVisible}
                      registerRef={registerPage}
                      tool={tool}
                      color={color}
                      items={anno.items}
                      onAdd={anno.add}
                      onErase={anno.remove}
                      night={night}
                      flash={flashPage === i}
                      horizontal={false}
                    />
                  ))}
                </div>
              ))
            : pageList.map((i) => (
                <PageView
                  key={i}
                  doc={doc}
                  pageNo={i}
                  width={pageWidthOf(i)}
                  ratio={ratioOf(i)}
                  visible={visible.has(i)}
                  onVisible={handleVisible}
                  registerRef={registerPage}
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
            <p className="text-xs text-muted-foreground pb-2 px-4 col-span-full">
              {numPages} halaman · {anno.count > 0 ? `${anno.count} anotasi tersimpan di akunmu · ` : ""}
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

      {/* Tombol melayang keluar-fokus — selalu terlihat di mode fokus */}
      {focus ? (
        <Button
          variant="outline"
          size="icon"
          className="absolute bottom-4 right-4 z-30 size-11 rounded-full bg-background/85 backdrop-blur border-border/70 shadow-lg"
          onClick={toggleFocus}
          title="Keluar mode fokus (Esc)"
          aria-label="Keluar mode fokus"
        >
          <Focus className="size-4" />
        </Button>
      ) : null}
    </div>
  );
}

// ───────────────────────── Satu halaman (render-on-visible) ─────────────────────────
// React.memo + props stabil dari parent: halaman yang tak berubah TIDAK
// ikut re-render (penting saat scroll / ganti state di reader).

const PageView = memo(function PageView({
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
  onVisible: (pageNo: number, v: boolean) => void;
  registerRef: (pageNo: number, el: HTMLDivElement | null) => void;
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

  // Observasi visibilitas (render saat mendekat viewport). Callback lewat
  // ref + deps [] → observer dibuat SEKALI per halaman (dulu: dibongkar-
  // pasang setiap render karena onVisible inline dari parent).
  const onVisibleRef = useRef(onVisible);
  onVisibleRef.current = onVisible;
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const en of entries)
          onVisibleRef.current(pageNo, en.isIntersecting);
      },
      { root: null, rootMargin: "120% 0px" }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [pageNo]);

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
        registerRef(pageNo, el);
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
});
