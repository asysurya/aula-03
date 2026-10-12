// ─────────────────────────────────────────────────────────────────────────
// Mesin arsip (zip / epub / tar / tar.gz / tgz / gz) — server-side, murni.
//
// Kemampuan:
//   1. LISTING tanpa dekompresi (zip: parse central directory saja —
//      arsip 100 MB ter-list instan; tar: pindai header 512-byte).
//   2. MEMBACA SATU berkas di dalam arsip ("buka tanpa ekstrak") —
//      zip: inflate hanya entri itu; tar.gz/gz: gunzip sekali (di-cap).
//   3. PERENCANAAN EKSTRAKSI — sanitasi path (anti traversal), batas
//      jumlah entri / ukuran total / ukuran per entri (anti zip-bomb).
//
// Guard keamanan:
//   · Dekompresi berjalan STREAMING dengan batas byte keras — arsip
//     jahat yang ber-expansi raksasa dipotong sebelum memori meledak.
//   · Path entri disanitasi: tanpa "..", tanpa absolut, tanpa drive
//     Windows, tanpa karakter kontrol.
//   · Semua ukuran divalidasi terhadap deklarasi header; ketidakcocokan
//     hasil vs deklarasi → ARCHIVE_CORRUPT.
//
// Modul ini TIDAK mengimpor db/crypto supaya bisa diuji unit terpisah.
// ─────────────────────────────────────────────────────────────────────────

import { Inflate, Gunzip } from "fflate";
import { extOf } from "./archive-names";

// ── Batas (selaras batas lampiran aplikasi: 100 MB) ──────────────────────

export const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;
/** Maks entri yang dikirim ke klien (listing) — arsip lebih besar tetap
 *  bisa diekstrak penuh (batas ekstraksi sendiri). */
export const MAX_LISTED_ENTRIES = 1000;
/** Maks ukuran SATU berkas di dalam arsip yang bisa dibuka/diekstrak. */
export const MAX_ENTRY_BYTES = 100 * 1024 * 1024;
/** Batas ekspansi dekompresi untuk format whole-stream (tar.gz/gz). */
export const MAX_GUNZIP_BYTES = 512 * 1024 * 1024;
/** Batas ekstraksi: jumlah entri, total isi, per entri. */
export const MAX_EXTRACT_ENTRIES = 300;
export const MAX_EXTRACT_TOTAL_BYTES = 1024 * 1024 * 1024; // 1 GB

