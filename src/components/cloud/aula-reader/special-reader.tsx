"use client";

import { useEffect, useState } from "react";
import {
  FileQuestion,
  ExternalLink,
  Download,
  Image as ImageIcon,
  Loader2,
  PackageOpen,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { formatBytes } from "@/lib/file-constants";
import { useTransferStore } from "@/lib/transfer-store";
import type { OfficeCacheEntry } from "@/components/cloud/buffer-loader";
import { ImageReader } from "./image-reader";
import { TextReader } from "./text-reader";

// ─────────────────────────────────────────────────────────────────────────
// Aula Reader — tipe file khusus:
// • Pintasan Google Drive (.gdoc/.gsheet/…) → tombol buka di Google.
// • CorelDraw / PSD / RAW kamera / format desain → pratinjau GAMBAR
//   (thumbnail/JPEG yang ter-embed di dalam file — tanpa konverter).
// • File tak dikenal → info + unduh + "coba buka sebagai teks".
// ─────────────────────────────────────────────────────────────────────────

// ── Ekstraksi gambar ter-embed ──

function isZip(u8: Uint8Array): boolean {
  return (
    u8.length > 4 &&
    u8[0] === 0x50 &&
    u8[1] === 0x4b &&
    (u8[2] === 0x03 || u8[2] === 0x05 || u8[2] === 0x07)
  );
}

function extOf(name: string): string {
  const p = name.toLowerCase().split(".");
  return p.length > 1 ? p[p.length - 1] : "";
}

/** Cari gambar pratinjau di dalam kontainer ZIP (CDR X4+, docx-style). */
async function fromZip(u8: Uint8Array): Promise<Blob | null> {
  try {
    const { unzipSync } = await import("fflate");
    const files = unzipSync(u8);
    const entries = Object.entries(files)
      .filter(([name, data]) => {
        if (!data || data.length < 64) return false;
        const e = extOf(name);
        if (!["png", "jpg", "jpeg", "bmp", "webp"].includes(e)) return false;
        // Prioritaskan thumbnail/preview, tapi terima gambar mana pun.
        return true;
      })
      .sort((a, b) => {
        const aScore = /thumb|preview/i.test(a[0]) ? 1 : 0;
        const bScore = /thumb|preview/i.test(b[0]) ? 1 : 0;
        if (aScore !== bScore) return bScore - aScore; // thumbnail dulu
        return b[1].length - a[1].length; // lalu terbesar
      });
    for (const [name, data] of entries.slice(0, 5)) {
      const blob = new Blob([data as unknown as BlobPart], {
        type: `image/${extOf(name) === "png" ? "png" : "jpeg"}`,
      });
      if (await canDecode(blob)) return blob;
    }
  } catch {
    /* bukan zip / gagal */
  }
  return null;
}

/** Scan JPEG/PNG mentah di dalam binary (CDR RIFF, PSD, RAW kamera, …). */
async function fromRawScan(u8: Uint8Array): Promise<Blob | null> {
  const candidates: { start: number; end: number }[] = [];

  // JPEG: FF D8 FF … FF D9
  let i = 0;
  outerJ: while (i < u8.length - 3) {
    if (u8[i] === 0xff && u8[i + 1] === 0xd8 && u8[i + 2] === 0xff) {
      let j = i + 3;
      while (j < u8.length - 1) {
        if (u8[j] === 0xff && u8[j + 1] === 0xd9) {
          if (j - i > 4096) candidates.push({ start: i, end: j + 2 });
          i = j + 2;
          continue outerJ;
        }
        j++;
      }
      break;
    }
    i++;
  }

  // PNG: 89 50 4E 47 … "IEND" + CRC
  let k = 0;
  outerP: while (k < u8.length - 8) {
    if (
      u8[k] === 0x89 &&
      u8[k + 1] === 0x50 &&
      u8[k + 2] === 0x4e &&
      u8[k + 3] === 0x47
    ) {
      let j = k + 8;
      while (j < u8.length - 7) {
        if (
          u8[j] === 0x49 &&
          u8[j + 1] === 0x45 &&
          u8[j + 2] === 0x4e &&
          u8[j + 3] === 0x44
        ) {
          const end = j + 8;
          if (end - k > 4096) candidates.push({ start: k, end });
          k = end;
          continue outerP;
        }
        j++;
      }
      break;
    }
    k++;
  }

  // Coba kandidat terbesar dulu (thumbnail RAW biasanya terbesar).
  candidates.sort((a, b) => b.end - b.start - (a.end - a.start));
  for (const c of candidates.slice(0, 5)) {
    const blob = new Blob([u8.subarray(c.start, c.end) as unknown as BlobPart]);
    if (await canDecode(blob)) return blob;
  }
  return null;
}

async function canDecode(blob: Blob): Promise<boolean> {
  try {
    const bmp = await createImageBitmap(blob);
    bmp.close();
    return true;
  } catch {
    return false;
  }
}

async function extractEmbeddedImage(u8: Uint8Array): Promise<Blob | null> {
  if (isZip(u8)) {
    const z = await fromZip(u8);
    if (z) return z;
  }
  return fromRawScan(u8);
}

// ── Komponen ──

export function EmbeddedImageReader({
  file,
  entry,
  formatLabel,
}: {
  file: { storageKey: string; name: string; size: number };
  entry: OfficeCacheEntry;
  formatLabel: string;
}) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [state, setState] = useState<"loading" | "ok" | "none">("loading");

  useEffect(() => {
    let cancelled = false;
    let created: string | null = null;
    (async () => {
      const blob = await extractEmbeddedImage(new Uint8Array(entry.buffer));
      if (cancelled) return;
      if (blob) {
        created = URL.createObjectURL(blob);
        setBlobUrl(created);
        setState("ok");
      } else {
        setState("none");
      }
    })();
    return () => {
      cancelled = true;
      if (created) URL.revokeObjectURL(created);
    };
  }, [entry.buffer]);

  if (state === "loading") {
    return (
      <div className="flex flex-col items-center justify-center gap-3 p-10 min-h-[40vh]">
        <Loader2 className="size-8 animate-spin text-muted-foreground" />
        <p className="text-sm text-muted-foreground">
          Mencari gambar pratinjau di dalam file {formatLabel}…
        </p>
      </div>
    );
  }

  if (state === "ok" && blobUrl) {
    return (
      <ImageReader
        storageKey={file.storageKey}
        url={blobUrl}
        alt={file.name}
        badge={`Pratinjau gambar dari ${formatLabel} — unduh file asli untuk mengedit`}
      />
    );
  }

  return (
    <div className="flex flex-col items-center justify-center gap-4 p-10 min-h-[40vh] text-center">
      <ImageIcon className="size-12 text-muted-foreground" />
      <div className="space-y-1">
        <p className="text-sm font-medium">
          Pratinjau gambar tidak ditemukan di dalam file ini
        </p>
        <p className="text-xs text-muted-foreground max-w-sm">
          File {formatLabel} ini tidak menyimpan thumbnail yang bisa
          ditampilkan. Unduh file lalu buka dengan aplikasi khusus
          (mis. CorelDRAW).
        </p>
      </div>
      <DownloadButton name={file.name} size={file.size} url={entry.objectUrl} />
    </div>
  );
}

