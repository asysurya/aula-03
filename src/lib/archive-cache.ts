// ─────────────────────────────────────────────────────────────────────────
// Cache DISK untuk arsip besar + sumber byte berkas (Task 34 → 35).
//
// Mengapa: membuka arsip 5 GB tidak boleh memuat arsip ke RAM. Arsip
// diunduh/dimaterialkan SEKALI ke berkas sementara di disk (LRU, TTL),
// lalu mesin arsip membacanya per-rentang (ByteSource).
//
// ZERO-CONFIG (Task 35): TIDAK PERLU set env apa pun. Direktori cache
// dipilih otomatis berurutan (setiap kandidat diuji tulis dulu, meniru
// tts-piper-paths.ts):
//   1. env AI_ARCHIVE_CACHE_DIR        — OPSIONAL, utk mematok lokasi
//   2. <aplikasi>/.aula-archive-cache  — self-host: aset bertahan
//   3. ~/.cache/aula-archive-cache     — (atau $XDG_CACHE_HOME) persisten
//   4. /var/tmp/aula-archive-cache     — bertahan reboot (Linux)
//   5. os.tmpdir()/aula-archive-cache  — fallback serverless (Vercel /tmp)
//
// Cache juga BERTAHAN HIDUP ANTAR-RESTART: tiap berkas cache disertai
// sidecar ".key" berisi kunci internal; saat proses baru menyala, berkas
// lama yang masih segar (TTL) DIADOPSI kembali ke LRU — buka ulang arsip
// setelah restart/deploy tidak mengunduh ulang.
//
// Guard:
//   · Cek ruang kosong (statfs) SEBELUM produksi — kekurangan ruang →
//     pesan ramah (kode NO_SPACE), bukan ENOSPC mentah.
//   · BUAT RUANG DULU, BARU TOLAK (Task 37): bila ruang kurang, entri
//     cache LAMA di-eviksi secukupnya (LRU, entri aktif dijamin selamat)
//     + .part basi (>10 mnt) disapu — instance hangat di /tmp serverless
//     ~1 GB jadi bisa berganti-ganti arsip besar tanpa env apa pun.
//   · Margin gerbang PROPORSIONAL UKURAN BERKAS (Task 37): sizeHint/64
//     dijepit 8 MB..256 MB. Margin lama (⅛ ruang bebas, min 16 MB)
//     terlalu gemuk di /tmp ~1 GB: arsip ~0,9 GB yang sebenarnya muat
//     ditolak padahal tertulis "butuh ±1 GB, tersedia 1 GB".
//   · Angka butuh/tersedia pada pesan galat ditampilkan JUJUR (MB /
//     GB 1 desimal) — bukan pembulatan GB yang menyamarkan selisih tipis.
//   · ENOSPC di tengah unduhan (disk dibagi request lain) → bersihkan
//     cache milik kita, cek ulang, COBA SEKALI lagi, baru tolak ramah.
//   · Kap LRU ADAPTIF: 6 berkas / maks 8 GB, tapi menyusut otomatis
//     mengikuti ruang disk yang benar-benar tersisa (maks ±¼ ruang bebas,
//     minimal 64 MB) → di /tmp kecil (serverless) cache tak pernah memenuhi
//     disk.
//   · TTL 6 jam; berkas yatim (tanpa pemilik di memori, >2 jam, pola nama
//     cache) disapu lazily.
//   · KHUSUS TEST (jangan diset di produksi): AI_ARCHIVE_TEST_FREE_FILE
//     berisi kapasitas disk virtual (byte); ruang bebas = kapasitas −
//     ukuran berkas nyata di direktori cache — meniru disk sempit tanpa
//     root/tmpfs (sandbox E2E).
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
const MAX_DISK_TOTAL_BYTES = 8 * 1024 * 1024 * 1024; // 8 GB (kap atas)
/** Kap total menyesuaikan ruang bebas: maks ¼ ruang, minimal 64 MB. */
const MIN_DISK_TOTAL_BYTES = 64 * 1024 * 1024;
/** Di atas ruang sekasar ini kap atas tetap dipakai (¼-nya sudah > 8 GB). */
const HUGE_FREE_BYTES = 32 * 1024 * 1024 * 1024;
const DISK_TTL_MS = 6 * 60 * 60 * 1000; // 6 jam (bertahan sehari sekolah)
const ORPHAN_SWEEP_MS = 2 * 60 * 60 * 1000; // 2 jam
/** Margin ruang bebas saat produksi: PROPORSIONAL UKURAN BERKAS (Task 37). */
const FREE_MARGIN_BYTES = 256 * 1024 * 1024;
const MIN_FREE_MARGIN_BYTES = 8 * 1024 * 1024;
/** .part yang lebih tua dari ini disapu saat butuh ruang (produksi mati). */
const STALE_PART_MS = 10 * 60 * 1000;
/** Panjang maks kunci internal yang disimpan di sidecar (anti abuse). */
const MAX_KEY_LENGTH = 4096;
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

