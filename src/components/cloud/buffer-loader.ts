"use client";

import { useEffect, useState } from "react";
import type { CloudFileItem } from "@/lib/cloud-format";
import {
  fastFetchBuffer,
  formatSpeed,
  type FetchProgress as FastProgress,
} from "@/lib/fast-fetch";
import {
  peekReaderBuffer,
  putReaderBuffer,
  markReaderActive,
} from "@/lib/reader-file-cache";

// ─────────────────────────────────────────────────────────────────────────
// Buffer loader bersama — dipakai oleh FilePreview (pratinjau bawaan) DAN
// Aula Reader. Satu cache per storageKey → file besar (mis. PDF 41 MB dari
// MEGA) hanya diunduh SEKALI walaupun pengguna bolak-balik ganti mode
// pratinjau / membuka ulang.
// ─────────────────────────────────────────────────────────────────────────

// ───────────────────────── Klasifikasi tipe preview ─────────────────────────
// Diputuskan dari mimetype DAN ekstensi (mimetype DB bisa keliru — mis.
// PDF yang di-rename .docx). File office dicek ulang lewat magic bytes
// setelah diunduh (lihat useOfficeBuffer).

export type PreviewKind =
  | "image"
  | "pdf"
  | "video"
  | "audio"
  | "text"
  | "markdown"
  | "docx"
  | "xlsx"
  | "pptx"
  | "archive"
  | "binary-office"
  | "gdoc" // pintasan Google Drive (.gdoc/.gsheet/…) → tombol buka Google
  | "raw" // RAW kamera → pratinjau via JPEG ter-embed
  | "other";

