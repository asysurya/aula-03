// ─────────────────────────────────────────────────────────────────────────
// Cache file Aula Reader / pratinjau — SIKLUS HIDUP SEMENTARA + SIMPAN:
//
// File yang dibuka di Aula Reader / pratinjau diunduh ke cache browser
// (memori sesi + Cache Storage) supaya membuka ulang instan SELAGI
// pratinjau terbuka. Begitu pratinjau DITUTUP, user ditanya:
//   - "Simpan"  → file masuk daftar KEEP (localStorage) → tetap ada di
//                 perangkat & dibuang hanya bila user hapus / cache penuh
//                 → membuka lagi instan tanpa unduh ulang.
//   - "Hapus"   → buffer file dihapus otomatis (perilaku lama).
// Tab / window ditutup → memori mati sendiri; sisa di Cache Storage
// dibersihkan saat aplikasi dibuka lagi (sweep) + best-effort pagehide —
// sweep TIDAK menyentuh file yang di-KEEP.
// Anotasi (stabilo, draw, dll) TIDAK ikut terhapus — disimpan terpisah di
// MongoDB (lihat useRemoteAnnotations / /api/reader/doc).
// ─────────────────────────────────────────────────────────────────────────

const READER_CACHE = "aula-reader-v1";
/** localStorage: daftar storageKey yang user pilih "Simpan" saat menutup. */
const KEEP_KEY = "aula-reader-keep";
/** Maks file yang boleh di-keep (mencegah localStorage & cache menumpuk). */
const MAX_KEPT = 50;

interface MemEntry {
  buffer: ArrayBuffer;
  objectUrl: string;
}

function loadKeptSet(): Set<string> {
  try {
    const raw = localStorage.getItem(KEEP_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr.filter((x) => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

function saveKeptSet(s: Set<string>) {
  try {
    // Bila melebihi batas: buang yang TERLAMA (urutan insert di akhir array).
    const arr = Array.from(s);
    localStorage.setItem(KEEP_KEY, JSON.stringify(arr.slice(-MAX_KEPT)));
  } catch {
    /* private mode / penuh — abaikan */
  }
}

/** Apakah file ini dipilih user untuk disimpan (tetap setelah ditutup)? */
export function isKeptReaderFile(storageKey: string): boolean {
  return loadKeptSet().has(storageKey);
}

/** Tandai file agar TETAP di perangkat setelah pratinjau ditutup. */
export function keepReaderFile(storageKey: string) {
  const s = loadKeptSet();
  s.add(storageKey);
  saveKeptSet(s);
}

/** Batalkan "simpan" — file kembali dihapus otomatis saat pratinjau ditutup. */
export function unkeepReaderFile(storageKey: string) {
  const s = loadKeptSet();
  s.delete(storageKey);
  saveKeptSet(s);
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

/** Apakah buffer file ini ADA di cache (memori / Cache Storage)?
 *  Dipakai untuk memutuskan: perlu tanya "simpan atau hapus?" saat tutup. */
export async function hasReaderCacheEntry(storageKey: string): Promise<boolean> {
  if (memCache.has(storageKey)) return true;
  const api = cacheApi();
  if (!api) return false;
  try {
    const cache = await api.open(READER_CACHE);
    const res = await cache.match(cacheKey(storageKey));
    return !!(res && res.ok);
  } catch {
    return false;
  }
}

/**
 * Hapus SATU file dari cache (dipanggil saat pratinjau/reader ditutup).
 * Buffer memori di-revoke objectURL-nya lalu dibuang; Cache Storage ikut
 * dibersihkan; status "keep" (bila pernah disimpan) juga dilepas supaya
 * tidak ada entri keep basi. Anotasi TIDAK tersentuh (ada di MongoDB).
 */
export async function evictReaderFile(storageKey: string): Promise<void> {
  unkeepReaderFile(storageKey);
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
  // File yang dipilih "Simpan" oleh user TIDAK boleh ikut tersapu.
  const kept = loadKeptSet();
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
          if (sk && !activeKeys.has(sk) && !kept.has(sk)) {
            await cache.delete(req).catch(() => {});
          }
        }
      }
    } catch {
      /* abaikan */
    }
  }
  // Buang entri memori yang pratinjaunya sudah tidak aktif (mis. dialog
  // ditutup tanpa evict karena error) — kecuali yang di-keep (buka ulang
  // tetap instan tanpa unduh dalam sesi ini).
  for (const key of Array.from(memCache.keys())) {
    if (!activeKeys.has(key) && !kept.has(key)) {
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