function fmtBytes(n: number): string {
  if (n >= 1024 * 1024 * 1024) return `${Math.round(n / 1073741824)} GB`;
  if (n >= 1024 * 1024) return `${Math.round(n / 1048576)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

// ── Galat bermakna (route memetakan ke status HTTP) ──────────────────────

export type ArchiveErrorCode =
  | "ARCHIVE_UNSUPPORTED"
  | "ARCHIVE_TOO_LARGE"
  | "ARCHIVE_CORRUPT"
  | "ENTRY_NOT_FOUND"
  | "ENTRY_TOO_LARGE"
  | "EXTRACT_TOO_MANY"
  | "EXTRACT_TOO_LARGE";

export class ArchiveError extends Error {
  code: ArchiveErrorCode;
  constructor(code: ArchiveErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "ArchiveError";
  }
}

// ── Tipe hasil ───────────────────────────────────────────────────────────

export interface ArchiveEntryInfo {
  /** Path relatif dalam arsip (dengan folder, mis. "dir/sub/a.txt"). */
  path: string;
  /** Ukuran asli (belum terkompresi). */
  size: number;
  isFile: boolean;
  /** Hanya zip: ukuran terkompresi (untuk info). */
  compressedSize?: number;
}

export interface ArchiveListing {
  format: "zip" | "epub" | "tar" | "tar.gz" | "gz";
  /** Jumlah entri PENUH dalam arsip (sebelum dipotong MAX_LISTED_ENTRIES). */
  entryCount: number;
  truncated: boolean;
  /** Total ukuran isi (belum terkompresi). */
  totalBytes: number;
  entries: ArchiveEntryInfo[];
}

/** Handle arsip terbuka: listing + pembacaan entri per-path. */
export interface OpenedArchive {
  format: ArchiveListing["format"];
  entries: ArchiveEntryInfo[];
  entryCount: number;
  totalBytes: number;
  /** Baca SATU berkas di dalam arsip (path persis seperti listing). */
  read(path: string): Promise<Buffer>;
}

// ── Dekompresi ber-cap (streaming, anti bom) ─────────────────────────────

function decompressCapped(
  data: Uint8Array,
  cap: number,
  makeStream: (onData: (chunk: Uint8Array, final: boolean) => void) => {
    push: (chunk: Uint8Array, final: boolean) => void;
  },
  label: string
): Buffer {
  const parts: Buffer[] = [];
  let total = 0;
  let finished = false;
  const stream = makeStream((chunk, final) => {
    if (finished) return;
    total += chunk.length;
    if (total > cap) {
      finished = true;
      throw new ArchiveError(
        "ARCHIVE_TOO_LARGE",
        `Isi ${label} melebihi batas dekompresi ${fmtBytes(cap)} — arsip terlalu besar untuk dibuka langsung.`
      );
    }
    // Copy: fflate memakai ulang buffer internal antar callback.
    parts.push(Buffer.from(chunk));
    if (final) finished = true;
  });
  try {
    stream.push(data, true);
  } catch (e) {
    if (e instanceof ArchiveError) throw e;
    throw new ArchiveError(
      "ARCHIVE_CORRUPT",
      `Data ${label} rusak (${e instanceof Error ? e.message : String(e)}).`
    );
  }
  if (!finished) {
    // push(final) wajib memicu callback final; kalau tidak → data rusak.
    throw new ArchiveError(
      "ARCHIVE_CORRUPT",
      `Data ${label} tidak lengkap/rusak.`
    );
  }
  return parts.length === 1 ? parts[0] : Buffer.concat(parts);
}

function inflateRawCapped(data: Uint8Array, cap: number): Buffer {
  return decompressCapped(data, cap, (cb) => new Inflate(cb), "entri arsip");
}

function gunzipCapped(data: Uint8Array, cap: number): Buffer {
  return decompressCapped(data, cap, (cb) => new Gunzip(cb), "arsip gzip");
}

// ── ZIP: parse central directory (metadata saja, tanpa dekompresi) ───────

interface RawZipEntry {
  name: string;
  isFile: boolean;
  method: number;
  compressedSize: number;
  size: number;
  localOffset: number;
}

function readU32(b: Buffer, off: number): number {
  return b.readUInt32LE(off);
}
function readU16(b: Buffer, off: number): number {
  return b.readUInt16LE(off);
}
function readU64(b: Buffer, off: number): number {
  // Angka aman sampai 2^53 — arsip dibatasi 100 MB & entri dibatasi 100 MB,
  // nilai zip64 yang lebih besar akan ditolak sebagai terlalu besar.
  const v = b.readBigUInt64LE(off);
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ArchiveError(
      "ARCHIVE_TOO_LARGE",
      "Arsip mendeklarasikan berkas berukuran tidak masuk akal (>8 PB) — ditolak."
    );
  }
  return Number(v);
}

/** Cari End Of Central Directory (menoleransi komentar hingga 64 KB). */
function findEocd(buf: Buffer): number {
  const min = 22;
  if (buf.length < min) {
    throw new ArchiveError("ARCHIVE_CORRUPT", "Berkas ZIP terlalu pendek.");
  }
  const scanStart = Math.max(0, buf.length - 65557);
  for (let i = buf.length - min; i >= scanStart; i--) {
    if (readU32(buf, i) !== 0x06054b50) continue;
    const commentLen = readU16(buf, i + 20);
    if (i + min + commentLen === buf.length) return i;
  }
  throw new ArchiveError(
    "ARCHIVE_CORRUPT",
    "Struktur ZIP tidak ditemukan (bukan ZIP yang valid?)."
  );
}

function parseZipCentralDir(buf: Buffer): RawZipEntry[] {
  const eocd = findEocd(buf);
  let totalEntries = readU16(buf, eocd + 10);
  let cdOffset = readU32(buf, eocd + 16);

  // ZIP64: EOCD klasik berisi 0xFFFF/0xFFFFFFFF → cari zip64 EOCD.
  if (totalEntries === 0xffff || cdOffset === 0xffffffff) {
    const locOff = eocd - 20;
    if (locOff >= 0 && readU32(buf, locOff) === 0x07064b50) {
      const z64Off = Number(buf.readBigUInt64LE(locOff + 8));
      if (
        z64Off >= 0 &&
        z64Off + 56 <= buf.length &&
        readU32(buf, z64Off) === 0x06064b50
      ) {
        totalEntries = readU64(buf, z64Off + 32);
        cdOffset = readU64(buf, z64Off + 48);
      }
    }
  }

  const entries: RawZipEntry[] = [];
  let p = cdOffset;
  for (let i = 0; i < totalEntries; i++) {
    if (p + 46 > buf.length || readU32(buf, p) !== 0x02014b50) {
      throw new ArchiveError(
        "ARCHIVE_CORRUPT",
        "Central directory ZIP rusak (entri tidak lengkap)."
      );
    }
    const method = readU16(buf, p + 10);
    let compressedSize = readU32(buf, p + 20);
    let size = readU32(buf, p + 24);
    const nameLen = readU16(buf, p + 28);
    const extraLen = readU16(buf, p + 30);
    const commentLen = readU16(buf, p + 32);
    let localOffset = readU32(buf, p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    const extraStart = p + 46 + nameLen;

    // ZIP64 extra field (id 0x0001): ukuran/offset u64 pengganti 0xFFFFFFFF.
    if (
      size === 0xffffffff ||
      compressedSize === 0xffffffff ||
      localOffset === 0xffffffff
    ) {
      let q = extraStart;
      const extraEnd = extraStart + extraLen;
      while (q + 4 <= extraEnd) {
        const id = readU16(buf, q);
        const sz = readU16(buf, q + 2);
        if (id === 0x0001) {
          let r = q + 4;
          if (size === 0xffffffff && r + 8 <= extraEnd) {
            size = readU64(buf, r);
            r += 8;
          }
          if (compressedSize === 0xffffffff && r + 8 <= extraEnd) {
            compressedSize = readU64(buf, r);
            r += 8;
          }
          if (localOffset === 0xffffffff && r + 8 <= extraEnd) {
            localOffset = readU64(buf, r);
          }
          break;
        }
        q += 4 + sz;
      }
    }

    entries.push({
      name,
      isFile: !name.endsWith("/"),
      method,
      compressedSize,
      size,
      localOffset,
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** Baca SATU entri ZIP (decompress hanya entri itu, dengan cap). */
function readZipEntry(buf: Buffer, entry: RawZipEntry): Buffer {
  if (entry.size > MAX_ENTRY_BYTES) {
    throw new ArchiveError(
      "ENTRY_TOO_LARGE",
      `"${entry.name}" di dalam arsip ${fmtBytes(entry.size)} — melebihi batas ${fmtBytes(MAX_ENTRY_BYTES)} untuk dibuka langsung.`
    );
  }
  const off = entry.localOffset;
  if (off + 30 > buf.length || readU32(buf, off) !== 0x04034b50) {
    throw new ArchiveError(
      "ARCHIVE_CORRUPT",
      `Header lokal "${entry.name}" rusak.`
    );
  }
  const nameLen = readU16(buf, off + 26);
  const extraLen = readU16(buf, off + 28);
  const dataStart = off + 30 + nameLen + extraLen;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > buf.length) {
    throw new ArchiveError(
      "ARCHIVE_CORRUPT",
      `Data "${entry.name}" tidak lengkap (melebihi ukuran arsip).`
    );
  }
  const data = new Uint8Array(buf.subarray(dataStart, dataEnd));
  let out: Buffer;
  if (entry.method === 0) {
    out = Buffer.from(data);
  } else if (entry.method === 8) {
    out = inflateRawCapped(data, Math.min(entry.size, MAX_ENTRY_BYTES) + 1024);
  } else {
    throw new ArchiveError(
      "ARCHIVE_UNSUPPORTED",
      `"${entry.name}" memakai metode kompresi ${entry.method} yang tidak didukung.`
    );
  }
  if (out.length !== entry.size) {
    throw new ArchiveError(
      "ARCHIVE_CORRUPT",
      `Ukuran "${entry.name}" setelah dekompresi tidak cocok dengan deklarasi arsip.`
    );
  }
  return out;
}

// ── TAR: parse header 512-byte ───────────────────────────────────────────

interface TarEntry {
  name: string;
  size: number;
  isFile: boolean;
  offset: number; // offset data dalam buffer
}

function tarStr(b: Buffer, off: number, len: number): string {
  let end = off;
  const max = off + len;
  while (end < max && b[end] !== 0) end++;
  return b.toString("utf8", off, end).replace(/\0+$/, "").trim();
}

function tarSize(b: Buffer, off: number): number {
  const s = tarStr(b, off, 12);
  if (!s) return 0;
  // GNU base-256 (bit tertinggi 0x80) — jarang, tapi murah ditangani.
  if (b[off] & 0x80) {
    let v = b[off] & 0x7f;
    for (let i = 1; i < 8 && off + i < b.length; i++) {
      v = v * 256 + b[off + i];
    }
    return v;
  }
  const n = parseInt(s, 8);
  return Number.isFinite(n) ? n : 0;
}

function parseTar(buf: Buffer): TarEntry[] {
  const entries: TarEntry[] = [];
  let p = 0;
  let pendingLongName: string | null = null;
  let pendingPaxPath: string | null = null;
  while (p + 512 <= buf.length) {
    // Blok nol penuh = penanda akhir arsip.
    let allZero = true;
    for (let i = p; i + 8 <= p + 512; i += 8) {
      if (buf.readBigUInt64BE(i) !== 0n) {
        allZero = false;
        break;
      }
    }
    if (allZero) break;

    const rawName = tarStr(buf, p, 100);
    const size = tarSize(buf, p + 124);
    const type = String.fromCharCode(buf[p + 156] ?? 0);
    const magic = tarStr(buf, p + 257, 6);
    const prefix = magic.startsWith("ustar") ? tarStr(buf, p + 345, 155) : "";
    const dataOffset = p + 512;
    const dataBlocks = Math.ceil(size / 512) * 512;

    if (type === "L") {
      // GNU long name: blok berikutnya berisi nama panjang.
      pendingLongName = tarStr(buf, dataOffset, Math.min(size, 512));
    } else if (type === "x" || type === "g") {
      // pax header: cari rekam "path=..." (cukup blok pertama umumnya).
      const text = buf.toString(
        "utf8",
        dataOffset,
        Math.min(dataOffset + size, dataOffset + 32 * 1024)
      );
      const m = /(?:^|\n)\d+ path=([^\n]+)/.exec(text);
      if (m) pendingPaxPath = m[1];
    } else if (type === "5") {
      const name = pendingLongName ?? pendingPaxPath ?? joinTar(prefix, rawName);
      entries.push({ name: normTarDir(name), size: 0, isFile: false, offset: dataOffset });
      pendingLongName = null;
      pendingPaxPath = null;
    } else if (type === "0" || type === "\0" || type === "7") {
      const name = pendingLongName ?? pendingPaxPath ?? joinTar(prefix, rawName);
      if (name) {
        entries.push({ name, size, isFile: true, offset: dataOffset });
      }
      pendingLongName = null;
      pendingPaxPath = null;
    }
    p = dataOffset + dataBlocks;
  }
  return entries;
}

function joinTar(prefix: string, name: string): string {
  return prefix ? `${prefix.replace(/\/+$/, "")}/${name}` : name;
}

function normTarDir(name: string): string {
  return name.endsWith("/") ? name : `${name}/`;
}

// ── Sanitasi path entri (anti traversal saat ekstraksi) ──────────────────

/**
 * Path relatif aman untuk ekstraksi: buang "..", absolut, drive Windows,
 * karakter kontrol. Mengembalikan null bila tidak ada sisa yang berarti
 * (entri seperti "../" dibuang).
 */
export function sanitizeEntryPath(p: string): string | null {
  let norm = (p ?? "").replace(/\\/g, "/");
  norm = norm.replace(/^[A-Za-z]:/, "");
  const parts = norm
    .split("/")
    .map((seg) => seg.replace(/[\x00-\x1f\x7f]/g, "").trim())
    .filter((seg) => seg && seg !== "." && seg !== "..");
  if (parts.length === 0) return null;
  return parts.join("/");
}

// ── API utama ────────────────────────────────────────────────────────────

function zipKind(name: string): "zip" | "epub" {
  return extOf(name) === "epub" ? "epub" : "zip";
}

function toInfo(e: RawZipEntry): ArchiveEntryInfo {
  return {
    path: e.name,
    size: e.size,
    isFile: e.isFile,
    compressedSize: e.compressedSize,
  };
}

/** Buka arsip: listing metadata + pembacaan entri on-demand. */
export function openArchive(name: string, buf: Buffer): OpenedArchive {
  const ext = extOf(name);
  if (buf.length > MAX_ARCHIVE_BYTES) {
    throw new ArchiveError(
      "ARCHIVE_TOO_LARGE",
      `Arsip ${fmtBytes(buf.length)} — melebihi batas ${fmtBytes(MAX_ARCHIVE_BYTES)} untuk dibuka langsung.`
    );
  }

  if (ext === "zip" || ext === "epub") {
    const raw = parseZipCentralDir(buf);
    const byName = new Map<string, RawZipEntry>();
    for (const e of raw) if (e.isFile) byName.set(e.name, e);
    return {
      format: zipKind(name),
      entries: raw.map(toInfo),
      entryCount: raw.length,
      totalBytes: raw.reduce((s, e) => s + (e.isFile ? e.size : 0), 0),
      read: async (path) => {
        const e = byName.get(path);
        if (!e) {
          throw new ArchiveError(
            "ENTRY_NOT_FOUND",
            `"${path}" tidak ada dalam arsip.`
          );
        }
        return readZipEntry(buf, e);
      },
    };
  }

  if (ext === "tar") {
    const raw = parseTar(buf);
    return {
      format: "tar",
      entries: raw.map((e) => ({
        path: e.name,
        size: e.size,
        isFile: e.isFile,
      })),
      entryCount: raw.length,
      totalBytes: raw.reduce((s, e) => s + (e.isFile ? e.size : 0), 0),
      read: async (path) => {
        const e = raw.find((t) => t.isFile && t.name === path);
        if (!e) {
          throw new ArchiveError(
            "ENTRY_NOT_FOUND",
            `"${path}" tidak ada dalam arsip.`
          );
        }
        if (e.size > MAX_ENTRY_BYTES) {
          throw new ArchiveError(
            "ENTRY_TOO_LARGE",
            `"${path}" ${fmtBytes(e.size)} — melebihi batas ${fmtBytes(MAX_ENTRY_BYTES)}.`
          );
        }
        if (e.offset + e.size > buf.length) {
          throw new ArchiveError(
            "ARCHIVE_CORRUPT",
            `Data "${path}" tidak lengkap.`
          );
        }
        return buf.subarray(e.offset, e.offset + e.size);
      },
    };
  }

  if (ext === "tgz" || ext === "gz") {
    const isTarGz = ext === "tgz" || /\.tar$/i.test(name.slice(0, -3));
    // Dekompresi SEKALI (di-cap) — dipakai ulang semua entri.
    const plain = gunzipCapped(new Uint8Array(buf), MAX_GUNZIP_BYTES);
    if (!isTarGz) {
      // .gz berkas tunggal: entri bernama seperti arsip tanpa .gz.
      const inner =
        (name.split(/[\\/]/).pop() ?? "berkas").replace(/\.gz$/i, "") ||
        "berkas";
      return {
        format: "gz",
        entries: [{ path: inner, size: plain.length, isFile: true }],
        entryCount: 1,
        totalBytes: plain.length,
        read: async (path) => {
          if (path !== inner) {
            throw new ArchiveError(
              "ENTRY_NOT_FOUND",
              `"${path}" tidak ada dalam arsip.`
            );
          }
          if (plain.length > MAX_ENTRY_BYTES) {
            throw new ArchiveError(
              "ENTRY_TOO_LARGE",
              `Isi "${inner}" ${fmtBytes(plain.length)} — melebihi batas ${fmtBytes(MAX_ENTRY_BYTES)}.`
            );
          }
          return plain;
        },
      };
    }
    const raw = parseTar(plain);
    return {
      format: "tar.gz",
      entries: raw.map((e) => ({
        path: e.name,
        size: e.size,
        isFile: e.isFile,
      })),
      entryCount: raw.length,
      totalBytes: raw.reduce((s, e) => s + (e.isFile ? e.size : 0), 0),
      read: async (path) => {
        const e = raw.find((t) => t.isFile && t.name === path);
        if (!e) {
          throw new ArchiveError(
            "ENTRY_NOT_FOUND",
            `"${path}" tidak ada dalam arsip.`
          );
        }
        if (e.size > MAX_ENTRY_BYTES) {
          throw new ArchiveError(
            "ENTRY_TOO_LARGE",
            `"${path}" ${fmtBytes(e.size)} — melebihi batas ${fmtBytes(MAX_ENTRY_BYTES)}.`
          );
        }
        if (e.offset + e.size > plain.length) {
          throw new ArchiveError(
            "ARCHIVE_CORRUPT",
            `Data "${path}" tidak lengkap.`
          );
        }
        return plain.subarray(e.offset, e.offset + e.size);
      },
    };
  }

  throw new ArchiveError(
    "ARCHIVE_UNSUPPORTED",
    `Format .${ext || "?"} tidak bisa dibuka langsung — didukung: ZIP, EPUB, TAR, TAR.GZ, GZ.`
  );
}

/** Listing (entri dipotong MAX_LISTED_ENTRIES, truncated=true bila terpotong). */
export function listArchive(
  name: string,
  buf: Buffer
): ArchiveListing & { read: OpenedArchive["read"] } {
  const opened = openArchive(name, buf);
  const truncated = opened.entryCount > MAX_LISTED_ENTRIES;
  return {
    format: opened.format,
    entryCount: opened.entryCount,
    truncated,
    totalBytes: opened.totalBytes,
    entries: truncated
      ? opened.entries.slice(0, MAX_LISTED_ENTRIES)
      : opened.entries,
    read: opened.read,
  };
}

// ── Perencanaan ekstraksi ────────────────────────────────────────────────

export interface ExtractPlanItem {
  /** Path relatif SANITASI (aman sebagai nama folder/berkas). */
  path: string;
  /** Path ASLI di dalam arsip (untuk MEMBACA entri — bisa berbeda dari
   *  path hasil sanitasi, mis. "../x.txt" → "x.txt"). */
  rawPath: string;
  size: number;
  isFile: boolean;
}

export interface ExtractPlan {
  items: ExtractPlanItem[];
  /** Entri dibuang karena pathnya tidak aman/kosong. */
  skippedUnsafe: number;
  /** Enri dibuang karena ukurannya melebihi batas per berkas. */
  skippedOversize: number;
}

/** Rencana ekstraksi aman (sanitasi + batas jumlah/total/per-entri). */
export function planExtraction(entries: ArchiveEntryInfo[]): ExtractPlan {
  const items: ExtractPlanItem[] = [];
  let skippedUnsafe = 0;
  let skippedOversize = 0;
  const seen = new Set<string>();

  for (const e of entries) {
    const safe = sanitizeEntryPath(e.path);
    if (!safe) {
      skippedUnsafe++;
      continue;
    }
    // Folder duplikat ("dir/" eksplisit + tersirat dari "dir/a") → sekali.
    const key = e.isFile ? safe : `${safe}/`;
    if (seen.has(key)) continue;
    seen.add(key);

    if (e.isFile && e.size > MAX_ENTRY_BYTES) {
      skippedOversize++;
      continue;
    }
    items.push({ path: safe, rawPath: e.path, size: e.size, isFile: e.isFile });
  }

  if (items.length > MAX_EXTRACT_ENTRIES) {
    throw new ArchiveError(
      "EXTRACT_TOO_MANY",
      `Arsip berisi ${items.length} entri — melebihi batas ${MAX_EXTRACT_ENTRIES} untuk diekstrak sekaligus.`
    );
  }
  const total = items.reduce((s, i) => s + (i.isFile ? i.size : 0), 0);
  if (total > MAX_EXTRACT_TOTAL_BYTES) {
    throw new ArchiveError(
      "EXTRACT_TOO_LARGE",
      `Total isi arsip ${fmtBytes(total)} — melebihi batas ${fmtBytes(MAX_EXTRACT_TOTAL_BYTES)} untuk diekstrak sekaligus.`
    );
  }
  return { items, skippedUnsafe, skippedOversize };
}

/** Baca satu entri berdasar path asli — dipakai route "buka tanpa ekstrak". */
export async function readArchiveEntry(
  name: string,
  buf: Buffer,
  entryPath: string
): Promise<Buffer> {
  const opened = openArchive(name, buf);
  return opened.read(entryPath);
}