export const EXT_KIND: Record<string, PreviewKind> = {
  // gambar
  pdf: "pdf",
  png: "image",
  jpg: "image",
  jpeg: "image",
  jpe: "image",
  jfif: "image",
  gif: "image",
  webp: "image",
  svg: "image",
  bmp: "image",
  ico: "image",
  tif: "image",
  tiff: "image",
  avif: "image",
  jxl: "image",
  // video
  mp4: "video",
  m4v: "video",
  webm: "video",
  mov: "video",
  qt: "video",
  mkv: "video",
  avi: "video",
  wmv: "video",
  flv: "video",
  mpg: "video",
  mpeg: "video",
  m2ts: "video",
  mts: "video",
  ts: "video",
  "3gp": "video",
  // audio
  mp3: "audio",
  wav: "audio",
  ogg: "audio",
  oga: "audio",
  opus: "audio",
  m4a: "audio",
  m4b: "audio",
  flac: "audio",
  aac: "audio",
  aiff: "audio",
  aif: "audio",
  wma: "audio",
  amr: "audio",
  mka: "audio",
  mid: "audio",
  midi: "audio",
  // teks & kode
  txt: "text",
  log: "text",
  ini: "text",
  cfg: "text",
  conf: "text",
  env: "text",
  properties: "text",
  json: "text",
  jsonl: "text",
  ndjson: "text",
  geojson: "text",
  ipynb: "text",
  xml: "text",
  html: "text",
  htm: "text",
  xhtml: "text",
  css: "text",
  scss: "text",
  less: "text",
  js: "text",
  mjs: "text",
  cjs: "text",
  ts: "text",
  mts: "text",
  tsx: "text",
  jsx: "text",
  vue: "text",
  svelte: "text",
  astro: "text",
  py: "text",
  pyw: "text",
  pyi: "text",
  rb: "text",
  php: "text",
  phtml: "text",
  java: "text",
  c: "text",
  h: "text",
  cpp: "text",
  cxx: "text",
  cc: "text",
  hpp: "text",
  hh: "text",
  cs: "text",
  fs: "text",
  go: "text",
  rs: "text",
  swift: "text",
  kt: "text",
  kts: "text",
  scala: "text",
  lua: "text",
  pl: "text",
  pm: "text",
  r: "text",
  jl: "text",
  dart: "text",
  groovy: "text",
  gradle: "text",
  clj: "text",
  ex: "text",
  exs: "text",
  erl: "text",
  hrl: "text",
  hs: "text",
  elm: "text",
  nim: "text",
  zig: "text",
  v: "text",
  asm: "text",
  s: "text",
  f90: "text",
  f95: "text",
  cob: "text",
  cbl: "text",
  pas: "text",
  coffee: "text",
  tcl: "text",
  awk: "text",
  ps1: "text",
  psm1: "text",
  bat: "text",
  cmd: "text",
  sh: "text",
  bash: "text",
  zsh: "text",
  sql: "text",
  graphql: "text",
  gql: "text",
  proto: "text",
  tf: "text",
  hcl: "text",
  nix: "text",
  cmake: "text",
  mk: "text",
  tex: "text",
  sty: "text",
  bib: "text",
  adoc: "text",
  asciidoc: "text",
  org: "text",
  rst: "text",
  po: "text",
  pot: "text",
  hbs: "text",
  ejs: "text",
  pug: "text",
  liquid: "text",
  srt: "text",
  vtt: "text",
  ass: "text",
  ssa: "text",
  yaml: "text",
  yml: "text",
  toml: "text",
  lock: "text",
  url: "text",
  eml: "text",
  ics: "text",
  vcf: "text",
  md: "markdown",
  markdown: "markdown",
  mdx: "markdown",
  // pintasan Google Drive → tombol "Buka di Google…"
  gdoc: "gdoc",
  gsheet: "gdoc",
  gslides: "gdoc",
  gdraw: "gdoc",
  gform: "gdoc",
  gmap: "gdoc",
  gsite: "gdoc",
  gpres: "gdoc",
  // office
  csv: "xlsx",
  tsv: "xlsx",
  xls: "xlsx",
  xlsx: "xlsx",
  xlsm: "xlsx",
  ods: "xlsx",
  doc: "docx",
  docx: "docx",
  docm: "docx",
  odt: "docx",
  wpd: "docx",
  pages: "docx",
  ppt: "pptx",
  pptx: "pptx",
  pptm: "pptx",
  odp: "pptx",
  key: "pptx",
  rtf: "binary-office",
  // arsip (epub ditangani khusus oleh Aula Reader)
  zip: "archive",
  rar: "archive",
  "7z": "archive",
  tar: "archive",
  gz: "archive",
  tgz: "archive",
  bz2: "archive",
  xz: "archive",
  zst: "archive",
  cbz: "archive",
  cbr: "archive",
  jar: "archive",
  // RAW kamera → pratinjau via JPEG ter-embed (Aula Reader)
  cr2: "raw",
  cr3: "raw",
  crw: "raw",
  nef: "raw",
  nrw: "raw",
  arw: "raw",
  sr2: "raw",
  srf: "raw",
  dng: "raw",
  orf: "raw",
  rw2: "raw",
  rwl: "raw",
  raf: "raw",
  pef: "raw",
  ptx: "raw",
  srw: "raw",
  x3f: "raw",
  erf: "raw",
  iiq: "raw",
  kdc: "raw",
  dcr: "raw",
  mrw: "raw",
  bay: "raw",
  fff: "raw",
  mef: "raw",
  "3fr": "raw",
};

/** Ekstensi file CorelDraw / desain yang pratinjanya = gambar ter-embed. */
export const EMBEDDED_IMAGE_EXTS = new Set<string>([
  // CorelDraw
  "cdr",
  "cpt",
  "cdt",
  "cmx",
  "pat",
  // Adobe & lainnya
  "psd",
  "psb",
  "ai",
  "eps",
  "ps",
  "indd",
  "indt",
  "pmd",
  "pub",
  "vsd",
  "vsdx",
  "vsdm",
  "xcf",
  "kra",
  "ora",
  "clip",
  "sai",
  "afdesign",
  "afphoto",
  "afpub",
  "fig",
  "sketch",
  "xd",
  "blend",
  "dwg",
  "dxf",
  "skp",
  "max",
  "3ds",
  "fbx",
  "c4d",
  "obj",
  "stl",
  "glb",
  "gltf",
  "procreate",
  "pxz",
  "px",
  "heic",
  "heif",
]);

export function ext(name: string): string {
  const parts = (name || "").split(".");
  return parts.length > 1 ? (parts.pop() ?? "").toLowerCase() : "";
}

