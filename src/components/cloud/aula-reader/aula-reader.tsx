"use client";

import dynamic from "next/dynamic";
import { Loader2, BookOpenText, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { filePublicUrl, formatBytes } from "@/lib/file-constants";
import { formatSpeed } from "@/lib/fast-fetch";
import type { CloudFileItem } from "@/lib/cloud-format";
import {
  classify,
  ext as fileExt,
  EMBEDDED_IMAGE_EXTS,
  useOfficeBuffer,
} from "@/components/cloud/buffer-loader";
import { PreviewBody } from "@/components/cloud/file-preview";
import { TextReader } from "./text-reader";
import { ImageReader } from "./image-reader";
import { MediaReader } from "./media-reader";
import { EmbeddedImageReader, GoogleDocsReader } from "./special-reader";

// ─────────────────────────────────────────────────────────────────────────
// Aula Reader — pratinjau custom cepat untuk SEMUA device (HP, tablet,
// laptop, Smart TV). Router utama: memilih sub-reader sesuai tipe file.
// PDF di-load lazy (terpisah dari bundle utama → aplikasi tetap ringan).
// ─────────────────────────────────────────────────────────────────────────

const PdfReader = dynamic(
  () => import("./pdf-reader").then((m) => ({ default: m.PdfReader })),
  {
    ssr: false,
    loading: () => <CenterLoading label="Memuat pembaca PDF…" />,
  }
);

const EpubReader = dynamic(
  () => import("./epub-reader").then((m) => ({ default: m.EpubReader })),
  {
    ssr: false,
    loading: () => <CenterLoading label="Membuka buku…" />,
  }
);

const RAW_LABELS: Record<string, string> = {
  cr2: "Canon RAW (.cr2)",
  cr3: "Canon RAW (.cr3)",
  crw: "Canon RAW (.crw)",
  nef: "Nikon RAW (.nef)",
  nrw: "Nikon RAW (.nrw)",
  arw: "Sony RAW (.arw)",
  sr2: "Sony RAW (.sr2)",
  dng: "DNG RAW (.dng)",
  orf: "Olympus RAW (.orf)",
  rw2: "Panasonic RAW (.rw2)",
  raf: "Fujifilm RAW (.raf)",
  pef: "Pentax RAW (.pef)",
  srw: "Samsung RAW (.srw)",
  x3f: "Sigma RAW (.x3f)",
  erf: "Epson RAW (.erf)",
  iiq: "Phase One RAW (.iiq)",
};

const DESIGN_LABELS: Record<string, string> = {
  cdr: "CorelDRAW (.cdr)",
  cpt: "Corel PHOTO-PAINT (.cpt)",
  cdt: "CorelDRAW template (.cdt)",
  cmx: "Corel CMX (.cmx)",
  pat: "Corel pattern (.pat)",
  psd: "Photoshop (.psd)",
  psb: "Photoshop besar (.psb)",
  ai: "Adobe Illustrator (.ai)",
  eps: "EPS (.eps)",
  ps: "PostScript (.ps)",
  indd: "InDesign (.indd)",
  pub: "Publisher (.pub)",
  vsd: "Visio (.vsd)",
  vsdx: "Visio (.vsdx)",
  xcf: "GIMP (.xcf)",
  kra: "Krita (.kra)",
  clip: "CLIP STUDIO (.clip)",
  fig: "Figma (.fig)",
  sketch: "Sketch (.sketch)",
  xd: "Adobe XD (.xd)",
  afdesign: "Affinity Designer (.afdesign)",
  heic: "HEIC (.heic)",
  heif: "HEIF (.heif)",
};

function embeddedLabel(e: string): string {
  return RAW_LABELS[e] ?? DESIGN_LABELS[e] ?? `.${e}`;
}

function CenterLoading({ label }: { label: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 p-10 min-h-[40vh]">
      <Loader2 className="size-8 animate-spin text-muted-foreground" />
      <p className="text-sm text-muted-foreground">{label}</p>
    </div>
  );
}

function BufferLoading({ progress }: { progress: { loaded: number; total: number | null; speed?: number } | null }) {
  const pct =
    progress && progress.total
      ? Math.min(100, Math.round((progress.loaded / progress.total) * 100))
      : null;
  return (
    <div className="flex flex-col items-center justify-center gap-3 p-10 min-h-[40vh] text-center">
      <Loader2 className="size-8 animate-spin text-muted-foreground" />
      <p className="text-sm text-muted-foreground">
        Mengunduh file dari cloud…
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

function BufferError({
  onOpenNative,
}: {
  onOpenNative: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 p-10 min-h-[40vh] text-center">
      <TriangleAlert className="size-10 text-destructive" />
      <p className="text-sm text-destructive">
        Gagal mengunduh file dari cloud.
      </p>
      <Button variant="outline" size="sm" onClick={onOpenNative}>
        Coba pratinjau bawaan
      </Button>
    </div>
  );
}

export function AulaReader({
  file,
  onOpenNative,
}: {
  file: CloudFileItem;
  onOpenNative: () => void;
}) {
  const e = fileExt(file.name);
  const kind = classify(file.mimetype, file.name);
  const url =
    filePublicUrl(file.storageKey) +
    (file.raw ? `?name=${encodeURIComponent(file.name)}` : "");

  // Tipe yang butuh unduhan buffer penuh di level ini.
  const needsBuffer =
    kind === "pdf" ||
    kind === "gdoc" ||
    kind === "raw" ||
    EMBEDDED_IMAGE_EXTS.has(e) ||
    e === "epub";

  const { entry, error, progress } = useOfficeBuffer(file);

  // ── EPUB (ekstensi) ──
  if (e === "epub") {
    if (error) return <BufferError onOpenNative={onOpenNative} />;
    if (!entry) return <BufferLoading progress={progress} />;
    return <EpubReader file={file} entry={entry} />;
  }

  // ── Pintasan Google Drive ──
  if (kind === "gdoc") {
    if (error) return <BufferError onOpenNative={onOpenNative} />;
    if (!entry) return <BufferLoading progress={progress} />;
    return <GoogleDocsReader file={file} entry={entry} />;
  }

  // ── PDF ──
  if (kind === "pdf") {
    if (error) return <BufferError onOpenNative={onOpenNative} />;
    if (!entry) return <BufferLoading progress={progress} />;
    // File kecil ternyata bukan PDF (mis. rusak) → fallback native.
    if (entry.actualKind !== "pdf" && entry.buffer.byteLength < 64) {
      return <PreviewBody key={file.storageKey} file={file} fullscreen={false} />;
    }
    return <PdfReader file={file} entry={entry} />;
  }

  // ── RAW kamera / CorelDRAW / PSD / format desain → gambar ter-embed ──
  if (kind === "raw" || EMBEDDED_IMAGE_EXTS.has(e)) {
    if (error) return <BufferError onOpenNative={onOpenNative} />;
    if (!entry) return <BufferLoading progress={progress} />;
    // Illustrator/AI modern = PDF → buka sebagai PDF.
    if (
      (e === "ai" || e === "eps" || e === "ps") &&
      entry.actualKind === "pdf"
    ) {
      return <PdfReader file={file} entry={entry} />;
    }
    return (
      <EmbeddedImageReader
        file={file}
        entry={entry}
        formatLabel={embeddedLabel(e)}
      />
    );
  }

  // ── Gambar ──
  if (kind === "image") {
    return (
      <ImageReader
        storageKey={file.storageKey}
        url={url}
        alt={file.name}
      />
    );
  }

  // ── Video / audio ──
  if (kind === "video" || kind === "audio") {
    return <MediaReader url={url} kind={kind} name={file.name} />;
  }

  // ── Teks / markdown / kode ──
  if (kind === "text" || kind === "markdown") {
    return (
      <TextReader
        file={file}
        url={url}
        isMarkdown={kind === "markdown"}
      />
    );
  }

  // ── Office / arsip / lainnya → reuse pratinjau konversi bawaan ──
  return (
    <div className="flex flex-col flex-1 h-full min-h-0">
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border bg-muted/40 text-xs text-muted-foreground">
        <BookOpenText className="size-3.5" />
        Tipe ini dibuka dengan penampil dokumen Aula (konversi otomatis).
      </div>
      <div className="flex-1 min-h-0">
        <PreviewBody key={file.storageKey} file={file} fullscreen={false} />
      </div>
    </div>
  );
}
