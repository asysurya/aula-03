"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  Download,
  Loader2,
  FileWarning,
  FileArchive,
  FileText,
  Copy,
  Check,
  Maximize2,
  Minimize2,
  PictureInPicture2,
  ExternalLink,
  BookOpenText,
  Monitor,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AiMarkdown } from "@/components/ai/ai-markdown";
import { filePublicUrl } from "@/lib/file-constants";
import { formatBytes, type CloudFileItem } from "@/lib/cloud-format";
import { useTransferStore } from "@/lib/transfer-store";
import { usePreviewStore } from "@/stores/preview-store";
import {
  classify as classifyKind,
  ext as fileExt,
  docxHtmlCache,
  xlsxSheetsCache,
  useOfficeBuffer,
  formatSpeed,
  type FetchProgress,
  type OfficeCacheEntry,
  type PreviewKind,
} from "./buffer-loader";
import type { PreviewMode } from "./aula-reader/mode-chooser";

function classify(mime: string, name: string): PreviewKind {
  return classifyKind(mime, name);
}

function ext(name: string): string {
  return fileExt(name);
}

// ───────────────────────── Component utama ─────────────────────────

// FilePreview kini HANYA ADAPTER menuju registry global pratinjau
// (preview-store + preview-layer). Tanda tangan komponen dipertahankan
// agar semua host (file-browser, mega-mount, form-review, assignment-
// detail) tidak perlu diubah:
//   <FilePreview file={x} onClose={...} />
// - file berubah → daftarkan/fokuskan pratinjau di store (maks 3, lebih
//   dari itu yang terlama ditutup otomatis + toast).
// - pratinjau ditutup/dievict dari store → panggil onClose host.
// - MINIMIZE BUKAN onClose: entri tetap hidup di store sebagai kartu
//   PiP (video/audio tetap berjalan) — host tidak diberitahu.
export function FilePreview({
  file,
  onClose,
}: {
  file: CloudFileItem | null;
  onClose: () => void;
}) {
  const openPreview = usePreviewStore((s) => s.openPreview);
  const entries = usePreviewStore((s) => s.entries);
  const lastKey = useRef<string | null>(null);

  // Host membuka file (file berubah null → item) → daftarkan ke registry.
  useEffect(() => {
    if (file && lastKey.current !== file.storageKey) {
      lastKey.current = file.storageKey;
      openPreview(file);
    }
    if (!file) lastKey.current = null;
  }, [file, openPreview]);

  // Pratinjau ditutup dari jendelanya (atau di-evict karena buka ke-4)
  // → beri tahu host. Bukan sebaliknya: menutup via host (onClose) cukup
  // mengosongkan state host; entri store sudah tidak ada.
  const registered =
    file !== null && entries.some((e) => e.id === file.storageKey);
  useEffect(() => {
    if (!file || lastKey.current !== file.storageKey) return;
    if (!registered) {
      lastKey.current = null;
      onClose();
    }
  }, [file, registered, onClose]);

  // Tidak ada DOM yang dirender adapter — semua UI ada di PreviewLayer.
  return null;
}

