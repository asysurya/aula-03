"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  Download,
  Loader2,
  FileWarning,
  Copy,
  Check,
  Maximize2,
  Minimize2,
  ExternalLink,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import ReactMarkdown from "react-markdown";
import { filePublicUrl } from "@/lib/file-constants";
import { formatBytes, type CloudFileItem } from "@/lib/cloud-format";

// ───────────────────────── Klasifikasi tipe preview ─────────────────────────
// Diputuskan dari mimetype DAN ekstensi (mimetype DB bisa keliru — mis.
// PDF yang di-rename .docx). File office dicek ulang lewat magic bytes
// setelah diunduh (lihat useOfficeBuffer).

type PreviewKind =
  | "image"
  | "pdf"
  | "video"
  | "audio"
  | "text"
  | "markdown"
  | "docx"
  | "xlsx"
  | "pptx"
  | "other";

const EXT_KIND: Record<string, PreviewKind> = {
  pdf: "pdf",
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  svg: "image",
  bmp: "image",
  mp4: "video",
  webm: "video",
  mov: "video",
  mp3: "audio",
  wav: "audio",
  ogg: "audio",
  m4a: "audio",
  txt: "text",
  log: "text",
  md: "markdown",
  json: "text",
  xml: "text",
  html: "text",
  htm: "text",
  css: "text",
  js: "text",
  ts: "text",
  csv: "xlsx",
  xls: "xlsx",
  xlsx: "xlsx",
  doc: "docx",
  docx: "docx",
  ppt: "pptx",
  pptx: "pptx",
};

function ext(name: string): string {
  const parts = (name || "").split(".");
  return parts.length > 1 ? (parts.pop() ?? "").toLowerCase() : "";
}

function classify(mime: string, name: string): PreviewKind {
  const e = ext(name);
  if (EXT_KIND[e]) return EXT_KIND[e];
  if (mime.startsWith("image/")) return "image";
  if (mime === "application/pdf") return "pdf";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (mime === "text/markdown") return "markdown";
  if (
    mime === "text/plain" ||
    mime === "application/json" ||
    mime.startsWith("text/")
  )
    return "text";
  if (
    mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    mime === "application/msword"
  )
    return "docx";
  if (
    mime === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    mime === "application/vnd.ms-excel" ||
    mime === "text/csv"
  )
    return "xlsx";
  if (
    mime === "application/vnd.openxmlformats-officedocument.presentationml.presentation" ||
    mime === "application/vnd.ms-powerpoint"
  )
    return "pptx";
  return "other";
}

// ───────────────────────── Cache client (anti-lag buka ulang) ─────────────────────────
// ArrayBuffer + hasil konversi office di-cache per storageKey → membuka
// file yang sama lagi instan (tanpa unduh ulang / konversi ulang).

interface OfficeCacheEntry {
  buffer: ArrayBuffer;
  /** "pdf" bila ternyata PDF (mis. di-rename .docx) */
  actualKind: "pdf" | "office" | "unknown";
  objectUrl: string;
}

const officeBufferCache = new Map<string, OfficeCacheEntry>();
const docxHtmlCache = new Map<string, string>();
const xlsxSheetsCache = new Map<string, { name: string; html: string }[]>();

function cacheSet(key: string, entry: OfficeCacheEntry) {
  if (officeBufferCache.size > 8) {
    // Buang entri tertua.
    const first = officeBufferCache.keys().next().value as string | undefined;
    if (first) {
      const old = officeBufferCache.get(first);
      if (old) URL.revokeObjectURL(old.objectUrl);
      officeBufferCache.delete(first);
    }
  }
  officeBufferCache.set(key, entry);
}

// ───────────────────────── fetch + progress ─────────────────────────

interface FetchProgress {
  loaded: number;
  total: number | null;
}

async function fetchArrayBufferWithProgress(
  url: string,
  onProgress?: (p: FetchProgress) => void
): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const totalHeader = res.headers.get("content-length");
  const total = totalHeader ? parseInt(totalHeader, 10) : null;

  if (!res.body) {
    onProgress?.({ loaded: 0, total });
    return res.arrayBuffer();
  }

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      loaded += value.byteLength;
      onProgress?.({ loaded, total });
    }
  }
  const merged = new Uint8Array(loaded);
  let pos = 0;
  for (const c of chunks) {
    merged.set(c, pos);
    pos += c.byteLength;
  }
  return merged.buffer;
}

// ───────────────────────── Hook buffer office ─────────────────────────