// ── Direktori cache writable (env → app → home → /var/tmp → tmp) ─────────

export type ArchiveCacheDirSource =
  | "env"
  | "app"
  | "home"
  | "vartmp"
  | "tmp";

export interface CacheDirCandidate {
  dir: string;
  source: ArchiveCacheDirSource;
}

/**
 * Bangun daftar kandidat direktori cache (murni — mudah diuji unit).
 * Urutan: env (opsional) → sebelah aplikasi → cache pengguna (XDG/HOME)
 * → /var/tmp → tmpdir sistem.
 */
export function buildCacheDirCandidates(
  envDir: string | null | undefined,
  ctx: {
    cwd: string;
    xdgCacheHome?: string | null;
    home?: string | null;
    tmpdir: string;
    varTmp?: string;
  }
): CacheDirCandidate[] {
  const out: CacheDirCandidate[] = [];
  const seen = new Set<string>();
  const push = (dir: string, source: ArchiveCacheDirSource) => {
    const resolved = path.resolve(dir);
    if (seen.has(resolved)) return;
    seen.add(resolved);
    out.push({ dir: resolved, source });
  };
  if (envDir && envDir.trim()) push(envDir.trim(), "env");
  push(path.join(ctx.cwd, ".aula-archive-cache"), "app");
  const userCache =
    ctx.xdgCacheHome && ctx.xdgCacheHome.trim()
      ? path.join(ctx.xdgCacheHome.trim(), "aula-archive-cache")
      : ctx.home && ctx.home.trim()
        ? path.join(ctx.home, ".cache", "aula-archive-cache")
        : null;
  if (userCache) push(userCache, "home");
  push(path.join(ctx.varTmp ?? "/var/tmp", "aula-archive-cache"), "vartmp");
  push(path.join(ctx.tmpdir, "aula-archive-cache"), "tmp");
  return out;
}

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

interface ResolvedCacheDir {
  dir: string;
  source: ArchiveCacheDirSource;
}

let cachedInfo: ResolvedCacheDir | null | undefined;

/** Probe kandidat satu per satu sampai menemukan yang bisa ditulis. */
export async function resolveArchiveCacheDirFrom(
  candidates: CacheDirCandidate[]
): Promise<ResolvedCacheDir | null> {
  for (const c of candidates) {
    if (await probeWritable(c.dir)) return { dir: c.dir, source: c.source };
  }
  return null;
}

function currentCandidates(): CacheDirCandidate[] {
  return buildCacheDirCandidates(process.env.AI_ARCHIVE_CACHE_DIR, {
    cwd: process.cwd(),
    xdgCacheHome: process.env.XDG_CACHE_HOME || null,
    home: os.homedir() || null,
    tmpdir: os.tmpdir(),
  });
}

/**
 * Direktori cache arsip yang bisa ditulis (diuji tulis) + asalnya.
 * null bila semua kandidat gagal. Memoized per proses.
 */
export async function resolveArchiveCacheDirInfo(): Promise<
  ResolvedCacheDir | null
