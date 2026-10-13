// ─────────────────────────────────────────────────────────────────────────
// Mesin arsip (zip / epub / tar / tar.gz / tgz / gz) — server-side, murni.
//
// Task 34: mesin kini bekerja di atas SUMBER BYTE RANDOM-ACCESS
// (ByteSource — berkas di disk atau buffer), bukan buffer utuh di RAM:
//   · Listing ZIP membaca CENTRAL DIRECTORY saja (di akhir berkas) —
//     arsip 5 GB ter-list tanpa memuat isi ke memori.
//   · Baca SATU entri zip hanya membaca rentang data entri itu.
//   · Listing TAR memindai header 512-byte dan MELEWATI blok data
//     tanpa membacanya.
//   · tar.gz / gz: pemanggil (route) sudah mematerialkan hasil gunzip
//     ke berkas disk (streaming ber-cap) — mesin menerima sumber PLAIN.
//
// Batas (Task 34):
//   · BUKA (listing + pratinjau entri): arsip maks 5 GB.
//   · EKSTRAK: arsip maks 2 GB; maks 1000 entri · 4 GB total · 1 GB
//     per berkas.
//   · SATU entri dibuka/diekstrak maks 1 GB (selaras batas upload).
//
// Guard keamanan:
//   · Dekompresi berjalan STREAMING dengan batas byte keras — arsip
//     jahat yang ber-expansi raksasa dipotong sebelum memori meledak.
//   · Path entri disanitasi: tanpa "..", tanpa absolut, tanpa drive
//     Windows, tanpa karakter kontrol.
//   · Semua ukuran divalidasi terhadap deklarasi header; ketidakcocokan
//     hasil vs deklarasi → ARCHIVE_CORRUPT.
//
// Modul ini TIDAK mengimpor db supaya bisa diuji unit terpisah.
// ─────────────────────────────────────────────────────────────────────────

import { Inflate } from "fflate";
import { createInflateRaw } from "node:zlib";
import { Readable, Transform } from "node:stream";
import { extOf } from "./archive-names";

// ── Batas ────────────────────────────────────────────────────────────────

/** BUKA arsip (listing + pratinjau entri tanpa ekstrak): maks 5 GB. */
export const MAX_ARCHIVE_OPEN_BYTES = 5 * 1024 * 1024 * 1024;
/** EKSTRAK arsip penuh: maks 2 GB. */
export const MAX_ARCHIVE_EXTRACT_BYTES = 2 * 1024 * 1024 * 1024;
/** Maks entri yang dikirim ke klien (listing) — arsip lebih besar tetap
 *  bisa diekstrak penuh (batas ekstraksi sendiri). */
export const MAX_LISTED_ENTRIES = 1000;
/** Maks ukuran SATU berkas di dalam arsip yang bisa dibuka/diekstrak
 *  (selaras batas upload aplikasi: 1 GB). */
export const MAX_ENTRY_BYTES = 1024 * 1024 * 1024;
/** Maks EKSTRAKSI: jumlah entri, total isi. */
export const MAX_EXTRACT_ENTRIES = 1000;
export const MAX_EXTRACT_TOTAL_BYTES = 4 * 1024 * 1024 * 1024;
/** Ukuran entri di atas ini dilayani/diunggah lewat STREAMING dari disk
 *  (bukan buffer RAM) oleh route. */
export const RAM_ENTRY_THRESHOLD = 64 * 1024 * 1024;
/** Kap metadata entri yang disimpan di RAM saat parse (listing tetap
 *  di-slice ke MAX_LISTED_ENTRIES; entryCount akurat dihitung terpisah). */
const MAX_STORED_META_ENTRIES = 4000;
/** Sanity: jumlah entri gila (>200 ribu) ditolak. */
const MAX_COUNTED_ENTRIES = 200000;

