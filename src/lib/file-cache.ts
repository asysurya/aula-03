// ─────────────────────────────────────────────────────────────────────────
// LRU cache blob file di memori proses server (anti-lag preview).
//
// Tanpa ini, SETIAP buka preview = download ulang penuh dari MEGA/S3.
// Dengan cache: unduhan pertama di-cache, pembukaan berikutnya instan
// (dev server lama / lambda Vercel warm). File di atas MAX_ENTRY_BYTES
// (video besar) dilewati supaya memori tidak meledak.
// ─────────────────────────────────────────────────────────────────────────

const MAX_TOTAL_BYTES = 192 * 1024 * 1024; // 192 MB total
const MAX_ENTRY_BYTES = 64 * 1024 * 1024; // per-file 64 MB

interface Entry {
  bytes: Buffer;
  at: number; // last-access timestamp (untuk LRU)
}

const cache = new Map<string, Entry>();
/** Promise load yang sedang berjalan, per key — pemanggil bersamaan
 *  dengan key sama BERBAGI satu load (anti thundering herd, mis. 4 request
 *  Range paralel ke /api/storage/[key] tidak memicu 4x download dari S3). */
const inflight = new Map<string, Promise<Buffer | null>>();
let totalBytes = 0;

function touch(key: string, entry: Entry): void {
  entry.at = Date.now();
  // Map menempatkan ulang key di akhir → iterasi = urutan LRU.
  cache.delete(key);
  cache.set(key, entry);
}

function evict(): void {
  while (totalBytes > MAX_TOTAL_BYTES && cache.size > 1) {
    // Entri pertama di Map = yang paling lama tidak diakses (LRU).
    const oldest = cache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    const entry = cache.get(oldest);
    cache.delete(oldest);
    if (entry) totalBytes -= entry.bytes.length;
  }
}

export function fileCacheGet(key: string): Buffer | null {
  const entry = cache.get(key);
  if (!entry) return null;
  touch(key, entry);
  return entry.bytes;
}

export function fileCacheSet(key: string, bytes: Buffer): void {
  if (bytes.length > MAX_ENTRY_BYTES) return; // file besar: lewati cache
  const existing = cache.get(key);
  if (existing) {
    totalBytes -= existing.bytes.length;
    cache.delete(key);
  }
  cache.set(key, { bytes, at: Date.now() });
  totalBytes += bytes.length;
  evict();
}

export function fileCacheDelete(key: string): void {
  const entry = cache.get(key);
  if (!entry) return;
  totalBytes -= entry.bytes.length;
  cache.delete(key);
}

/**
 * Ambil dari cache, atau muat sekali untuk SEMUA pemanggil bersamaan.
 *
 * Pemanggil paralel dengan key sama berbagi SATU promise load in-flight
 * (mis. 4 request Range paralel ke file yang sama → hanya 1x download dari
 * MEGA/S3). Setelah sukses, hasil masuk cache LRU. Setelah gagal, promise
 * dibuang dari registry sehingga percobaan berikutnya benar-benar mengulang
 * load-nya (retry-friendly).
 */
export function fileCacheGetOrLoad(
  key: string,
  loader: () => Promise<Buffer | null>
): Promise<Buffer | null> {
  const cached = fileCacheGet(key);
  if (cached) return Promise.resolve(cached);

  const existing = inflight.get(key);
  if (existing) return existing;

  const p = (async () => {
    try {
      const data = await loader();
      if (data) fileCacheSet(key, data);
      return data;
    } finally {
      inflight.delete(key);
    }
  })();
  // Pita pengaman anti unhandled-rejection bila suatu pemanggil tidak
  // meng-await hasilnya — pemanggil yang await tetap menerima rejection.
  p.catch(() => {});
  inflight.set(key, p);
  return p;
}

export function fileCacheStats(): { entries: number; totalBytes: number } {
  return { entries: cache.size, totalBytes };
}
