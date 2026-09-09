"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  Download,
  Loader2,
  Eye,
  FileWarning,
  Copy,
  Check,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import ReactMarkdown from "react-markdown";
import { filePublicUrl } from "@/lib/file-constants";
import { formatBytes, type CloudFileItem } from "@/lib/cloud-format";

// ───────────────────────── Mime-type categories ─────────────────────────

type PreviewKind =
  | "image"
  | "pdf"
  | "video"
  | "audio"
  | "text"
  | "markdown"
  | "docx"
  | "other";

function classify(mime: string, name: string): PreviewKind {
  const lower = (name || "").toLowerCase();
  if (mime.startsWith("image/")) return "image";
  if (mime === "application/pdf") return "pdf";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (mime === "text/markdown" || lower.endsWith(".md")) return "markdown";
  if (
    mime === "text/plain" ||
    mime === "application/json" ||
    mime.startsWith("text/")
  )
    return "text";
  if (
    mime ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    mime === "application/msword"
  )
    return "docx";
  return "other";
}

// ───────────────────────── Component ─────────────────────────

export function FilePreview({
  file,
  onClose,
}: {
  file: CloudFileItem | null;
  onClose: () => void;
}) {
  const open = file !== null;
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DialogContent className="sm:max-w-4xl max-h-[92vh] flex flex-col p-0 gap-0 overflow-hidden">
        {file ? <PreviewInner file={file} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function PreviewInner({ file }: { file: CloudFileItem }) {
  const kind = classify(file.mimetype, file.name);
  const url = filePublicUrl(file.storageKey);

  return (
    <>
      {/* Header */}
      <div className="flex items-start gap-3 pr-8 px-4 py-3 border-b border-border bg-background">
        <div className="min-w-0 flex-1">
          <DialogTitle className="truncate text-base" title={file.name}>
            {file.name}
          </DialogTitle>
          <DialogDescription className="flex items-center gap-2 flex-wrap mt-1">
            <Badge variant="outline" className="font-mono text-[10px]">
              {file.mimetype || "tidak diketahui"}
            </Badge>
            <span className="text-xs">{formatBytes(file.size)}</span>
            {file.uploader ? (
              <span className="text-xs">· oleh {file.uploader.name}</span>
            ) : null}
          </DialogDescription>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Button asChild size="sm" variant="outline">
            <a
              href={url}
              download={file.name}
              rel="noopener noreferrer"
            >
              <Download className="size-4" /> Unduh
            </a>
          </Button>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-hidden bg-secondary/30">
        <PreviewBody kind={kind} file={file} url={url} />
      </div>
    </>
  );
}

// ───────────────────────── Body dispatcher ─────────────────────────

function PreviewBody({
  kind,
  file,
  url,
}: {
  kind: PreviewKind;
  file: CloudFileItem;
  url: string;
}) {
  switch (kind) {
    case "image":
      return (
        <div className="flex items-center justify-center p-4 min-h-[40vh]">
          <img
            src={url}
            alt={file.name}
            className="max-w-full max-h-[78vh] object-contain rounded-md shadow-sm"
          />
        </div>
      );
    case "pdf":
      return (
        <iframe
          src={url}
          title={file.name}
          className="w-full h-[80vh] bg-white"
        />
      );
    case "video":
      return (
        <div className="flex items-center justify-center p-4 min-h-[40vh]">
          <video
            controls
            src={url}
            className="max-w-full max-h-[80vh] rounded-md shadow-sm"
          />
        </div>
      );
    case "audio":
      return (
        <div className="flex items-center justify-center p-8 min-h-[30vh]">
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
      return <DocxPreview url={url} />;
    default:
      return <NotAvailable file={file} url={url} />;
  }
}

// ───────────────────────── Text / Markdown preview ─────────────────────────

function TextPreview({
  url,
  renderMarkdown,
}: {
  url: string;
  renderMarkdown: boolean;
}) {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Reset state when `url` changes ("adjust state during render" pattern).
  // This avoids calling setState synchronously inside useEffect, which can
  // cause cascading renders.
  const [prevUrl, setPrevUrl] = useState<string>(url);
  if (prevUrl !== url) {
    setPrevUrl(url);
    setContent(null);
    setError(null);
    setCopied(false);
  }

  useEffect(() => {
    let cancelled = false;
    fetch(url)
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        if (!cancelled) setContent(text);
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
      <div className="p-6 flex items-center justify-center text-sm text-muted-foreground">
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
    <div className="relative h-[78vh]">
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
          </pre>
        )}
      </ScrollArea>
    </div>
  );
}

// ───────────────────────── docx preview (mammoth) ─────────────────────────

function DocxPreview({ url }: { url: string }) {
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Reset state when `url` changes ("adjust state during render" pattern).
  const [prevUrl, setPrevUrl] = useState<string>(url);
  if (prevUrl !== url) {
    setPrevUrl(url);
    setHtml(null);
    setError(null);
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const arrayBuffer = await res.arrayBuffer();
        // Dynamic import — mammoth ships a browser build.
        const mammoth = await import("mammoth");
        const result = await mammoth.convertToHtml({ arrayBuffer });
        if (!cancelled) setHtml(result.value || "<p>(dokumen kosong)</p>");
      } catch (e) {
        if (!cancelled)
          setError(e instanceof Error ? e.message : "Gagal mengonversi .docx");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [url]);

  if (error) {
    return (
      <div className="p-6 text-center text-sm">
        <p className="text-destructive mb-3">
          Gagal memuat pratinjau .docx: {error}
        </p>
        <Button asChild size="sm" variant="outline">
          <a href={url} download>
            <Download className="size-4" /> Unduh untuk melihat
          </a>
        </Button>
      </div>
    );
  }
  if (html === null) {
    return (
      <div className="p-6 flex items-center justify-center text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin mr-2" /> Mengonversi .docx…
      </div>
    );
  }
  return (
    <ScrollArea className="h-[78vh]">
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
          ditampilkan langsung.
        </p>
      </div>
      <Button asChild size="sm">
        <a href={url} download={file.name}>
          <Eye className="size-4" /> Unduh untuk melihat
        </a>
      </Button>
    </div>
  );
}