function useOfficeBuffer(file: CloudFileItem, url: string) {
  const key = file.storageKey;
  const cached = officeBufferCache.get(key);
  const [entry, setEntry] = useState<OfficeCacheEntry | null>(cached ?? null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<FetchProgress | null>(
    cached ? null : { loaded: 0, total: null }
  );

  const [prevKey, setPrevKey] = useState(key);
  if (prevKey !== key) {
    setPrevKey(key);
    const c = officeBufferCache.get(key);
    setEntry(c ?? null);
    setError(null);
    setProgress(c ? null : { loaded: 0, total: null });
  }

  useEffect(() => {
    if (entry || error) return;
    let cancelled = false;
    (async () => {
      try {
        const buffer = await fetchArrayBufferWithProgress(url, (p) => {
          if (!cancelled) setProgress(p);
        });
        const head = new Uint8Array(buffer, 0, Math.min(8, buffer.byteLength));
        const isPdf =
          head.length >= 4 &&
          head[0] === 0x25 && // %
          head[1] === 0x50 && // P
          head[2] === 0x44 && // D
          head[3] === 0x46; // F
        const e: OfficeCacheEntry = {
          buffer,
          actualKind: isPdf ? "pdf" : "office",
          objectUrl: URL.createObjectURL(new Blob([buffer])),
        };
        cacheSet(key, e);
        if (!cancelled) {
          setEntry(e);
          setProgress(null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Gagal memuat file");
          setProgress(null);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, url, entry, error]);

  return { entry, error, progress };
}

// ───────────────────────── Component utama ─────────────────────────

export function FilePreview({
  file,
  onClose,
}: {
  file: CloudFileItem | null;
  onClose: () => void;
}) {
  const open = file !== null;
  const bodyRef = useRef<HTMLDivElement>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    const onFsChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFsChange);
    return () => document.removeEventListener("fullscreenchange", onFsChange);
  }, []);

  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else if (bodyRef.current) {
        await bodyRef.current.requestFullscreen();
      }
    } catch {
      toast.error("Browser menolak mode layar penuh");
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          if (document.fullscreenElement) void document.exitFullscreen();
          onClose();
        }
      }}
    >
      <DialogContent
        className="sm:max-w-5xl max-h-[92vh] flex flex-col p-0 gap-0 overflow-hidden"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        {file ? (
          <div className="flex flex-col min-h-0 flex-1">
            <PreviewHeader
              file={file}
              isFullscreen={isFullscreen}
              onToggleFullscreen={toggleFullscreen}
            />
            <div
              ref={bodyRef}
              className={`flex-1 min-h-0 overflow-hidden bg-secondary/30 ${
                isFullscreen ? "bg-black flex items-center justify-center" : ""
              }`}
            >
              <PreviewBody
                key={file.storageKey}
                file={file}
                fullscreen={isFullscreen}
              />
            </div>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function PreviewHeader({
  file,
  isFullscreen,
  onToggleFullscreen,
}: {
  file: CloudFileItem;
  isFullscreen: boolean;
  onToggleFullscreen: () => void;
}) {
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
        <DialogTitle
          className={`truncate text-base ${isFullscreen ? "text-white" : ""}`}
          title={file.name}
        >
          {file.name}
        </DialogTitle>
        <DialogDescription className="flex items-center gap-2 flex-wrap mt-1">
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
        </DialogDescription>
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
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
        <Button asChild size="sm" variant="outline">
          <a
            href={`${url}${url.includes("?") ? "&" : "?"}download=1`}
            download={file.name}
            rel="noopener noreferrer"
          >
            <Download className="size-4" /> Unduh
          </a>
        </Button>
      </div>
    </div>
  );
}

// ───────────────────────── Body dispatcher ─────────────────────────

function PreviewBody({
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
            }`
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
}: {
  message: string;
  url: string;
  kindLabel: string;
}) {
  return (
    <div className="p-6 text-center text-sm">
      <p className="text-destructive mb-3">
        Gagal memuat pratinjau {kindLabel}: {message}
      </p>
      <Button asChild size="sm" variant="outline">
        <a href={`${url}${url.includes("?") ? "&" : "?"}download=1`} download>
          <Download className="size-4" /> Unduh untuk melihat
        </a>
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
  const { entry, error, progress } = useOfficeBuffer(file, url);
  const kindLabel = type === "docx" ? ".docx" : type === "xlsx" ? ".xlsx" : ".pptx";

  if (error) {
    return <ErrorBlock message={error} url={url} kindLabel={kindLabel} />;
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

  if (error) return <ErrorBlock message={error} url={url} kindLabel=".docx" />;
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

  if (error) return <ErrorBlock message={error} url={url} kindLabel=".xlsx" />;
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
      <ScrollArea className="flex-1">
        <div
          className="p-4 [&_table]:w-full [&_table]:text-xs [&_table]:border-collapse [&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:border-border [&_th]:bg-secondary [&_th]:px-2 [&_th]:py-1"
          dangerouslySetInnerHTML={{ __html: sheets[active]?.html ?? "" }}
        />
      </ScrollArea>
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
    (async () => {
      try {
        const mod = await import("pptx-preview");
        const init = (mod as { init: unknown }).init as (
          el: HTMLElement,
          opts: { width: number; height: number }
        ) => { preview: (data: ArrayBuffer) => void };
        const el = containerRef.current;
        if (!el) return;
        // Lebar responsif: ikuti lebar dialog (maks 1150), rasio 16:9.
        const width = Math.max(480, Math.min(el.clientWidth || 960, 1150));
        const viewer = init(el, { width, height: Math.round((width * 9) / 16) });
        viewer.preview(entry.buffer);
        if (!cancelled) setReady(true);
      } catch (e) {
        if (!cancelled)
          setError(e instanceof Error ? e.message : "Gagal merender .pptx");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [entry.buffer]);

  if (error) return <ErrorBlock message={error} url={url} kindLabel=".pptx" />;
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
    fetch(url)
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
        if (!cancelled)
          setError(e instanceof Error ? e.message : "Gagal memuat teks");
      });
    return () => {
      cancelled = true;
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
            <ReactMarkdown>{content}</ReactMarkdown>
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
      <Button asChild size="sm">
        <a href={`${url}${url.includes("?") ? "&" : "?"}download=1`} download={file.name}>
          <Download className="size-4" /> Unduh untuk melihat
        </a>
      </Button>
    </div>
  );
}
