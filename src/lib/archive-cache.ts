// ─────────────────────────────────────────────────────────────────────────
// Cache DISK untuk arsip besar + sumber byte berkas (Task 34).
//
// Mengapa: membuka arsip 5 GB tidak boleh memuat arsip ke RAM. Arsip
// diunduh/dimaterialkan SEKALI ke berkas sementara di disk (LRU, TTL),
// lalu mesin arsip membacanya per-rentang (ByteSource).
//
// Direktori cache: env AI_ARCHIVE_CACHE_DIR → <aplikasi>/.aula-archive-cache
// → os.tmpdir()/aula-archive-cache (fallback serverless). Setiap kandidat
// diuji tulis dulu (meniru tts-piper-paths.ts).
//
// Guard:
//   · Cek ruang kosong (statfs) SEBELUM produksi — kekurangan ruang →
//     pesan ramah (kode NO_SPACE), bukan ENOSPC mentah.
//   · Kap LRU: 6 berkas / 8 GB total / TTL 30 menit; berkas yatim di
//     direktori (>2 jam, pola nama cache) disapu lazily.
// ─────────────────────────────────────────────────────────────────────────

import { promises as fs } from "fs";
import { createReadStream, createWriteStream } from "node:fs";
import path from "path";
import os from "os";
import { createHash } from "crypto";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import type { Readable, Writable } from "node:stream";
import {
  makeEntryStream,
  ArchiveError,
  type OpenedArchive,
} from "@/lib/archive";

// ── Batas cache ──────────────────────────────────────────────────────────

const MAX_DISK_ENTRIES = 6;
const MAX_DISK_TOTAL_BYTES = 8 * 1024 * 1024 * 1024; // 8 GB
const DISK_TTL_MS = 30 * 60 * 1000; // 30 menit
const ORPHAN_SWEEP_MS = 2 * 60 * 60 * 1000; // 2 jam
/** Margin ruang bebas minimal saat produksi berkas cache. */
const FREE_MARGIN_BYTES = 256 * 1024 * 1024;
/** Kap dekompresi gzip whole-stream (tar.gz/gz) saat materialisasi. */
export const MAX_GUNZIP_BYTES = 5 * 1024 * 1024 * 1024;

// ── Galat cache ──────────────────────────────────────────────────────────

export type ArchiveCacheErrorCode = "NO_WRITABLE_DIR" | "NO_SPACE";

export class ArchiveCacheError extends Error {
  code: ArchiveCacheErrorCode;
  constructor(code: ArchiveCacheErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "ArchiveCacheError";
  }
}

// ── Direktori cache writable (env → app → tmp) ───────────────────────────

let cachedDir: string | null | undefined;

async function probeWritable(dir: string): Promise<boolean> {
  try {
    await fs.mkdir(dir, { recursive: true });
    const probe = path.join(dir, `.probe-${Date.now()}`);
    await fs.writeFile(probe, "ok");
    await fs.unlink(probe);
    return true;
  } catch {
    return false;
  }
}

/** Direktori cache arsip yang bisa ditulis (diuji tulis). null bila semua
 *  kandidat gagal. Memoized per proses. */
export async function resolveArchiveCacheDir(): Promise<string | null> {
  if (cachedDir !== undefined) return cachedDir;
  const candidates: string[] = [];
  const envDir = process.env.AI_ARCHIVE_CACHE_DIR;
  if (envDir && envDir.trim()) candidates.push(path.resolve(envDir.trim()));
  candidates.push(path.join(process.cwd(), ".aula-archive-cache"));
  candidates.push(path.join(os.tmpdir(), "aula-archive-cache"));
  for (const c of candidates) {
    if (await probeWritable(c)) {
      cachedDir = c;
      return c;
    }
  }
  cachedDir = null;
  return null;
}

function noWritableDirError(): ArchiveCacheError {
  return new ArchiveCacheError(
    "NO_WRITABLE_DIR",
    "Server tidak punya direktori sementara yang bisa ditulis untuk memproses arsip — set AI_ARCHIVE_CACHE_DIR (self-host) atau gunakan hosting dgn /tmp writable."
  );
}

// ── LRU disk cache ───────────────────────────────────────────────────────

interface DiskEntry {
  path: string;
  size: number;
  at: number;
}

const diskCache = new Map<string, DiskEntry>(); // urutan insert = LRU
const inflightDisk = new Map<string, Promise<DiskFile>>();
let totalDiskBytes = 0;
let lastSweep = 0;

function fileNameFor(key: string): string {
  return `${createHash("sha1").update(key).digest("hex").slice(0, 24)}.arch`;
}

