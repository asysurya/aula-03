// ─────────────────────────────────────────────────────────────────────────
// Cache file Aula Reader / pratinjau — SIKLUS HIDUP SEMENTARA:
//
// File yang dibuka di Aula Reader / pratinjau diunduh ke cache browser
// (memori sesi + Cache Storage) supaya membuka ulang instan SELAGI
// pratinjau terbuka. Begitu:
//   - pratinjau DITUTUP            → buffer file DIHAPUS otomatis
//   - tab / window DITUTUP         → memori mati sendiri; sisa di Cache
//                                    Storage dibersihkan saat aplikasi
//                                    dibuka lagi (sweep) + best-effort
//                                    saat pagehide.
// Anotasi (stabilo, draw, dll) TIDAK ikut terhapus — disimpan terpisah di
// MongoDB (lihat useRemoteAnnotations / /api/reader/doc).
// ─────────────────────────────────────────────────────────────────────────

const READER_CACHE = "aula-reader-v1";

interface MemEntry {
  buffer: ArrayBuffer;
  objectUrl: string;
}

/** Memori sesi (tab ini) — mati otomatis saat tab ditutup. */
const memCache = new Map<string, MemEntry>();

/** URL proxy (same-origin) sebagai kunci Cache Storage. */
function cacheKey(storageKey: string): string {
  return `/api/storage/${storageKey}`;
}

/** Sedang dipakai (pratinjau terbuka) — jangan di-sweep. */
const activeKeys = new Set<string>();

function cacheApi(): CacheStorage | null {
  try {
    if (typeof caches !== "undefined") return caches;
  } catch {
    /* Sw/environment tanpa Cache Storage */
  }
  return null;
}

/** Ambil buffer file dari memori → Cache Storage. Null bila belum ada. */
export async function peekReaderBuffer(
  storageKey: string
): Promise<MemEntry | null> {
  const mem = memCache.get(storageKey);
  if (mem) return mem;
  const api = cacheApi();
  if (!api) return null;
  try {
    const cache = await api.open(READER_CACHE);
    const res = await cache.match(cacheKey(storageKey));
    if (!res || !res.ok) return null;
    const buffer = await res.arrayBuffer();
    if (buffer.byteLength === 0) return null;
    const entry: MemEntry = {
      buffer,
      objectUrl: URL.createObjectURL(new Blob([buffer])),
    };
    memCache.set(storageKey, entry);
    return entry;
  } catch {
    return null;
  }
}

/** Simpan buffer file ke memori + Cache Storage. */
export async function putReaderBuffer(
  storageKey: string,
  buffer: ArrayBuffer
): Promise<MemEntry> {
  activeKeys.add(storageKey);
  const entry: MemEntry = {
    buffer,
    objectUrl: URL.createObjectURL(new Blob([buffer])),
  };
  memCache.set(storageKey, entry);
  const api = cacheApi();
  if (api && buffer.byteLength <= 256 * 1024 * 1024) {
    try {
      const cache = await api.open(READER_CACHE);
      await cache.put(
        cacheKey(storageKey),
        new Response(buffer, {
          headers: { "Content-Type": "application/octet-stream" },
        })
      );
    } catch {
      /* cache penuh / private mode — memori masih berlaku */
    }
  }
  return entry;
}

/**
 * Hapus SATU file dari cache (dipanggil saat pratinjau/reader ditutup).
 * Buffer memori di-revoke objectURL-nya lalu dibuang; Cache Storage ikut
 * dibersihkan. Anotasi TIDAK tersentuh (ada di MongoDB).
 */
export async function evictReaderFile(storageKey: string): Promise<void> {
  activeKeys.delete(storageKey);
  const mem = memCache.get(storageKey);
  if (mem) {
    try {
      URL.revokeObjectURL(mem.objectUrl);
    } catch {
      /* abaikan */
    }
    memCache.delete(storageKey);
  }
  const api = cacheApi();
  if (!api) return;
  try {
    const cache = await api.open(READER_CACHE);
    await cache.delete(cacheKey(storageKey));
  } catch {
    /* abaikan */
  }
}

/**
 * Bersihkan SEMUA sisa cache reader (dipanggil saat aplikasi dibuka —
 * menangani tab yang tertutup paksa/crash — dan best-effort pagehide).
 * Entri yang pratinjaunya sedang terbuka di tab INI tetap dipertahankan.
 */
export async function sweepReaderCache(): Promise<void> {
  const api = cacheApi();
  if (api) {
    try {
      const names = await api.keys();
      for (const name of names) {
        if (name !== READER_CACHE) continue;
        const cache = await api.open(name);
        const keys = await cache.keys();
        for (const req of keys) {
          // Bentuk kunci: /api/storage/<storageKey>
          const sk = decodeURIComponent(
            req.url.replace(/^.*\/api\/storage\//, "").split(/[?#]/)[0]
          );
          if (sk && !activeKeys.has(sk)) {
            await cache.delete(req).catch(() => {});
          }
        }
      }
    } catch {
      /* abaikan */
    }
  }
  // Buang entri memori yang pratinjaunya sudah tidak aktif (mis. dialog
  // ditutup tanpa evict karena error).
  for (const key of Array.from(memCache.keys())) {
    if (!activeKeys.has(key)) {
      const mem = memCache.get(key);
      if (mem) {
        try {
          URL.revokeObjectURL(mem.objectUrl);
        } catch {
          /* abaikan */
        }
      }
      memCache.delete(key);
    }
  }
}

/**
 * Daftarkan bahwa file ini sedang dipakai (mencegah sweep membuangnya saat
 * pratinjau masih terbuka). Dipanggil begitu buffer diambil/dibuat.
 */
export function markReaderActive(storageKey: string) {
  activeKeys.add(storageKey);
}