// Header dipakai oleh PreviewLayer (bukan lagi dialog Radix) → elemen
// HTML biasa; DialogTitle/DialogDescription diganti h2/p dengan styling
// sama persis.
export function PreviewHeader({
  file,
  mode,
  onSetMode,
  onResetMode,
  isFullscreen,
  onToggleFullscreen,
  onMinimize,
}: {
  file: CloudFileItem;
  mode: PreviewMode;
  onSetMode: (m: "aula" | "native", always: boolean) => void;
  onResetMode: () => void;
  isFullscreen: boolean;
  onToggleFullscreen: () => void;
  onMinimize: () => void;
}) {
  const enqueueDownload = useTransferStore((s) => s.enqueueDownload);
  // File MEGA mentah (mount) butuh ?name= agar server tahu nama + mimetype.
  const url =
    filePublicUrl(file.storageKey) +
    (file.raw ? `?name=${encodeURIComponent(file.name)}` : "");

  return (
    <div
      className={`flex items-start gap-3 pr-8 px-4 py-3 border-b border-border bg-background ${
        isFullscreen ? "bg-black/80 border-black" : ""
      }`}
    >
      <div className="min-w-0 flex-1">
        <h2
          className={`truncate text-base font-semibold leading-none tracking-tight ${
            isFullscreen ? "text-white" : ""
          }`}
          title={file.name}
        >
          {file.name}
        </h2>
        <p className="flex items-center gap-2 flex-wrap mt-1 text-sm text-muted-foreground">
          <Badge variant="outline" className="font-mono text-[10px]">
            {file.mimetype || "tidak diketahui"}
          </Badge>
          <span className={`text-xs ${isFullscreen ? "text-white/70" : ""}`}>
            {formatBytes(file.size)}
          </span>
          {file.uploader ? (
            <span className={`text-xs ${isFullscreen ? "text-white/70" : ""}`}>
              · oleh {file.uploader.name}
            </span>
          ) : null}
        </p>
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
        {/* Pemilih mode pratinjau */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              size="sm"
              variant="outline"
              className="gap-1.5"
              title="Ganti cara menampilkan pratinjau"
            >
              {mode === "aula" ? (
                <BookOpenText className="size-4 text-primary" />
              ) : (
                <Monitor className="size-4" />
              )}
              <span className="hidden sm:inline">
                {mode === "aula"
                  ? "Aula Reader"
                  : mode === "native"
                  ? "Bawaan"
                  : "Mode"}
              </span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-64">
            <DropdownMenuLabel>Cara menampilkan pratinjau</DropdownMenuLabel>
            <DropdownMenuItem
              onClick={() => onSetMode("aula", true)}
              className={mode === "aula" ? "bg-accent" : ""}
            >
              <BookOpenText className="size-4" /> Aula Reader
              <span className="ml-auto text-[10px] text-muted-foreground">
                selalu
              </span>
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => onSetMode("native", true)}
              className={mode === "native" ? "bg-accent" : ""}
            >
              <Monitor className="size-4" /> Pratinjau Bawaan
              <span className="ml-auto text-[10px] text-muted-foreground">
                selalu
              </span>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => {
                onResetMode();
              }}
            >
              Tanya setiap kali file dibuka
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        {/* Minimize → kartu PiP mengambang (video/audio tetap berjalan) */}
        <Button
          size="sm"
          variant="outline"
          className="gap-1.5"
          onClick={onMinimize}
          title="Perkecil menjadi PiP mengambang"
        >
          <PictureInPicture2 className="size-4" />
          <span className="hidden sm:inline">PiP</span>
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="gap-1.5"
          onClick={onToggleFullscreen}
          title="Layar penuh (F)"
        >
          {isFullscreen ? (
            <Minimize2 className="size-4" />
          ) : (
            <Maximize2 className="size-4" />
          )}
          <span className="hidden sm:inline">
            {isFullscreen ? "Keluar Layar Penuh" : "Layar Penuh"}
          </span>
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="gap-1.5"
          onClick={() => window.open(url, "_blank", "noopener")}
          title="Buka di tab baru"
        >
          <ExternalLink className="size-4" />
          <span className="hidden sm:inline">Tab Baru</span>
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="gap-1.5"
          onClick={() => {
            // Unduhan berjalan di latar belakang via Manajer Transfer
            // (pause/cancel/progress tiap 2 detik) — dialog tetap terbuka.
            enqueueDownload({
              url: `${url}${url.includes("?") ? "&" : "?"}download=1`,
              name: file.name,
              size: file.size,
              context: file.raw ? "Mount MEGA" : "Pratinjau",
              autoSave: true,
            });
            toast.info(
              `Mengunduh "${file.name}" di latar belakang — pantau di tombol Transfer.`
            );
          }}
          title="Unduh (berjalan di latar belakang)"
        >
          <Download className="size-4" /> Unduh
        </Button>
      </div>
    </div>
  );
}

// ───────────────────────── Body dispatcher ─────────────────────────