export function GoogleDocsReader({
  file,
  entry,
}: {
  file: { name: string };
  entry: OfficeCacheEntry;
}) {
  const [info, setInfo] = useState<{
    url: string;
    app: string;
  } | null>(null);
  const [parsed, setParsed] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const text = new TextDecoder().decode(entry.buffer.slice(0, 65_536));
        const json = JSON.parse(text);
        const docId = typeof json.doc_id === "string" ? json.doc_id : null;
        const rawUrl = typeof json.url === "string" ? json.url : null;
        const ext = file.name.toLowerCase().split(".").pop() ?? "";
        const appByExt: Record<string, string> = {
          gdoc: "Google Docs",
          gsheet: "Google Spreadsheet",
          gslides: "Google Slides",
          gdraw: "Google Drawing",
          gform: "Google Formulir",
          gmap: "Google My Maps",
          gsite: "Google Sites",
        };
        const app = appByExt[ext] ?? "Google Drive";
        let url = rawUrl;
        if (!url && docId) {
          const base: Record<string, string> = {
            gdoc: "https://docs.google.com/document/d/",
            gsheet: "https://docs.google.com/spreadsheets/d/",
            gslides: "https://docs.google.com/presentation/d/",
            gdraw: "https://docs.google.com/drawings/d/",
            gform: "https://docs.google.com/forms/d/",
          };
          url = (base[ext] ?? "https://drive.google.com/file/d/") + docId + "/edit";
        }
        if (url && /^https:\/\/(docs|drive|www)\.google\.com\//.test(url)) {
          setInfo({ url, app });
        }
      } catch {
        /* bukan JSON pintasan Google */
      }
      setParsed(true);
    })();
  }, [entry.buffer, file.name]);

  if (!parsed) {
    return (
      <div className="flex items-center justify-center p-10 min-h-[30vh]">
        <Loader2 className="size-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (info) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 p-10 min-h-[40vh] text-center">
        <div className="size-14 rounded-xl bg-blue-500/10 border border-blue-500/30 flex items-center justify-center">
          <ExternalLink className="size-7 text-blue-500" />
        </div>
        <div className="space-y-1">
          <p className="text-sm font-medium">File pintasan {info.app}</p>
          <p className="text-xs text-muted-foreground max-w-sm">
            File ini adalah tautan ke dokumen di Google. Dokumen tersimpan di
            Google Cloud — buka langsung di aplikasi Google untuk melihat &
            mengedit.
          </p>
        </div>
        <a href={info.url} target="_blank" rel="noopener noreferrer">
          <Button className="gap-2">
            <ExternalLink className="size-4" />
            Buka di {info.app}
          </Button>
        </a>
      </div>
    );
  }

  return (
    <UnknownReader
      name={file.name}
      size={0}
      url={entry.objectUrl}
      hint="File .gdoc ini tidak memuat tautan Google yang valid."
    />
  );
}