> {
  if (cachedInfo !== undefined) return cachedInfo;
  cachedInfo = await resolveArchiveCacheDirFrom(currentCandidates());
  return cachedInfo;
}

/** Wrapper kompatibilitas: hanya jalur direktorinya. */
export async function resolveArchiveCacheDir(): Promise<string | null> {
  const info = await resolveArchiveCacheDirInfo();
  return info ? info.dir : null;
}

function noWritableDirError(): ArchiveCacheError {
  return new ArchiveCacheError(
    "NO_WRITABLE_DIR",
    "Server tidak menemukan lokasi penyimpanan sementara yang bisa ditulis untuk memproses arsip besar. " +
      "Cache arsip seharusnya bekerja otomatis tanpa setelan (folder aplikasi → folder cache pengguna → /var/tmp → /tmp) — " +
      "bila pesan ini muncul, semua lokasi tersebut diblokir oleh hosting. " +
      "Solusi: unduh arsip lalu ekstrak di perangkat, atau (self-host) set AI_ARCHIVE_CACHE_DIR ke disk yang bisa ditulis."
  );
}

// ── Kap & margin adaptif (murni — mudah diuji unit) ──────────────────────

/** Kap total cache mengikuti ruang bebas: maks ¼ ruang, dijepit 64 MB–8 GB. */
export function effectiveTotalCapBytes(free: number | null): number {
  if (free === null || free >= HUGE_FREE_BYTES) return MAX_DISK_TOTAL_BYTES;
  const quarter = Math.floor(free / 4);
  return Math.max(
    MIN_DISK_TOTAL_BYTES,
    Math.min(MAX_DISK_TOTAL_BYTES, quarter)
  );
}

/**
 * Margin aman sebelum produksi — PROPORSIONAL UKURAN BERKAS (Task 37):
 * sizeHint/64 dijepit 8 MB..256 MB. Margin lama (⅛ ruang bebas, min 16 MB)
 * terlalu gemuk di /tmp serverless ~1 GB: arsip ~0,9 GB yang sebenarnya
 * muat ditolak padahal "butuh ±1 GB, tersedia 1 GB" (laporan user).
 */
export function freeMarginBytes(sizeHint: number): number {
  if (!Number.isFinite(sizeHint) || sizeHint <= 0) {
    return MIN_FREE_MARGIN_BYTES;
  }
  return Math.max(
    MIN_FREE_MARGIN_BYTES,
    Math.min(FREE_MARGIN_BYTES, Math.floor(sizeHint / 64))
  );
}

/** Angka jujur untuk pesan galat: MB di bawah 1 GB, GB 1 desimal < 10 GB. */
export function fmtApproxBytes(bytes: number): string {
  const MB = 1048576;
  const GB = 1073741824;
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 MB";
  if (bytes >= 10 * GB) return `${Math.round(bytes / GB)} GB`;
  if (bytes >= GB) return `${(bytes / GB).toFixed(1)} GB`;
  return `${Math.max(1, Math.round(bytes / MB))} MB`;
}

/** Galat I/O kehabisan ruang (ENOSPC/EDQUOT) dari stream/fs Node. */
export function isNoSpaceIoError(e: unknown): boolean {
  return (
    !!e &&
    typeof e === "object" &&
    "code" in e &&
    ((e as { code?: unknown }).code === "ENOSPC" ||
      (e as { code?: unknown }).code === "EDQUOT")
  );
}

// ── Rencana "buat ruang" (murni — mudah diuji unit) ──────────────────────

export interface RoomEntry {
  key: string;
  size: number;
  at: number; // terakhir dipakai — LRU
}

export interface RoomPlan {
  ok: boolean;
  need: number;
  margin: number;
  evictKeys: string[];
  reclaimed: number;
}

/**
 * Rencana eviksi agar produksi sizeHint muat (Task 37): bila
 * free < sizeHint + margin, entri LRU TERTUA di-eviksi SECUKUPNYA
 * (berhenti begitu muat), tanpa menyentuh entri aktif (protectKey).
 * Bila semua entri evictable pun tidak menutup defisit → ok=false dan
 * TIDAK ada yang di-eviksi (permintaan pasti gagal — cache lama tetap
 * hangat untuk arsip lain yang lebih kecil).
 */