export function PreviewBody({
  file,
  fullscreen,
}: {
  file: CloudFileItem;
  fullscreen: boolean;
}) {
  const kind = classify(file.mimetype, file.name);
  // File MEGA mentah (mount) butuh ?name= agar server tahu nama + mimetype.
  const url =
    filePublicUrl(file.storageKey) +
    (file.raw ? `?name=${encodeURIComponent(file.name)}` : "");

  switch (kind) {
    case "image":
      return (
        <div className="flex items-center justify-center p-4 h-full min-h-[40vh]">
          <img
            src={url}
            alt={file.name}
            className={`object-contain rounded-md shadow-sm ${
              fullscreen ? "max-h-full max-w-full" : "max-w-full max-h-[70vh]"
            }`}
          />
        </div>
      );
    case "pdf":
      return (
        <iframe
          src={url}
          title={file.name}
          className="w-full h-full min-h-[60vh] bg-white"
        />
      );
    case "video":
      return (
        <div className="flex items-center justify-center p-4 h-full min-h-[40vh]">
          <video
            controls
            preload="metadata"
            src={url}
            className={`rounded-md shadow-sm ${
              fullscreen ? "max-h-full max-w-full" : "max-w-full max-h-[78vh]"
            }`}
          />
        </div>
      );
    case "audio":
      return (
        <div className="flex items-center justify-center p-8 h-full min-h-[30vh]">
          <audio controls src={url} className="w-full max-w-xl">
            Browser tidak mendukung pemutaran audio.
          </audio>
        </div>
      );
    case "text":
      return <TextPreview url={url} renderMarkdown={false} />;
    case "markdown":
      return <TextPreview url={url} renderMarkdown={true} />;
    case "docx":
      return <OfficePreview file={file} url={url} type="docx" />;
    case "xlsx":
      return <OfficePreview file={file} url={url} type="xlsx" />;
    case "pptx":
      return <OfficePreview file={file} url={url} type="pptx" />;
    case "archive":
      return <ArchivePreview file={file} url={url} />;
    case "binary-office":
      return <NotAvailable file={file} url={url} />;
    default:
      return <NotAvailable file={file} url={url} />;
  }
}

// ───────────────────────── Loading / error bersama ─────────────────────────

function LoadingBlock({
  progress,
  label,
}: {
  progress: FetchProgress | null;
  label: string;
}) {
  const pct =
    progress && progress.total
      ? Math.min(100, Math.round((progress.loaded / progress.total) * 100))
      : null;
  return (
    <div className="flex flex-col items-center justify-center gap-3 p-10 min-h-[40vh] text-center">
      <Loader2 className="size-8 animate-spin text-muted-foreground" />
      <p className="text-sm text-muted-foreground">
        {label}
        {progress
          ? ` · ${formatBytes(progress.loaded)}${
              progress.total ? ` / ${formatBytes(progress.total)}` : ""
            }${progress.speed ? ` · ${formatSpeed(progress.speed)}` : ""}`
          : ""}
      </p>
      {pct !== null ? (
        <div className="w-56 max-w-full">
          <Progress value={pct} className="h-1.5" />
        </div>
      ) : null}
    </div>
  );
}

function ErrorBlock({
  message,
  url,
  kindLabel,
  name,
  size,
}: {
  message: string;
  url: string;
  kindLabel: string;
  name?: string;
  size?: number;
}) {
  const enqueueDownload = useTransferStore((s) => s.enqueueDownload);
  return (
    <div className="p-6 text-center text-sm">
      <p className="text-destructive mb-3">
        Gagal memuat pratinjau {kindLabel}: {message}
      </p>
      <Button
        size="sm"
        variant="outline"
        onClick={() =>
          enqueueDownload({
            url: `${url}${url.includes("?") ? "&" : "?"}download=1`,
            name: name ?? "file",
            size: size ?? 0,
            context: "Pratinjau",
            autoSave: true,
          })
        }
      >
        <Download className="size-4" /> Unduh untuk melihat
      </Button>
    </div>
  );
}

// ───────────────────────── Office preview (docx/xlsx/pptx + magic PDF) ─────────────────────────