async function unlinkQuiet(p: string): Promise<void> {
  try {
    await fs.unlink(p);
  } catch {
    /* sudah terhapus / tak ada */
  }
}

function touchDisk(key: string, entry: DiskEntry): void {
  entry.at = Date.now();
  diskCache.delete(key);
  diskCache.set(key, entry);
}

async function evictDisk(): Promise<void> {
  while (
    (diskCache.size > MAX_DISK_ENTRIES || totalDiskBytes > MAX_DISK_TOTAL_BYTES) &&
    diskCache.size > 0
  ) {
    const oldest = diskCache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    const entry = diskCache.get(oldest);
    diskCache.delete(oldest);
    if (!entry) continue;
    totalDiskBytes -= entry.size;
    await unlinkQuiet(entry.path);
  }
}

/** Sapu berkas kadaluarsa (TTL) + yatim (>2 jam) — lazy, maks 1×/menit. */
async function sweep(): Promise<void> {
  const now = Date.now();
  if (now - lastSweep < 60_000) return;
  lastSweep = now;
  const dir = await resolveArchiveCacheDir();
  if (!dir) return;
  for (const [key, entry] of diskCache) {
    if (now - entry.at > DISK_TTL_MS) {
      diskCache.delete(key);
      totalDiskBytes -= entry.size;
      await unlinkQuiet(entry.path);
    }
  }
  try {
    const dirents = await fs.readdir(dir);
    const known = new Set(
      Array.from(diskCache.values()).map((e) => path.basename(e.path))
    );
    for (const name of dirents) {
      if (!name.endsWith(".arch") && !name.endsWith(".part")) continue;
      if (known.has(name)) continue;
      const p = path.join(dir, name);
      try {
        const st = await fs.stat(p);
        if (now - st.mtimeMs > ORPHAN_SWEEP_MS) await unlinkQuiet(p);
      } catch {
        /* berkas hilang di tengah — abaikan */
      }
    }
  } catch {
    /* readdir gagal — abaikan */
  }
}

/** Ukuran total file berkas (undefined bila berkasnya hilang). */
async function statFileSize(p: string): Promise<number | null> {
  try {
    const st = await fs.stat(p);
    return st.isFile() ? st.size : null;
  } catch {
    return null;
  }
}

/** Ruang kosong direktori (statfs); null bila tak terbaca. */
async function freeBytes(dir: string): Promise<number | null> {
  try {
    const st = await (fs as unknown as {
      statfs: (p: string) => Promise<{ bavail: number; bsize: number }>;
    }).statfs(dir);
    return st.bavail * st.bsize;
  } catch {
    return null;
  }
}

export interface DiskFile {
  path: string;
  size: number;
}

/**
 * Ambil berkas cache, atau produksi sekali (pemanggil bersamaan dengan key
 * sama berbagi SATU produksi). sizeHint dipakai untuk cek ruang kosong.
 */
export async function diskCacheGetOrProduce(
  key: string,
  sizeHint: number,
  produce: (dest: string) => Promise<void>
): Promise<DiskFile> {
  await sweep();
  const dir = await resolveArchiveCacheDir();
  if (!dir) throw noWritableDirError();

  const existing = diskCache.get(key);
  if (existing) {
    const size = await statFileSize(existing.path);
    if (size !== null) {
      touchDisk(key, existing);
      return { path: existing.path, size };
    }
    // Berkas hilang dari disk — buang dari cache & produksi ulang.
    diskCache.delete(key);
    totalDiskBytes -= existing.size;
  }

  const running = inflightDisk.get(key);
  if (running) return running;

  const p = (async (): Promise<DiskFile> => {
    // Cek ruang kosong SEBELUM produksi (margin + sizeHint).
    const free = await freeBytes(dir);
    if (free !== null && free < sizeHint + FREE_MARGIN_BYTES) {
      throw new ArchiveCacheError(
        "NO_SPACE",
        `Ruang penyimpanan sementara server tidak cukup (butuh ±${Math.round(
          (sizeHint + FREE_MARGIN_BYTES) / 1073741824
        )} GB, tersedia ${Math.round(free / 1073741824)} GB). Ekstrak di perangkat, atau tambah kapasitas / set AI_ARCHIVE_CACHE_DIR di self-host.`
      );
    }

    const finalPath = path.join(dir, fileNameFor(key));
    const partPath = `${finalPath}.${Date.now()}.part`;
    try {
      await produce(partPath);
      // Ukuran aktual hasil produksi (sizeHint bisa beda tipis).
      const realSize = await statFileSize(partPath);
      if (realSize === null) {
        throw new Error("PRODUCE_EMPTY");
      }
      await fs.rename(partPath, finalPath);
      const entry: DiskEntry = { path: finalPath, size: realSize, at: Date.now() };
      const prev = diskCache.get(key);
      if (prev) totalDiskBytes -= prev.size;
      diskCache.set(key, entry);
      totalDiskBytes += realSize;
      await evictDisk();
      return { path: finalPath, size: realSize };
    } catch (e) {
      await unlinkQuiet(partPath);
      throw e;
    } finally {
      inflightDisk.delete(key);
    }
  })();

  inflightDisk.set(key, p);
  return p;
}