function DownloadButton({
  name,
  size,
  url,
}: {
  name: string;
  size: number;
  url: string;
}) {
  const enqueueDownload = useTransferStore((s) => s.enqueueDownload);
  return (
    <Button
      variant="outline"
      onClick={() =>
        enqueueDownload({
          url: `${url}${url.includes("?") ? "&" : "?"}download=1`,
          name,
          size,
          context: "Pratinjau",
          autoSave: true,
        })
      }
    >
      <Download className="size-4" /> Unduh file
    </Button>
  );
}

export function UnknownReader({
  name,
  size,
  url,
  hint,
}: {
  name: string;
  size: number;
  url: string;
  hint?: string;
}) {
  const [asText, setAsText] = useState(false);
  const [textUrl, setTextUrl] = useState<string | null>(null);

  async function tryText() {
    const res = await fetch(`${url}${url.includes("?") ? "&" : "?"}rawtext=1`);
    if (!res.ok) {
      setAsText(true);
      setTextUrl(url);
      return;
    }
    setTextUrl(url);
    setAsText(true);
  }

  if (asText && textUrl) {
    return (
      <TextReader file={{ storageKey: name, name }} url={textUrl} isMarkdown={false} />
    );
  }

  return (
    <div className="flex flex-col items-center justify-center gap-4 p-10 min-h-[40vh] text-center">
      <FileQuestion className="size-12 text-muted-foreground" />
      <div className="space-y-1">
        <p className="text-sm font-medium">
          Pratinjau belum tersedia untuk tipe file ini
        </p>
        <p className="text-xs text-muted-foreground max-w-md">
          {hint ??
            "File tersimpan aman di cloud dan tetap bisa diunduh. Beberapa format khusus hanya bisa dibuka aplikasi tertentu."}
        </p>
      </div>
      <Badge variant="outline" className="font-mono text-[10px] max-w-full truncate">
        {name}
        {size > 0 ? ` · ${formatBytes(size)}` : ""}
      </Badge>
      <div className="flex items-center gap-2">
        <DownloadButton name={name} size={size} url={url} />
        <Button variant="outline" onClick={() => void tryText()}>
          <PackageOpen className="size-4" /> Coba buka sebagai teks
        </Button>
      </div>
    </div>
  );
}