function OfficePreview({
  file,
  url,
  type,
}: {
  file: CloudFileItem;
  url: string;
  type: "docx" | "xlsx" | "pptx";
}) {
  const { entry, error, progress } = useOfficeBuffer(file);
  const kindLabel = type === "docx" ? ".docx" : type === "xlsx" ? ".xlsx" : ".pptx";

  if (error) {
    return (
      <ErrorBlock
        message={error}
        url={url}
        kindLabel={kindLabel}
        name={file.name}
        size={file.size}
      />
    );
  }
  if (!entry) {
    return (
      <LoadingBlock
        progress={progress}
        label={`Mengunduh ${kindLabel} dari cloud…`}
      />
    );
  }

  // Ternyata PDF (mis. di-rename .docx) → pratinjau PDF native.
  if (entry.actualKind === "pdf") {
    return (
      <iframe
        src={entry.objectUrl}
        title={file.name}
        className="w-full h-full min-h-[60vh] bg-white"
      />
    );
  }

  if (type === "docx") return <DocxView file={file} entry={entry} url={url} />;
  if (type === "xlsx") return <XlsxView file={file} entry={entry} url={url} />;
  return <PptxView file={file} entry={entry} url={url} />;
}

// ───────── docx (mammoth) ─────────

function DocxView({
  file,
  entry,
  url,
}: {
  file: CloudFileItem;
  entry: OfficeCacheEntry;
  url: string;
}) {
  const [html, setHtml] = useState<string | null>(
    docxHtmlCache.get(file.storageKey) ?? null
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (html) return;
    let cancelled = false;
    (async () => {
      try {
        const mammoth = await import("mammoth");
        const result = await mammoth.convertToHtml({ arrayBuffer: entry.buffer });
        const out = result.value || "<p>(dokumen kosong)</p>";
        docxHtmlCache.set(file.storageKey, out);
        if (!cancelled) setHtml(out);
      } catch (e) {
        if (!cancelled)
          setError(e instanceof Error ? e.message : "Gagal mengonversi .docx");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [file.storageKey, entry.buffer, html]);

  if (error)
    return (
      <ErrorBlock
        message={error}
        url={url}
        kindLabel=".docx"
        name={file.name}
        size={file.size}
      />
    );
  if (!html) {
    return (
      <div className="p-6 flex items-center justify-center text-sm text-muted-foreground min-h-[40vh]">
        <Loader2 className="size-4 animate-spin mr-2" /> Mengonversi .docx…
      </div>
    );
  }
  return (
    <ScrollArea className="h-full min-h-[60vh]">
      <div
        className="prose prose-sm dark:prose-invert max-w-none p-6 break-words"
        // mammoth produces sanitised HTML from the docx XML structure
        // (paragraphs, lists, tables). It is generated from the document
        // content itself, not from user-supplied input.
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </ScrollArea>
  );
}

// ───────── xlsx / xls / csv (SheetJS) ─────────

function XlsxView({
  file,
  entry,
  url,
}: {
  file: CloudFileItem;
  entry: OfficeCacheEntry;
  url: string;
}) {
  const [sheets, setSheets] = useState<{ name: string; html: string }[] | null>(
    xlsxSheetsCache.get(file.storageKey) ?? null
  );
  const [active, setActive] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (sheets) return;
    let cancelled = false;
    (async () => {
      try {
        const XLSX = await import("xlsx");
        const wb = XLSX.read(entry.buffer, { type: "array" });
        const MAX_ROWS = 300; // batasi supaya sheet raksasa tidak bikin browser macet
        const out = wb.SheetNames.map((name) => {
          const sheet = wb.Sheets[name];
          const range = XLSX.utils.decode_range(
            sheet["!ref"] ?? "A1"
          );
          const limitedRows = Math.min(range.e.r, MAX_ROWS - 1);
          const limited = { ...sheet, "!ref": XLSX.utils.encode_range({ ...range, e: { ...range.e, r: limitedRows } }) };
          let html = XLSX.utils.sheet_to_html(limited, { editable: false });
          if (range.e.r > limitedRows) {
            html += `<p class="text-xs text-muted-foreground p-2">… ${range.e.r - limitedRows} baris berikutnya tidak ditampilkan (unduh file untuk melihat semua).</p>`;
          }
          return { name, html };
        });
        xlsxSheetsCache.set(file.storageKey, out);
        if (!cancelled) setSheets(out);
      } catch (e) {
        if (!cancelled)
          setError(e instanceof Error ? e.message : "Gagal membaca spreadsheet");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [file.storageKey, entry.buffer, sheets]);

  if (error)
    return (
      <ErrorBlock
        message={error}
        url={url}
        kindLabel=".xlsx"
        name={file.name}
        size={file.size}
      />
    );
  if (!sheets) {
    return (
      <div className="p-6 flex items-center justify-center text-sm text-muted-foreground min-h-[40vh]">
        <Loader2 className="size-4 animate-spin mr-2" /> Membaca spreadsheet…
      </div>
    );
  }
  return (
    <div className="h-full min-h-[60vh] flex flex-col">
      {sheets.length > 1 ? (
        <div className="px-4 pt-3 pb-1 border-b border-border">
          <Tabs value={String(active)} onValueChange={(v) => setActive(Number(v))}>
            <TabsList className="h-8 flex-wrap max-w-full overflow-x-auto">
              {sheets.map((s, i) => (
                <TabsTrigger key={s.name} value={String(i)} className="text-xs">
                  {s.name}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </div>
      ) : null}
      {/* wrapper flex-1 min-h-0 (definite dalam frame/window preview
          yang tingginya pasti) + ScrollArea h-full → viewport
          ter-constrain & daftar sheet bisa di-scroll. Jangan pakai
          `absolute` — Radix Root punya inline position:relative. */}
      <div className="flex-1 min-h-0">
        <ScrollArea className="h-full">
          <div
            className="p-4 [&_table]:w-full [&_table]:text-xs [&_table]:border-collapse [&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:border-border [&_th]:bg-secondary [&_th]:px-2 [&_th]:py-1"
            dangerouslySetInnerHTML={{ __html: sheets[active]?.html ?? "" }}
          />
        </ScrollArea>
      </div>
    </div>
  );
}

// ───────── pptx (pptx-preview) ─────────

function PptxView({
  file,
  entry,
  url,
}: {
  file: CloudFileItem;
  entry: OfficeCacheEntry;
  url: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let raf = 0;
    let attempts = 0;
    (async () => {
      try {
        const mod = await import("pptx-preview");
        const init = (mod as { init: unknown }).init as (
          el: HTMLElement,
          opts: { width: number; height: number }
        ) => { preview: (data: ArrayBuffer) => void };
        const el = containerRef.current;
        if (!el) return;
        // Ukur lebar dengan sabar: dialog baru saja dibuka → layout bisa
        // belum siap (clientWidth 0). Dulu: fallback 960 terpakai padahal
        // dialog lebih lebar → slide tampil kecil / rasio salah. Coba
        // ulang tiap frame hingga terukur (maks ±10 frame).
        const start = () => {
          const width = Math.max(
            480,
            Math.min(el.clientWidth || 960, 1150)
          );
          if (cancelled) return;
          const viewer = init(el, {
            width,
            height: Math.round((width * 9) / 16),
          });
          viewer.preview(entry.buffer);
          setReady(true);
        };
        const tryMeasure = () => {
          if (cancelled) return;
          if (el.clientWidth > 0 || attempts >= 10) {
            start();
          } else {
            attempts++;
            raf = requestAnimationFrame(tryMeasure);
          }
        };
        tryMeasure();
      } catch (e) {
        if (!cancelled)
          setError(e instanceof Error ? e.message : "Gagal merender .pptx");
      }
    })();
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, [entry.buffer]);

  if (error)
    return (
      <ErrorBlock
        message={error}
        url={url}
        kindLabel=".pptx"
        name={file.name}
        size={file.size}
      />
    );
  return (
    <ScrollArea className="h-full min-h-[60vh]">
      {!ready ? (
        <div className="p-6 flex items-center justify-center text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin mr-2" /> Merender slide .pptx…
        </div>
      ) : null}
      <div ref={containerRef} className="p-4 flex justify-center bg-secondary/40" />
    </ScrollArea>
  );
}

// ───────────────────────── Text / Markdown preview ─────────────────────────

const TEXT_CAP = 512 * 1024; // 512 KB — file teks besar tetap lancar

function TextPreview({
  url,
  renderMarkdown,
}: {
  url: string;
  renderMarkdown: boolean;
}) {
  const [content, setContent] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Reset state when `url` changes ("adjust state during render" pattern).
  const [prevUrl, setPrevUrl] = useState<string>(url);
  if (prevUrl !== url) {
    setPrevUrl(url);
    setContent(null);
    setError(null);
    setTruncated(false);
    setCopied(false);
  }

  useEffect(() => {
    let cancelled = false;
    const ac = new AbortController();
    fetch(url, { signal: ac.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        if (!cancelled) {
          if (text.length > TEXT_CAP) {
            setContent(text.slice(0, TEXT_CAP));
            setTruncated(true);
          } else {
            setContent(text);
          }
        }
      })
      .catch((e) => {
        if (!cancelled && !(e instanceof DOMException && e.name === "AbortError"))
          setError(e instanceof Error ? e.message : "Gagal memuat teks");
      });
    return () => {
      cancelled = true;
      ac.abort();
    };
  }, [url]);

  if (error) {
    return (
      <div className="p-6 text-center text-sm text-destructive">
        Gagal memuat isi: {error}
      </div>
    );
  }
  if (content === null) {
    return (
      <div className="p-6 flex items-center justify-center text-sm text-muted-foreground min-h-[30vh]">
        <Loader2 className="size-4 animate-spin mr-2" /> Memuat teks…
      </div>
    );
  }

  function onCopy() {
    if (content === null) return;
    navigator.clipboard
      .writeText(content)
      .then(() => {
        setCopied(true);
        toast.success("Teks disalin ke clipboard.");
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => toast.error("Gagal menyalin"));
  }

  return (
    <div className="relative h-full min-h-[60vh]">
      <Button
        size="sm"
        variant="outline"
        className="absolute right-3 top-3 z-10 bg-background/80 backdrop-blur"
        onClick={onCopy}
        title="Salin isi"
      >
        {copied ? (
          <>
            <Check className="size-4" /> Tersalin
          </>
        ) : (
          <>
            <Copy className="size-4" /> Salin
          </>
        )}
      </Button>
      <ScrollArea className="h-full">
        {renderMarkdown ? (
          <div className="prose prose-sm dark:prose-invert max-w-none p-6 break-words">
            <AiMarkdown content={content} />
          </div>
        ) : (
          <pre className="p-6 text-xs font-mono whitespace-pre-wrap break-words leading-relaxed">
            {content}
            {truncated ? "\n\n… (file terlalu besar — hanya 512 KB pertama yang ditampilkan)" : ""}
          </pre>
        )}
      </ScrollArea>
    </div>
  );
}

// ───────────────────────── Not-available fallback ─────────────────────────

function NotAvailable({
  file,
  url,
}: {
  file: CloudFileItem;
  url: string;
}) {
  const enqueueDownload = useTransferStore((s) => s.enqueueDownload);
  return (
    <div className="flex flex-col items-center justify-center gap-3 p-12 text-center min-h-[40vh]">
      <FileWarning className="size-12 text-muted-foreground/60" />
      <div>
        <p className="text-sm font-medium">Pratinjau tidak tersedia</p>
        <p className="text-xs text-muted-foreground mt-1">
          Tipe file ini ({file.mimetype || "tidak diketahui"}) tidak bisa
          ditampilkan langsung di browser.
        </p>
      </div>
      <Button
        size="sm"
        onClick={() =>
          enqueueDownload({
            url: `${url}${url.includes("?") ? "&" : "?"}download=1`,
            name: file.name,
            size: file.size,
            context: "Pratinjau",
            autoSave: true,
          })
        }
      >
        <Download className="size-4" /> Unduh untuk melihat
      </Button>
    </div>
  );
}

// ───────────────────────── Arsip (ZIP dkk) — daftar isi in-app ─────────────────────────
// File arsip TIDak di-download otomatis. Untuk .zip kita daftar isinya
// langsung dari CENTRAL DIRECTORY (header saja — TANPA dekompresi;
// dulu fflate unzip mendekompresi SELURUH isi: zip 60MB bisa makan
// ratusan MB RAM hanya untuk menampilkan nama file); rar/7z/tar dkk →
// kartu info + tombol unduh. Unduhan memakai cache pratinjau bersama
// (progress + abort otomatis saat dialog ditutup).

interface ZipEntryInfo {
  path: string;
  size: number;
  compressedSize?: number;
  isFile: boolean;
}

/** Baca daftar isi ZIP dari EOCD → central directory (tanpa dekompresi). */
function listZipEntries(u8: Uint8Array): ZipEntryInfo[] {
  // Temukan End of Central Directory (signature PK\x05\x06) dari belakang
  // (komentar ZIP bisa sampai 64KB).
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let eocd = -1;
  const stop = Math.max(0, u8.length - 22 - 65535);
  for (let i = u8.length - 22; i >= stop; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("Bukan arsip ZIP yang valid.");
  const count = dv.getUint16(eocd + 10, true);
  let off = dv.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  const out: ZipEntryInfo[] = [];
  for (let i = 0; i < count && off + 46 <= u8.length; i++) {
    if (dv.getUint32(off, true) !== 0x02014b50) break; // tanda tangan CD
    const compSize = dv.getUint32(off + 20, true);
    const uncompSize = dv.getUint32(off + 24, true);
    const nameLen = dv.getUint16(off + 28, true);
    const extraLen = dv.getUint16(off + 30, true);
    const commentLen = dv.getUint16(off + 32, true);
    const name = dec.decode(u8.subarray(off + 46, off + 46 + nameLen));
    out.push({
      path: name,
      size: uncompSize,
      compressedSize: compSize || undefined,
      isFile: !name.endsWith("/"),
    });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

function ArchivePreview({
  file,
  url,
}: {
  file: CloudFileItem;
  url: string;
}) {
  const enqueueDownload = useTransferStore((s) => s.enqueueDownload);
  const [entries, setEntries] = useState<ZipEntryInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const ext2 = ext(file.name);
  // Batas aman: zip raksasa → kartu info (membaca header pun berat).
  const ZIP_LIST_LIMIT = 60 * 1024 * 1024;
  const isZip =
    (ext2 === "zip" || ext2 === "epub" || file.mimetype === "application/zip") &&
    (file.size || 0) <= ZIP_LIST_LIMIT;

  // Buffer via cache bersama (progress + abort saat dialog ditutup).
  const { entry, error: bufError, progress } = useOfficeBuffer(file, {
    enabled: isZip,
  });

  useEffect(() => {
    if (!isZip || !entry) return;
    let cancelled = false;
    (async () => {
      try {
        // Parse di microtask berikutnya (setelah buffer siap) — setState
        // tidak lagi sinkron di badan effect.
        await Promise.resolve();
        if (cancelled) return;
        const list = listZipEntries(new Uint8Array(entry.buffer));
        list.sort((a, b) => a.path.localeCompare(b.path));
        setEntries(list);
      } catch (e) {
        if (!cancelled)
          setError(e instanceof Error ? e.message : "Gagal membaca arsip");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isZip, entry]);

  if (isZip && bufError) {
    return (
      <ErrorBlock
        message={bufError}
        url={url}
        kindLabel="arsip"
        name={file.name}
        size={file.size}
      />
    );
  }
  if (isZip && !entry) {
    return (
      <LoadingBlock progress={progress} label="Mengunduh arsip dari cloud…" />
    );
  }

  if (!isZip) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 p-12 text-center min-h-[40vh]">
        <FileArchive className="size-12 text-muted-foreground/60" />
        <div>
          <p className="text-sm font-medium">Arsip .{ext2 || "?"}</p>
          <p className="text-xs text-muted-foreground mt-1 max-w-sm">
            Format arsip ini tidak bisa dibuka langsung di browser. Unduh
            untuk mengekstrak isinya di perangkat Anda.
          </p>
        </div>
        <Button
          size="sm"
          onClick={() =>
            enqueueDownload({
              url: `${url}${url.includes("?") ? "&" : "?"}download=1`,
              name: file.name,
              size: file.size,
              context: "Pratinjau",
              autoSave: true,
            })
          }
        >
          <Download className="size-4" /> Unduh arsip
        </Button>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 p-12 text-center min-h-[40vh]">
        <FileWarning className="size-12 text-muted-foreground/60" />
        <p className="text-sm text-destructive">Gagal membaca arsip: {error}</p>
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            enqueueDownload({
              url: `${url}${url.includes("?") ? "&" : "?"}download=1`,
              name: file.name,
              size: file.size,
              context: "Pratinjau",
              autoSave: true,
            })
          }
        >
          <Download className="size-4" /> Unduh
        </Button>
      </div>
    );
  }

  if (entries === null) {
    return (
      <div className="p-6 flex items-center justify-center text-sm text-muted-foreground min-h-[40vh]">
        <Loader2 className="size-4 animate-spin mr-2" /> Membaca isi arsip…
      </div>
    );
  }

  const files = entries.filter((e) => e.isFile);
  const folders = entries.filter((e) => !e.isFile).length;
  const totalUncompressed = files.reduce((s, e) => s + e.size, 0);
  const filtered = query
    ? files.filter((e) =>
        e.path.toLowerCase().includes(query.toLowerCase())
      )
    : files.slice(0, 300);
  const hiddenCount = query ? 0 : files.length - filtered.length;

  return (
    <div className="h-full min-h-[50vh] flex flex-col">
      <div className="px-4 py-3 border-b border-border flex flex-wrap items-center gap-3">
        <FileArchive className="size-5 text-amber-500 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium truncate">
            {files.length} file{folders > 0 ? ` · ${folders} folder` : ""}
          </p>
          <p className="text-[11px] text-muted-foreground">
            Total {formatBytes(totalUncompressed)} (belum terkompresi)
          </p>
        </div>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Cari dalam arsip…"
          className="h-8 rounded-md border border-input bg-card px-2 text-xs w-40 sm:w-56"
        />
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            enqueueDownload({
              url: `${url}${url.includes("?") ? "&" : "?"}download=1`,
              name: file.name,
              size: file.size,
              context: "Pratinjau",
              autoSave: true,
            })
          }
        >
          <Download className="size-4" /> Unduh
        </Button>
      </div>
      {/* wrapper flex-1 min-h-0 + ScrollArea h-full → daftar isi arsip
          yang panjang selalu bisa di-scroll (Radix Root inline
          position:relative — jangan pakai class absolute). */}
      <div className="flex-1 min-h-0">
        <ScrollArea className="h-full">
          <div className="p-2">
            {filtered.map((e) => (
              <div
                key={e.path}
                className="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-accent/60 text-sm"
              >
                <FileText className="size-3.5 text-muted-foreground shrink-0" />
                <span className="flex-1 min-w-0 truncate font-mono text-xs">
                  {e.path}
                </span>
                <span className="text-[11px] text-muted-foreground tabular-nums shrink-0">
                  {formatBytes(e.size)}
                </span>
              </div>
            ))}
            {hiddenCount > 0 ? (
              <p className="text-xs text-muted-foreground p-3 text-center">
                … {hiddenCount} file lain tidak ditampilkan. Gunakan pencarian
                atau unduh arsipnya.
              </p>
            ) : null}
            {filtered.length === 0 ? (
              <p className="text-xs text-muted-foreground p-6 text-center">
                Tidak ada file yang cocok dengan pencarian.
              </p>
            ) : null}
          </div>
        </ScrollArea>
      </div>
    </div>
  );
}