export function planRoomFor(
  free: number,
  sizeHint: number,
  entries: RoomEntry[],
  protectKey?: string
): RoomPlan {
  const margin = freeMarginBytes(sizeHint);
  const need = sizeHint + margin;
  if (free >= need) {
    return { ok: true, need, margin, evictKeys: [], reclaimed: 0 };
  }
  const evictable = entries
    .filter((e) => e.key !== protectKey)
    .sort((a, b) => a.at - b.at); // tertua duluan
  const evictKeys: string[] = [];
  let reclaimed = 0;
  for (const e of evictable) {
    if (free + reclaimed >= need) break;
    evictKeys.push(e.key);
    reclaimed += e.size;
  }
  const ok = free + reclaimed >= need;
  if (!ok) return { ok: false, need, margin, evictKeys: [], reclaimed: 0 };
  return { ok, need, margin, evictKeys, reclaimed };
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
let adoptPromise: Promise<void> | null = null;

function fileNameFor(key: string): string {
  return `${createHash("sha1").update(key).digest("hex").slice(0, 24)}.arch`;
}

function keySidecarPath(archPath: string): string {
  return `${archPath}.key`;
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

/**
 * Eviksi LRU → batas entri + kap byte adaptif. Entri yang sedang AKTIF
 * (protectKey — baru diproduksi, berkasnya tengah dilayani pemanggil)
 * TIDAK PERNAH dihapus di sini: menghapusnya membuat pemanggil ENOENT
 * (pelajaran run-1 t35: kap ¼-ruang-bebas bisa lebih kecil dari satu
 * arsip besar yang lolos gerbang ruang — berkasnya harus tetap hidup
 * selama dipakai; ia jadi kandidat eviksi pada putaran berikutnya).
 */
async function evictDisk(protectKey?: string): Promise<void> {
  const info = cachedInfo ?? (await resolveArchiveCacheDirInfo());
  const free = info ? await freeBytes(info.dir) : null;
  const cap = effectiveTotalCapBytes(free);
  for (const k of Array.from(diskCache.keys())) {
    if (diskCache.size <= MAX_DISK_ENTRIES && totalDiskBytes <= cap) break;
    if (k === protectKey) continue; // entri aktif — jangan dihapus
    const entry = diskCache.get(k);
    if (!entry) continue;
    diskCache.delete(k);
    totalDiskBytes -= entry.size;
    await unlinkQuiet(entry.path);
    await unlinkQuiet(keySidecarPath(entry.path));
  }
}

/** Buang SATU entri dari LRU + berkas & sidecar-nya di disk. */
async function dropEntry(key: string): Promise<void> {
  const entry = diskCache.get(key);
  if (!entry) return;
  diskCache.delete(key);
  totalDiskBytes -= entry.size;
  await unlinkQuiet(entry.path);
  await unlinkQuiet(keySidecarPath(entry.path));
}

/** Hapus .part basi (produksi yang mati > 10 mnt) dari direktori cache. */
async function removeStaleParts(dir: string): Promise<void> {
  const now = Date.now();
  let dirents: string[];
  try {
    dirents = await fs.readdir(dir);
  } catch {
    return;
  }
  for (const name of dirents) {
    if (!name.endsWith(".part")) continue;
    const p = path.join(dir, name);
    try {
      const st = await fs.stat(p);
      if (now - st.mtimeMs > STALE_PART_MS) await unlinkQuiet(p);
    } catch {
      /* hilang di tengah — abaikan */
    }
  }
}

/**
 * BUAT RUANG sebelum menolak (Task 37): sapu .part basi + eviksi entri
 * LRU SECUKUPNYA agar sizeHint muat. Entri aktif (protectKey) tidak
 * pernah disinggung. Pemanggil wajib mengecek ulang ruang setelah ini
 * (eviksi sungguhan menaikkan ruang bebas; di mode test-virtual angkanya
 * ikut bergerak karena dihitung dari isi direktori).
 */
async function makeRoom(protectKey: string, sizeHint: number): Promise<void> {
  const info = cachedInfo ?? (await resolveArchiveCacheDirInfo());
  if (!info) return;
  await removeStaleParts(info.dir);
  const free = await freeBytes(info.dir);
  if (free === null) return;
  const plan = planRoomFor(
    free,
    sizeHint,
    Array.from(diskCache.entries()).map(([key, e]) => ({
      key,
      size: e.size,
      at: e.at,
    })),
    protectKey
  );
  for (const k of plan.evictKeys) await dropEntry(k);
}

/** Sapu berkas kadaluarsa (TTL) + yatim (>2 jam) — lazy, maks 1×/menit. */
async function sweep(): Promise<void> {
  const now = Date.now();
  if (now - lastSweep < 60_000) return;
  lastSweep = now;
  const info = cachedInfo ?? (await resolveArchiveCacheDirInfo());
  if (!info) return;
  for (const [key, entry] of diskCache) {
    if (now - entry.at > DISK_TTL_MS) {
      diskCache.delete(key);
      totalDiskBytes -= entry.size;
      await unlinkQuiet(entry.path);
      await unlinkQuiet(keySidecarPath(entry.path));
    }
  }
  try {
    const dirents = await fs.readdir(info.dir);
    // Nama berkas cache yang masih dipegang di memori (+ sidecar-nya)
    // supaya sidecar entri hidup tidak disapu sebagai "yatim".
    const known = new Set<string>();
    for (const e of diskCache.values()) {
      known.add(path.basename(e.path));
      known.add(path.basename(keySidecarPath(e.path)));
    }
    for (const name of dirents) {
      const isArch = name.endsWith(".arch");
      const isPart = name.endsWith(".part");
      const isKey = name.endsWith(".arch.key");
      if (!isArch && !isPart && !isKey) continue;
      if (known.has(name)) continue;
      const p = path.join(info.dir, name);
      try {
        const st = await fs.stat(p);
        if (now - st.mtimeMs > ORPHAN_SWEEP_MS) {
          await unlinkQuiet(p);
          if (isArch) await unlinkQuiet(keySidecarPath(p));
        }
      } catch {
        /* berkas hilang di tengah — abaikan */
      }
    }
  } catch {
    /* readdir gagal — abaikan */
  }
}

// ── Adopsi berkas cache lama (bertahan antar-restart) ────────────────────

/**
 * Pindai direktori cache dan adopsi kembali berkas lama yang masih segar
 * ke LRU di memori — proses baru tidak mengunduh ulang arsip yang sudah
 * dicache proses sebelumnya (zero-config: tidak perlu env apa pun).
 */
async function adoptExistingFiles(dir: string): Promise<void> {
  let dirents: string[];
  try {
    dirents = await fs.readdir(dir);
  } catch {
    return;
  }
  for (const name of dirents) {
    if (!name.endsWith(".arch")) continue;
    const archPath = path.join(dir, name);
    try {
      const keyRaw = await fs.readFile(keySidecarPath(archPath), "utf8");
      const key = keyRaw.trim();
      if (!key || key.length > MAX_KEY_LENGTH || diskCache.has(key)) continue;
      const st = await fs.stat(archPath);
      if (!st.isFile()) continue;
      if (Date.now() - st.mtimeMs > DISK_TTL_MS) {
        // Kedaluwarsa sejak proses lama — buang bersama sidecar-nya.
        await unlinkQuiet(archPath);
        await unlinkQuiet(keySidecarPath(archPath));
        continue;
      }
      diskCache.set(key, { path: archPath, size: st.size, at: st.mtimeMs });
      totalDiskBytes += st.size;
    } catch {
      /* sidecar hilang / rusak → biarkan orphan sweep menangani */
    }
  }
  // Adopsi TIDAK menegakkan kap byte (berkas sudah ada di disk — tidak
  // menulis apa pun; gerbang ruang saat produksi berikutnya yang menjaga).
  // Hanya jumlah entri yang dijepit supaya LRU di memori tetap ramping.
  while (diskCache.size > MAX_DISK_ENTRIES) {
    const oldest = diskCache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    const entry = diskCache.get(oldest);
    diskCache.delete(oldest);
    if (!entry) continue;
    totalDiskBytes -= entry.size;
    await unlinkQuiet(entry.path);
    await unlinkQuiet(keySidecarPath(entry.path));
  }
}

async function ensureAdopted(): Promise<void> {
  if (adoptPromise) return adoptPromise;
  adoptPromise = (async () => {
    const info = await resolveArchiveCacheDirInfo();
    if (info) await adoptExistingFiles(info.dir);
  })();
  return adoptPromise;
}

// ── Ukuran & ruang disk ──────────────────────────────────────────────────

/** Ukuran total file berkas (undefined bila berkasnya hilang). */
async function statFileSize(p: string): Promise<number | null> {
  try {
    const st = await fs.stat(p);
    return st.isFile() ? st.size : null;
  } catch {
    return null;
  }
}

/**
 * Ruang kosong direktori (statfs); null bila tak terbaca.
 * KHUSUS TEST E2E (sandbox tak punya root utk tmpfs/loopback — disk
 * sempit tak bisa dibuat sungguhan): bila AI_ARCHIVE_TEST_FREE_FILE
 * diset, isinya dibaca sebagai KAPASITAS disk virtual (byte) dan ruang
 * bebas = kapasitas − total ukuran berkas nyata di direktori cache —
 * meniru disk sungguhan (produksi menurunkan, eviksi menaikkan).
 * JANGAN diset di produksi.
 */
async function freeBytes(dir: string): Promise<number | null> {
  const testFile = process.env.AI_ARCHIVE_TEST_FREE_FILE;
  if (testFile) {
    try {
      const cap = parseInt((await fs.readFile(testFile, "utf8")).trim(), 10);
      if (Number.isFinite(cap) && cap >= 0) {
        let used = 0;
        try {
          for (const name of await fs.readdir(dir)) {
            try {
              const st = await fs.stat(path.join(dir, name));
              if (st.isFile()) used += st.size;
            } catch {
              /* berkas hilang di tengah — abaikan */
            }
          }
        } catch {
          /* readdir gagal — anggap kosong */
        }
        return Math.max(0, cap - used);
      }
    } catch {
      /* angka tak terbaca → statfs sungguhan */
    }
  }
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

/** Pesan galat ruang: angka JUJUR + arahan (Task 37). */
function noSpaceError(
  need: number,
  free: number,
  midDownload: boolean
): ArchiveCacheError {
  return new ArchiveCacheError(
    "NO_SPACE",
    (midDownload
      ? "Ruang penyimpanan sementara server HABIS di tengah proses berkas ini "
      : "Ruang penyimpanan sementara server tidak cukup untuk membuka berkas sebesar ini ") +
      `(butuh ±${fmtApproxBytes(need)}, tersedia ${fmtApproxBytes(free)}). ` +
      "Cache arsip bekerja otomatis dan menyesuaikan diri dengan ruang yang tersedia — " +
      "berkas cache lama sudah dibersihkan lebih dulu agar muat. " +
      "Berkas yang lebih besar dari ruang server sebaiknya diunduh lalu diekstrak di perangkat, " +
      "atau (self-host) arahkan AI_ARCHIVE_CACHE_DIR ke disk yang lebih besar."
  );
}

/**
 * Ambil berkas cache, atau produksi sekali (pemanggil bersamaan dengan key
 * sama berbagi SATU produksi). sizeHint dipakai untuk cek ruang kosong.
 * Berhasil dipakai tanpa set env apa pun — direktori dipilih otomatis.
 */
export async function diskCacheGetOrProduce(
  key: string,
  sizeHint: number,
  produce: (dest: string) => Promise<void>
): Promise<DiskFile> {
  await ensureAdopted();
  await sweep();
  const info = cachedInfo ?? (await resolveArchiveCacheDirInfo());
  if (!info) throw noWritableDirError();

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
    await unlinkQuiet(keySidecarPath(existing.path));
  }

  const running = inflightDisk.get(key);
  if (running) return running;

  const p = (async (): Promise<DiskFile> => {
    try {
    // ── Gerbang ruang (Task 37): cek → bila kurang, BUAT RUANG dulu
    // (eviksi LRU secukupnya + sapu .part basi) → cek ulang → baru tolak
    // dgn angka jujur. Margin proporsional ukuran berkas (8 MB..256 MB)
    // — /tmp serverless ~1 GB kini memuat arsip hingga ±ruang−8 MB.
    const margin = freeMarginBytes(sizeHint);
    let free = await freeBytes(info.dir);
    if (free !== null && free < sizeHint + margin) {
      await makeRoom(key, sizeHint);
      free = await freeBytes(info.dir);
    }
    if (free !== null && free < sizeHint + margin) {
      throw noSpaceError(sizeHint + margin, free, false);
    }

    const finalPath = path.join(info.dir, fileNameFor(key));
    const attempt = async (): Promise<{ partPath: string; size: number }> => {
      const partPath = `${finalPath}.${Date.now()}.part`;
      try {
        await produce(partPath);
        // Ukuran aktual hasil produksi (sizeHint bisa beda tipis).
        const realSize = await statFileSize(partPath);
        if (realSize === null) {
          throw new Error("PRODUCE_EMPTY");
        }
        return { partPath, size: realSize };
      } catch (e) {
        await unlinkQuiet(partPath);
        throw e;
      }
    };

    let res: { partPath: string; size: number };
    try {
      res = await attempt();
    } catch (e) {
      if (!isNoSpaceIoError(e)) throw e;
      // Disk penuh DI TENGAH unduhan (mis. /tmp serverless dipakai bareng
      // request lain di instance hangat) → kosongkan cache milik kita,
      // cek ulang ruang, lalu COBA SEKALI lagi (unduhan diulang).
      await makeRoom(key, sizeHint);
      const free2 = await freeBytes(info.dir);
      if (free2 !== null && free2 < sizeHint + margin) {
        throw noSpaceError(sizeHint + margin, free2, true);
      }
      try {
        res = await attempt();
      } catch (e2) {
        if (isNoSpaceIoError(e2)) {
          throw noSpaceError(sizeHint + margin, free2 ?? 0, true);
        }
        throw e2;
      }
    }

    await fs.rename(res.partPath, finalPath);
    // Sidecar kunci: supaya proses berikutnya (restart/deploy) bisa
    // mengadopsi berkas ini tanpa mengunduh ulang.
    try {
      await fs.writeFile(keySidecarPath(finalPath), key);
    } catch {
      /* sidecar opsional — adopsi lintas-restart saja yang melemah */
    }
    const entry: DiskEntry = { path: finalPath, size: res.size, at: Date.now() };
    const prev = diskCache.get(key);
    if (prev) totalDiskBytes -= prev.size;
    diskCache.set(key, entry);
    totalDiskBytes += res.size;
    // Lindungi entri BARU ini dari eviksi (berkas tengah dilayani).
    await evictDisk(key);
    return { path: finalPath, size: res.size };
    } finally {
      // Wajib: bersihkan inflight apa pun hasilnya — promise gagal yang
      // tertinggal akan meracuni permintaan berikutnya utk key sama.
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
  dirSource: ArchiveCacheDirSource | null;
} {
  return {
    entries: diskCache.size,
    totalBytes: totalDiskBytes,
    dir: cachedInfo ? cachedInfo.dir : null,
    dirSource: cachedInfo ? cachedInfo.source : null,
  };
}

/** Khusus unit-test: reset seluruh state cache (mensimulasikan restart). */
export function __resetArchiveCacheForTest(): void {
  cachedInfo = undefined;
  diskCache.clear();
  inflightDisk.clear();
  totalDiskBytes = 0;
  lastSweep = 0;
  adoptPromise = null;
}