export function classify(mime: string, name: string): PreviewKind {
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
    mime === "text/x-shellscript" ||
    mime === "text/javascript" ||
    mime.startsWith("text/")
  )
    return "text";
  if (
    mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    mime === "application/msword" ||
    mime === "application/vnd.oasis.opendocument.text"
  )
    return "docx";
  if (
    mime === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    mime === "application/vnd.ms-excel" ||
    mime === "text/csv" ||
    mime === "application/vnd.oasis.opendocument.spreadsheet"
  )
    return "xlsx";
  if (
    mime === "application/vnd.openxmlformats-officedocument.presentationml.presentation" ||
    mime === "application/vnd.ms-powerpoint" ||
    mime === "application/vnd.oasis.opendocument.presentation"
  )
    return "pptx";
  if (/zip|rar|7z|tar|gzip|bzip2|xz|epub|compressed/.test(mime)) return "archive";
  if (mime.startsWith("application/vnd.google-apps")) return "gdoc";
  return "other";
}

// ───────────────────────── Cache client ─────────────────────────
// Buffer file di-cache per storageKey SELAMA pratinjau terbuka (memori
// sesi + Cache Storage — lihat reader-file-cache.ts). Saat pratinjau
// ditutup / tab ditutup, buffer otomatis dihapus; anotasi tersimpan
// terpisah di MongoDB (useRemoteAnnotations). Hasil konversi office
// (HTML docx / sheet xlsx) tetap di-cache ringan per sesi.

export interface OfficeCacheEntry {
  buffer: ArrayBuffer;
  /** "pdf" bila ternyata PDF (mis. di-rename .docx) */
  actualKind: "pdf" | "office" | "unknown";
  objectUrl: string;
}

const docxHtmlCache = new Map<string, string>();
const xlsxSheetsCache = new Map<string, { name: string; html: string }[]>();

export { docxHtmlCache, xlsxSheetsCache };

// ───────────────────────── progress ─────────────────────────

export interface FetchProgress {
  loaded: number;
  total: number | null;
  /** Kecepatan berjalan (byte/detik) — bila tersedia. */
  speed?: number;
}

export { formatSpeed };

// ───────────────────────── Hook buffer office ─────────────────────────
export function useOfficeBuffer(file: CloudFileItem) {
  const key = file.storageKey;
  const [entry, setEntry] = useState<OfficeCacheEntry | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<FetchProgress | null>(null);

  const [prevKey, setPrevKey] = useState(key);
  if (prevKey !== key) {
    setPrevKey(key);
    setEntry(null);
    setError(null);
    setProgress({ loaded: 0, total: null });
  }

  useEffect(() => {
    if (entry || error) return;
    let cancelled = false;
    (async () => {
      try {
        // 1) Sudah di cache (memori sesi / Cache Storage) → instan.
        const cached = await peekReaderBuffer(key);
        if (cancelled) return;
        if (cached) {
          markReaderActive(key);
          setEntry({
            buffer: cached.buffer,
            actualKind: sniffKind(cached.buffer),
            objectUrl: cached.objectUrl,
          });
          setProgress(null);
          return;
        }

        // 2) Unduh via jalur tercepat: URL presigned S3 multi-segmen
        //    paralel, atau streaming proxy — progress real-time per chunk.
        setProgress({ loaded: 0, total: null });
        const buffer = await fastFetchBuffer(key, {
          onProgress: (p: FastProgress) => {
            if (!cancelled) setProgress(p);
          },
        });
        if (cancelled) return;

        const stored = await putReaderBuffer(key, buffer);
        if (cancelled) return;
        setEntry({
          buffer: stored.buffer,
          actualKind: sniffKind(stored.buffer),
          objectUrl: stored.objectUrl,
        });
        setProgress(null);
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
  }, [key, entry, error]);

  return { entry, error, progress };
}

/** Deteksi kasus PDF yang di-rename (magic bytes %PDF). */
function sniffKind(buffer: ArrayBuffer): "pdf" | "office" | "unknown" {
  const head = new Uint8Array(buffer, 0, Math.min(8, buffer.byteLength));
  const isPdf =
    head.length >= 4 &&
    head[0] === 0x25 && // %
    head[1] === 0x50 && // P
    head[2] === 0x44 && // D
    head[3] === 0x46; // F
  return isPdf ? "pdf" : "office";
}