export function fmtBytes(n: number): string {
  if (n >= 1024 * 1024 * 1024) {
    const gb = n / (1024 * 1024 * 1024);
    return `${Number.isInteger(gb) ? gb : gb.toFixed(1)} GB`;
  }
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

// ── Sumber byte random-access ────────────────────────────────────────────

/**
 * Sumber byte random-access: berkas di disk (FileByteSource — lihat
 * archive-cache.ts) atau buffer di RAM (bufferSource — unit test / arsip
 * kecil). Mesin arsip hanya mengenal interface ini.
 */
export interface ByteSource {
  readonly size: number;
  readAt(offset: number, length: number): Promise<Buffer>;
}

/** Bungkus buffer menjadi ByteSource (tanpa salinan). */
export function bufferSource(buf: Buffer): ByteSource {
  return {
    size: buf.length,
    readAt: async (offset, length) => {
      if (offset < 0 || length < 0 || offset + length > buf.length) {
        throw new ArchiveError(
          "ARCHIVE_CORRUPT",
          "Rentang baca melebihi ukuran arsip."
        );
      }
      return buf.subarray(offset, offset + length);
    },
  };
}

/** Pembungkus penghitung byte yang dibaca (unit test: membuktikan listing
 *  TIDAK membaca seluruh isi arsip). */
export function countingSource(src: ByteSource): ByteSource & {
  bytesRead: () => number;
} {
  let total = 0;
  return {
    size: src.size,
    readAt: async (offset, length) => {
      const b = await src.readAt(offset, length);
      total += b.length;
      return b;
    },
    bytesRead: () => total,
  };
}

/**
 * Alirkan rentang sumber sebagai Node Readable (potongan 1 MB) — untuk
 * entri besar tanpa memuat utuh ke RAM.
 */
export function sourceReadable(
  src: ByteSource,
  offset: number,
  length: number
): Readable {
  const CHUNK = 1024 * 1024;
  let pos = offset;
  const end = offset + length;
  return new Readable({
    autoDestroy: true,
    async read() {
      try {
        if (pos >= end) {
          this.push(null);
          return;
        }
        const take = Math.min(CHUNK, end - pos);
        const buf = await src.readAt(pos, take);
        pos += buf.length;
        if (!this.push(buf)) return; // backpressure ditangani Readable
      } catch (e) {
        this.destroy(e instanceof Error ? e : new Error(String(e)));
      }
    },
  });
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

/** Rentang data mentah satu entri (sebelum dekompresi). */
export interface EntryRange {
  /** Offset data terkompresi mentah dalam sumber. */
  offset: number;
  /** Panjang data terkompresi mentah (stored/tar: = size). */
  compressedSize: number;
  /** Ukuran asli setelah dekompresi. */
  size: number;
  /** 0 = stored/tar; 8 = deflate. */
  method: number;
}

/** Handle arsip terbuka: listing + pembacaan entri per-path. */
export interface OpenedArchive {
  format: ArchiveListing["format"];
  entries: ArchiveEntryInfo[];
  entryCount: number;
  totalBytes: number;
  /** Baca SATU berkas di dalam arsip ke BUFFER RAM (≤ MAX_ENTRY_BYTES). */
  read(path: string): Promise<Buffer>;
  /** Rentang data mentah entri (offset/panjang/metode) — dipakai route
   *  untuk materialisasi disk & streaming. */
  rawRange(path: string): Promise<EntryRange>;
}

// ── Dekompresi ber-cap (anti bom) ────────────────────────────────────────

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

// ── Pembaca berurutan dengan jendela (sliding window) ────────────────────

/**
 * Pembaca berurutan di atas ByteSource: menjaga jendela buffer kecil
 * (default 1 MB) dan memuat ulang seperlunya. Data yang DILEWATI
 * (skip) tidak pernah dibaca dari sumber — inilah yang membuat listing
 * tar/zip tidak memuat isi arsip ke memori.
 */
class WindowReader {
  private buf: Buffer = Buffer.alloc(0);
  private bufPos = 0; // posisi dalam buf
  /** Offset berkas dari buf[0]. */
  private bufFilePos: number;
  /** Offset berkas berikutnya yang belum dimuat ke jendela. */
  private readFrom: number;
  bytesRead = 0;

  constructor(
    private readonly src: ByteSource,
    start: number,
    private readonly windowSize = 1024 * 1024
  ) {
    this.bufFilePos = start;
    this.readFrom = start;
  }

  /** Posisi logis saat ini dalam berkas. */
  get pos(): number {
    return this.bufFilePos + this.bufPos;
  }

  private async readAtSafe(offset: number, length: number): Promise<Buffer> {
    if (length <= 0) return Buffer.alloc(0);
    if (offset < 0 || offset + length > this.src.size) {
      throw new ArchiveError("ARCHIVE_CORRUPT", "Data arsip tidak lengkap.");
    }
    const b = await this.src.readAt(offset, length);
    this.bytesRead += b.length;
    return b;
  }

  /** Pastikan ≥ n byte tersedia di jendela dari posisi sekarang. */
  private async ensure(n: number): Promise<void> {
    if (this.buf.length - this.bufPos >= n) return;
    // Buang prefix terkonsumsi.
    this.buf = this.bufPos ? this.buf.subarray(this.bufPos) : this.buf;
    this.bufFilePos += this.bufPos;
    this.bufPos = 0;
    const remaining = this.buf.length;
    const want = Math.max(this.windowSize, n) - remaining;
    const end = Math.min(this.src.size, this.readFrom + want);
    if (this.readFrom >= this.src.size && remaining < n) {
      throw new ArchiveError("ARCHIVE_CORRUPT", "Data arsip tidak lengkap.");
    }
    const chunk = await this.readAtSafe(this.readFrom, end - this.readFrom);
    this.readFrom = end;
    this.buf = remaining ? Buffer.concat([this.buf, chunk]) : chunk;
  }

  /** Baca tepat n byte dari posisi sekarang dan maju. */
  async readExact(n: number): Promise<Buffer> {
    await this.ensure(n);
    const out = this.buf.subarray(this.bufPos, this.bufPos + n);
    this.bufPos += n;
    return out;
  }

  /** Maju n byte TANPA membaca dari sumber (lewati blok data). */
  skip(n: number): void {
    const inWindow = Math.min(n, this.buf.length - this.bufPos);
    this.bufPos += inWindow;
    const rest = n - inWindow;
    if (rest > 0) {
      // Sisa melewati akhir jendela: buang jendela & geser posisi berkas.
      this.buf = Buffer.alloc(0);
      this.bufFilePos += this.bufPos + rest;
      this.bufPos = 0;
      this.readFrom = Math.max(this.readFrom, this.bufFilePos);
    }
  }
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
  // Angka aman sampai 2^53 — arsip dibatasi 5 GB & entri 1 GB, nilai
  // zip64 yang lebih besar akan ditolak sebagai terlalu besar.
  const v = b.readBigUInt64LE(off);
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ArchiveError(
      "ARCHIVE_TOO_LARGE",
      "Arsip mendeklarasikan berkas berukuran tidak masuk akal (>8 PB) — ditolak."
    );
  }
  return Number(v);
}

/** Cari End Of Central Directory dalam buffer ekor (menoleransi komentar
 *  hingga 64 KB). Mengembalikan offset EOCD RELATIF ekor. */
function findEocdInTail(tail: Buffer): number {
  const min = 22;
  if (tail.length < min) {
    throw new ArchiveError("ARCHIVE_CORRUPT", "Berkas ZIP terlalu pendek.");
  }
  const scanStart = Math.max(0, tail.length - 65557);
  for (let i = tail.length - min; i >= scanStart; i--) {
    if (readU32(tail, i) !== 0x06054b50) continue;
    const commentLen = readU16(tail, i + 20);
    if (i + min + commentLen === tail.length) return i;
  }
  throw new ArchiveError(
    "ARCHIVE_CORRUPT",
    "Struktur ZIP tidak ditemukan (bukan ZIP yang valid?)."
  );
}

/** Hasil parse central directory: metadata (dipotong kap) + jumlah penuh. */
interface ZipCdParse {
  entries: RawZipEntry[];
  count: number;
}

/**
 * Parse central directory ZIP dari ByteSource — HANYA membaca ekor
 * (pencarian EOCD) + rentang central directory; isi berkas tidak
 * tersentuh. totalEntries di atas kap metadata tetap dihitung akurat.
 */
async function parseZipCentralDir(src: ByteSource): Promise<ZipCdParse> {
  const tailLen = Math.min(src.size, 65557 + 1024);
  const tail = await src.readAt(src.size - tailLen, tailLen);
  const eocdRel = findEocdInTail(tail);
  const eocd = src.size - tailLen + eocdRel; // offset absolut EOCD
  let totalEntries = readU16(tail, eocdRel + 10);
  let cdOffset = readU32(tail, eocdRel + 16);

  // ZIP64: EOCD klasik berisi 0xFFFF/0xFFFFFFFF → cari zip64 EOCD.
  if (totalEntries === 0xffff || cdOffset === 0xffffffff) {
    const locRel = eocdRel - 20;
    if (locRel >= 0 && readU32(tail, locRel) === 0x07064b50) {
      const z64Off = Number(tail.readBigUInt64LE(locRel + 8));
      if (z64Off >= 0 && z64Off + 56 <= eocd) {
        const z64 = await src.readAt(z64Off, 56);
        if (readU32(z64, 0) === 0x06064b50) {
          totalEntries = readU64(z64, 32);
          cdOffset = readU64(z64, 48);
        }
      }
    }
  }
  if (totalEntries > MAX_COUNTED_ENTRIES) {
    throw new ArchiveError(
      "ARCHIVE_TOO_LARGE",
      `Arsip berisi ${totalEntries} entri — terlalu banyak untuk dibuka langsung.`
    );
  }

  // Central directory berakhir sebelum EOCD / zip64 locator.
  const cdEnd = Math.min(eocd, src.size);
  if (cdOffset < 0 || cdOffset >= cdEnd) {
    throw new ArchiveError(
      "ARCHIVE_CORRUPT",
      "Central directory ZIP rusak (offset tidak valid)."
    );
  }

  const entries: RawZipEntry[] = [];
  const reader = new WindowReader(src, cdOffset);
  let count = 0;
  for (let i = 0; i < totalEntries; i++) {
    if (reader.pos + 46 > cdEnd) {
      throw new ArchiveError(
        "ARCHIVE_CORRUPT",
        "Central directory ZIP rusak (entri tidak lengkap)."
      );
    }
    const head = await reader.readExact(46);
    if (readU32(head, 0) !== 0x02014b50) {
      throw new ArchiveError(
        "ARCHIVE_CORRUPT",
        "Central directory ZIP rusak (entri tidak lengkap)."
      );
    }
    const method = readU16(head, 10);
    let compressedSize = readU32(head, 20);
    let size = readU32(head, 24);
    const nameLen = readU16(head, 28);
    const extraLen = readU16(head, 30);
    const commentLen = readU16(head, 32);
    let localOffset = readU32(head, 42);

    const name = (await reader.readExact(nameLen)).toString("utf8");
    const extraBuf =
      extraLen > 0 ? await reader.readExact(extraLen) : Buffer.alloc(0);
    if (commentLen > 0) await reader.skip(commentLen);
    count++;

    // ZIP64 extra field (id 0x0001): ukuran/offset u64 pengganti 0xFFFFFFFF.
    if (
      size === 0xffffffff ||
      compressedSize === 0xffffffff ||
      localOffset === 0xffffffff
    ) {
      let q = 0;
      const extraEnd = extraBuf.length;
      while (q + 4 <= extraEnd) {
        const id = readU16(extraBuf, q);
        const sz = readU16(extraBuf, q + 2);
        if (id === 0x0001) {
          let r = q + 4;
          if (size === 0xffffffff && r + 8 <= extraEnd) {
            size = readU64(extraBuf, r);
            r += 8;
          }
          if (compressedSize === 0xffffffff && r + 8 <= extraEnd) {
            compressedSize = readU64(extraBuf, r);
            r += 8;
          }
          if (localOffset === 0xffffffff && r + 8 <= extraEnd) {
            localOffset = readU64(extraBuf, r);
          }
          break;
        }
        q += 4 + sz;
      }
    }

    if (entries.length < MAX_STORED_META_ENTRIES) {
      entries.push({
        name,
        isFile: !name.endsWith("/"),
        method,
        compressedSize,
        size,
        localOffset,
      });
    }
  }
  return { entries, count };
}

/** Validasi + rentang data mentah satu entri ZIP (baca header lokal). */
async function zipEntryRange(
  src: ByteSource,
  entry: RawZipEntry
): Promise<EntryRange> {
  const off = entry.localOffset;
  if (off + 30 > src.size) {
    throw new ArchiveError(
      "ARCHIVE_CORRUPT",
      `Header lokal "${entry.name}" rusak.`
    );
  }
  const head = await src.readAt(off, 30);
  if (readU32(head, 0) !== 0x04034b50) {
    throw new ArchiveError(
      "ARCHIVE_CORRUPT",
      `Header lokal "${entry.name}" rusak.`
    );
  }
  const nameLen = readU16(head, 26);
  const extraLen = readU16(head, 28);
  const dataStart = off + 30 + nameLen + extraLen;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > src.size) {
    throw new ArchiveError(
      "ARCHIVE_CORRUPT",
      `Data "${entry.name}" tidak lengkap (melebihi ukuran arsip).`
    );
  }
  return {
    offset: dataStart,
    compressedSize: entry.compressedSize,
    size: entry.size,
    method: entry.method,
  };
}