// ── Sumber byte berkas (random-access) ───────────────────────────────────

/** ByteSource di atas berkas disk — readAt = pread, tanpa memuat utuh. */
export class FileByteSource {
  readonly size: number;
  private readonly fh: import("node:fs/promises").FileHandle;
  private closed = false;

  private constructor(fh: import("node:fs/promises").FileHandle, size: number) {
    this.fh = fh;
    this.size = size;
  }

  static async open(filePath: string): Promise<FileByteSource> {
    const fh = await fs.open(filePath, "r");
    const st = await fh.stat();
    return new FileByteSource(fh, st.size);
  }

  async readAt(offset: number, length: number): Promise<Buffer> {
    if (this.closed) {
      throw new Error("Sumber arsip sudah ditutup.");
    }
    if (offset < 0 || length < 0 || offset + length > this.size) {
      throw new ArchiveError(
        "ARCHIVE_CORRUPT",
        "Rentang baca melebihi ukuran arsip."
      );
    }
    if (length === 0) return Buffer.alloc(0);
    const buf = Buffer.allocUnsafe(length);
    const { bytesRead } = await this.fh.read(buf, 0, length, offset);
    if (bytesRead !== length) {
      throw new ArchiveError("ARCHIVE_CORRUPT", "Data arsip tidak lengkap.");
    }
    return buf;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.fh.close();
    } catch {
      /* fd sudah tertutup */
    }
  }
}

// ── Materialisasi entri besar + gunzip ber-cap ───────────────────────────

/**
 * Materialkan SATU entri arsip (hasil dekompresi) ke berkas disk cache —
 * untuk menyajikan rentang (Range) & unggah streaming tanpa buffer RAM.
 */
export async function materializeEntry(
  key: string,
  opened: OpenedArchive,
  entryPath: string
): Promise<DiskFile> {
  const { stream, size } = await makeEntryStream(opened, entryPath);
  return diskCacheGetOrProduce(key, size, async (dest) => {
    await pipeline(stream as Readable, createWriteStream(dest));
  });
}

/**
 * Gunzip berkas → berkas tujuan, STREAMING dengan cap total
 * (MAX_GUNZIP_BYTES) — bomb gzip dipotong sebelum disk penuh.
 * Mengembalikan ukuran hasil.
 */
export async function gunzipFileCapped(
  srcPath: string,
  destPath: string,
  cap = MAX_GUNZIP_BYTES
): Promise<number> {
  let total = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _enc: string, cb: (e?: Error | null, d?: Buffer) => void) {
      total += chunk.length;
      if (total > cap) {
        cb(
          new ArchiveError(
            "ARCHIVE_TOO_LARGE",
            `Isi arsip gzip melebihi batas dekompresi ${Math.round(
              cap / 1073741824
            )} GB — unduh lalu ekstrak di perangkat.`
          )
        );
        return;
      }
      cb(null, chunk);
    },
  });
  const src = createReadStream(srcPath);
  const gun = createGunzip();
  // Teruskan galat sumber/dekompresi ke counter (agar pipeline berhenti).
  src.on("error", (err) => counter.destroy(err));
  gun.on("error", (err) => counter.destroy(err));
  counter.on("error", () => {}); // pelindung unhandled; konsumen tetap dapat galat via pipeline
  try {
    await pipeline(src, gun, counter as unknown as Writable, createWriteStream(destPath));
  } catch (e) {
    await unlinkQuiet(destPath);
    if (e instanceof ArchiveError) throw e;
    throw new ArchiveError(
      "ARCHIVE_CORRUPT",
      `Arsip gzip rusak (${e instanceof Error ? e.message : String(e)}).`
    );
  }
  return total;
}

/** Statistik cache (diagnostik admin). */
export function archiveCacheStats(): {
  entries: number;
  totalBytes: number;
  dir: string | null;
} {
  return {
    entries: diskCache.size,
    totalBytes: totalDiskBytes,
    dir: cachedDir ?? null,
  };
}