/** Pastikan metode kompresi entri didukung. */
function assertZipMethod(entry: RawZipEntry): void {
  if (entry.method !== 0 && entry.method !== 8) {
    throw new ArchiveError(
      "ARCHIVE_UNSUPPORTED",
      `"${entry.name}" memakai metode kompresi ${entry.method} yang tidak didukung.`
    );
  }
}

// ── TAR: parse header 512-byte (lewati blok data tanpa membaca) ──────────

interface TarEntry {
  name: string;
  size: number;
  isFile: boolean;
  offset: number; // offset data dalam sumber
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

/** Hasil parse tar: metadata (dipotong kap) + jumlah penuh. */
interface TarParse {
  entries: TarEntry[];
  count: number;
}

async function parseTar(src: ByteSource): Promise<TarParse> {
  const entries: TarEntry[] = [];
  // Jendela kecil (64 KB): listing tar membaca ±64 KB per entri — blok data
  // besar DILEWATI tanpa dibaca (inti anti-memori utk arsip GB-an).
  const reader = new WindowReader(src, 0, 64 * 1024);
  let pendingLongName: string | null = null;
  let pendingPaxPath: string | null = null;
  let count = 0;
  while (reader.pos + 512 <= src.size) {
    const head = await reader.readExact(512);
    // Blok nol penuh = penanda akhir arsip.
    let allZero = true;
    for (let i = 0; i + 8 <= 512; i += 8) {
      if (head.readBigUInt64BE(i) !== BigInt(0)) {
        allZero = false;
        break;
      }
    }
    if (allZero) break;

    const rawName = tarStr(head, 0, 100);
    const size = tarSize(head, 124);
    const type = String.fromCharCode(head[156] ?? 0);
    const magic = tarStr(head, 257, 6);
    const prefix = magic.startsWith("ustar") ? tarStr(head, 345, 155) : "";
    const dataOffset = reader.pos; // posisi logis setelah header
    const dataBlocks = Math.ceil(size / 512) * 512;

    if (type === "L") {
      // GNU long name: blok berikutnya berisi nama panjang.
      pendingLongName = tarStr(
        await reader.readExact(Math.min(size, 512)),
        0,
        Math.min(size, 512)
      );
    } else if (type === "x" || type === "g") {
      // pax header: cari rekam "path=..." (cukup blok pertama umumnya).
      const text = (
        await reader.readExact(Math.min(size, 32 * 1024))
      ).toString("utf8");
      const m = /(?:^|\n)\d+ path=([^\n]+)/.exec(text);
      if (m) pendingPaxPath = m[1];
    } else {
      let name = pendingLongName ?? pendingPaxPath ?? joinTar(prefix, rawName);
      pendingLongName = null;
      pendingPaxPath = null;
      if (type === "5") {
        name = normTarDir(name);
        count++;
        if (entries.length < MAX_STORED_META_ENTRIES) {
          entries.push({ name, size: 0, isFile: false, offset: dataOffset });
        }
      } else if (type === "0" || type === "\0" || type === "7") {
        if (name) {
          count++;
          if (entries.length < MAX_STORED_META_ENTRIES) {
            entries.push({ name, size, isFile: true, offset: dataOffset });
          }
        }
      }
    }
    // MAJUI: blok data DILEWATI tanpa dibaca (inti anti-memori).
    reader.skip(dataBlocks);
    if (count > MAX_COUNTED_ENTRIES) {
      throw new ArchiveError(
        "ARCHIVE_TOO_LARGE",
        "Arsip TAR berisi terlalu banyak entri untuk dibuka langsung."
      );
    }
  }
  return { entries, count };
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

function notFound(path: string): ArchiveError {
  return new ArchiveError("ENTRY_NOT_FOUND", `"${path}" tidak ada dalam arsip.`);
}

function entryTooLarge(path: string, size: number): ArchiveError {
  return new ArchiveError(
    "ENTRY_TOO_LARGE",
    `"${path}" di dalam arsip ${fmtBytes(size)} — melebihi batas ${fmtBytes(
      MAX_ENTRY_BYTES
    )} untuk dibuka langsung.`
  );
}

/** Sumber byte yang dipakai tiap handle (untuk streaming entri). */
const openedSource = new WeakMap<OpenedArchive, ByteSource>();

/**
 * Buka arsip: listing metadata + pembacaan entri on-demand.
 *
 * zip/epub/tar → src = berkas arsip apa adanya.
 * tgz/gz       → src = hasil gunzip SUDAH dimaterialisasi pemanggil
 *                (lihat archive-cache.ts); deteksi tar.gz vs gz tunggal
 *                tetap dari `name`.
 */
export async function openArchive(
  name: string,
  src: ByteSource
): Promise<OpenedArchive> {
  if (src.size > MAX_ARCHIVE_OPEN_BYTES) {
    throw new ArchiveError(
      "ARCHIVE_TOO_LARGE",
      `Arsip ${fmtBytes(src.size)} — melebihi batas ${fmtBytes(
        MAX_ARCHIVE_OPEN_BYTES
      )} untuk dibuka langsung.`
    );
  }

  const ext = extOf(name);

  if (ext === "zip" || ext === "epub") {
    const { entries: raw, count } = await parseZipCentralDir(src);
    const byName = new Map<string, RawZipEntry>();
    for (const e of raw) if (e.isFile) byName.set(e.name, e);
    const readRange = async (path: string): Promise<EntryRange> => {
      const e = byName.get(path);
      if (!e) throw notFound(path);
      assertZipMethod(e);
      if (e.size > MAX_ENTRY_BYTES) throw entryTooLarge(path, e.size);
      return zipEntryRange(src, e);
    };
    const handle: OpenedArchive = {
      format: zipKind(name),
      entries: raw.map((e) => ({
        path: e.name,
        size: e.size,
        isFile: e.isFile,
        compressedSize: e.compressedSize,
      })),
      entryCount: count,
      totalBytes: raw.reduce((s, e) => s + (e.isFile ? e.size : 0), 0),
      read: async (path) => {
        const r = await readRange(path);
        if (r.method === 0) {
          return await src.readAt(r.offset, r.compressedSize);
        }
        const data = await src.readAt(r.offset, r.compressedSize);
        const out = inflateRawCapped(
          data,
          Math.min(r.size, MAX_ENTRY_BYTES) + 1024
        );
        if (out.length !== r.size) {
          throw new ArchiveError(
            "ARCHIVE_CORRUPT",
            `Ukuran "${path}" setelah dekompresi tidak cocok dengan deklarasi arsip.`
          );
        }
        return out;
      },
      rawRange: (path) => readRange(path),
    };
    openedSource.set(handle, src);
    return handle;
  }

  if (ext === "tar") {
    const { entries: raw, count } = await parseTar(src);
    const byName = new Map<string, TarEntry>();
    for (const e of raw) if (e.isFile) byName.set(e.name, e);
    const readRange = async (path: string): Promise<EntryRange> => {
      const e = byName.get(path);
      if (!e) throw notFound(path);
      if (e.size > MAX_ENTRY_BYTES) throw entryTooLarge(path, e.size);
      if (e.offset + e.size > src.size) {
        throw new ArchiveError(
          "ARCHIVE_CORRUPT",
          `Data "${path}" tidak lengkap.`
        );
      }
      return { offset: e.offset, compressedSize: e.size, size: e.size, method: 0 };
    };
    const handle: OpenedArchive = {
      format: "tar",
      entries: raw.map((e) => ({ path: e.name, size: e.size, isFile: e.isFile })),
      entryCount: count,
      totalBytes: raw.reduce((s, e) => s + (e.isFile ? e.size : 0), 0),
      read: async (path) => {
        const r = await readRange(path);
        return await src.readAt(r.offset, r.size);
      },
      rawRange: (path) => readRange(path),
    };
    openedSource.set(handle, src);
    return handle;
  }

  if (ext === "tgz" || ext === "gz") {
    const isTarGz = ext === "tgz" || /\.tar$/i.test(name.slice(0, -3));
    if (!isTarGz) {
      // .gz berkas tunggal: seluruh sumber (hasil gunzip) = isi berkas.
      const inner =
        (name.split(/[\\/]/).pop() ?? "berkas").replace(/\.gz$/i, "") ||
        "berkas";
      const total = src.size;
      if (total > MAX_ENTRY_BYTES) throw entryTooLarge(inner, total);
      const handle: OpenedArchive = {
        format: "gz",
        entries: [{ path: inner, size: total, isFile: true }],
        entryCount: 1,
        totalBytes: total,
        read: async (path) => {
          if (path !== inner) throw notFound(path);
          return await src.readAt(0, total);
        },
        rawRange: async (path) => {
          if (path !== inner) throw notFound(path);
          return { offset: 0, compressedSize: total, size: total, method: 0 };
        },
      };
      openedSource.set(handle, src);
      return handle;
    }
    const { entries: raw, count } = await parseTar(src);
    const byName = new Map<string, TarEntry>();
    for (const e of raw) if (e.isFile) byName.set(e.name, e);
    const readRange = async (path: string): Promise<EntryRange> => {
      const e = byName.get(path);
      if (!e) throw notFound(path);
      if (e.size > MAX_ENTRY_BYTES) throw entryTooLarge(path, e.size);
      if (e.offset + e.size > src.size) {
        throw new ArchiveError(
          "ARCHIVE_CORRUPT",
          `Data "${path}" tidak lengkap.`
        );
      }
      return { offset: e.offset, compressedSize: e.size, size: e.size, method: 0 };
    };
    const handle: OpenedArchive = {
      format: "tar.gz",
      entries: raw.map((e) => ({ path: e.name, size: e.size, isFile: e.isFile })),
      entryCount: count,
      totalBytes: raw.reduce((s, e) => s + (e.isFile ? e.size : 0), 0),
      read: async (path) => {
        const r = await readRange(path);
        return await src.readAt(r.offset, r.size);
      },
      rawRange: (path) => readRange(path),
    };
    openedSource.set(handle, src);
    return handle;
  }

  throw new ArchiveError(
    "ARCHIVE_UNSUPPORTED",
    `Format .${ext || "?"} tidak bisa dibuka langsung — didukung: ZIP, EPUB, TAR, TAR.GZ, GZ.`
  );
}

// ── Streaming entri (dipakai route utk entri besar / upload streaming) ────

/**
 * Stream SATU entri arsip sebagai Node Readable dengan CAP keras:
 * total byte terdekompresi dihitung saat mengalir — melebihi
 * MAX_ENTRY_BYTES → stream di-destroy (anti zip-bomb).
 * Method 0 (stored/tar/gz) = salinan rentang mentah.
 */
export async function makeEntryStream(
  opened: OpenedArchive,
  path: string
): Promise<{ stream: Readable; size: number }> {
  const src = openedSource.get(opened);
  if (!src) throw new Error("Sumber arsip tidak tersedia.");
  const r = await opened.rawRange(path);
  if (r.method === 0) {
    return {
      stream: sourceReadable(src, r.offset, r.compressedSize),
      size: r.size,
    };
  }
  // Deflate: pompa rentang mentah → inflateRaw, hitung cap.
  const raw = sourceReadable(src, r.offset, r.compressedSize);
  const infl = createInflateRaw();
  let total = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      total += chunk.length;
      if (total > MAX_ENTRY_BYTES) {
        raw.destroy();
        cb(
          new ArchiveError(
            "ENTRY_TOO_LARGE",
            `Isi "${path}" melebihi batas ${fmtBytes(MAX_ENTRY_BYTES)} untuk dibuka langsung.`
          )
        );
        return;
      }
      cb(null, chunk);
    },
  });
  // Pompa manual + teruskan galat: error di sumber/inflate menghancurkan
  // stream hasil supaya konsumen (pipeline unduh/materialisasi) melihatnya.
  const fwd = (err: Error | null | undefined) => {
    if (err && !counter.destroyed) counter.destroy(err);
  };
  raw.on("error", fwd);
  infl.on("error", fwd);
  // Pelindung "unhandled error event" bila konsumen belum memasang listener.
  counter.on("error", () => {});
  raw.pipe(infl).pipe(counter);
  return { stream: counter, size: r.size };
}

/** Listing (entri dipotong MAX_LISTED_ENTRIES, truncated=true bila terpotong). */
export async function listArchive(
  name: string,
  src: ByteSource
): Promise<ArchiveListing> {
  const opened = await openArchive(name, src);
  const truncated = opened.entryCount > MAX_LISTED_ENTRIES;
  return {
    format: opened.format,
    entryCount: opened.entryCount,
    truncated,
    totalBytes: opened.totalBytes,
    entries: truncated
      ? opened.entries.slice(0, MAX_LISTED_ENTRIES)
      : opened.entries,
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
  /** Entri dibuang karena ukurannya melebihi batas per berkas. */
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
      `Total isi arsip ${fmtBytes(total)} — melebihi batas ${fmtBytes(
        MAX_EXTRACT_TOTAL_BYTES
      )} untuk diekstrak sekaligus.`
    );
  }
  return { items, skippedUnsafe, skippedOversize };
}

/** Baca satu entri berdasar path asli — dipakai route "buka tanpa ekstrak". */
export async function readArchiveEntry(
  name: string,
  src: ByteSource,
  entryPath: string
): Promise<Buffer> {
  const opened = await openArchive(name, src);
  return opened.read(entryPath);
}
