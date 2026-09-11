// ─────────────────────────────────────────────────────────────────────────
// Fast fetch — unduhan file secepat mungkin dari sisi client.
//
// Strategi ("akalin" batas bandwidth serverless):
// 1. Tanya /api/storage/[key]/link → kalau file ada di S3-compatible,
//    dapat URL PRESIGNED: unduh LANGSUNG dari penyimpanan (browser ↔ S3,
//    server Next hanya menandatangani URL — bandwidth Vercel 0%).
// 2. URL presigned dipakai MULTI-SEGMEN: file dipecah 1–6 koneksi Range
//    paralel → saturasi bandwidth (target 10–20 MB/s+ tergantung provider).
// 3. Gagal direct (CORS / jaringan / provider aneh) → otomatis fallback ke
//    proxy /api/storage/[key] (yang kini juga streaming + Range asli utk
//    S3) dengan segmentasi yang sama.
// 4. File MEGA / lokal: proxy satu koneksi streaming (multi-koneksi hanya
//    membebani server).
//
// Semua jalur melaporkan progress REAL-TIME (per chunk jaringan, bukan
// polling) via onProgress.
// ─────────────────────────────────────────────────────────────────────────

export interface FetchProgress {
  loaded: number;
  total: number | null;
  /** Kecepatan berjalan (byte/detik, window ±1s). */
  speed: number;
}

export interface FastFetchOptions {
  onProgress?: (p: FetchProgress) => void;
  signal?: AbortSignal;
}

interface StorageLink {
  ok: boolean;
  /** URL presigned (null = pakai proxy). */
  url: string | null;
  size: number;
  /** "auto" = boleh multi-segmen; angka = jumlah koneksi tetap. */
  segments: "auto" | number;
  stream?: boolean;
}

const linkCache = new Map<string, { at: number; link: StorageLink }>();
const LINK_TTL_MS = 5 * 60 * 1000;

/** URL proxy standar sebuah storageKey. */
export function storageProxyUrl(storageKey: string): string {
  return `/api/storage/${storageKey}`;
}

/** Minta strategi unduhan dari server (cache 5 menit per file). */
async function resolveLink(storageKey: string): Promise<StorageLink | null> {
  const hit = linkCache.get(storageKey);
  if (hit && Date.now() - hit.at < LINK_TTL_MS) return hit.link;
  try {
    const res = await fetch(
      `/api/storage/${encodeURIComponent(storageKey)}/link`,
      { cache: "no-store" }
    );
    if (!res.ok) return null;
    const link = (await res.json()) as StorageLink;
    if (!link?.ok) return null;
    linkCache.set(storageKey, { at: Date.now(), link });
    return link;
  } catch {
    return null;
  }
}

/** Buang cache link (mis. setelah gagal direct — coba lagi nanti). */
function dropLink(storageKey: string) {
  linkCache.delete(storageKey);
}

// ── Progress tracker (kecepatan window ±1 detik) ──
class SpeedMeter {
  private loaded = 0;
  private marks: { t: number; n: number }[] = [];
  add(n: number) {
    this.loaded += n;
    const now = Date.now();
    this.marks.push({ t: now, n });
    while (this.marks.length > 0 && now - this.marks[0].t > 1000) {
      this.marks.shift();
    }
  }
  get speed(): number {
    const now = Date.now();
    while (this.marks.length > 0 && now - this.marks[0].t > 1000) {
      this.marks.shift();
    }
    return this.marks.reduce((s, m) => s + m.n, 0);
  }
  get total(): number {
    return this.loaded;
  }
}

/** Baca response stream sambil melaporkan progress per chunk. */
async function drainWithProgress(
  res: Response,
  into: Uint8Array,
  offset: number,
  meter: SpeedMeter,
  onProgress: ((p: FetchProgress) => void) | undefined,
  total: number | null,
  signal?: AbortSignal
): Promise<number> {
  if (!res.body) {
    const buf = new Uint8Array(await res.arrayBuffer());
    into.set(buf, offset);
    meter.add(buf.byteLength);
    onProgress?.({ loaded: meter.total, total, speed: meter.speed });
    return buf.byteLength;
  }
  const reader = res.body.getReader();
  let pos = offset;
  let lastEmit = 0;
  for (;;) {
    if (signal?.aborted) {
      try {
        await reader.cancel();
      } catch {
        /* abaikan */
      }
      throw new DOMException("Aborted", "AbortError");
    }
    const { done, value } = await reader.read();
    if (done) break;
    if (value && value.byteLength > 0) {
      into.set(value, pos);
      pos += value.byteLength;
      meter.add(value.byteLength);
      const now = Date.now();
      if (onProgress && now - lastEmit >= 80) {
        lastEmit = now;
        onProgress({ loaded: meter.total, total, speed: meter.speed });
      }
    }
  }
  onProgress?.({ loaded: meter.total, total, speed: meter.speed });
  return pos - offset;
}

/** Jumlah segmen paralel adaptif berdasarkan ukuran. */
function segmentCount(size: number | null): number {
  if (!size) return 4;
  if (size <= 2 * 1024 * 1024) return 1;
  if (size <= 8 * 1024 * 1024) return 2;
  if (size <= 32 * 1024 * 1024) return 4;
  return 6;
}

interface SegmentPlan {
  start: number;
  end: number;
}

function planSegments(total: number, count: number): SegmentPlan[] {
  const segLen = Math.ceil(total / count);
  const out: SegmentPlan[] = [];
  for (let i = 0; i < count; i++) {
    const start = i * segLen;
    if (start >= total) break;
    out.push({ start, end: Math.min(total - 1, start + segLen - 1) });
  }
  return out;
}

/**
 * Unduh satu file menjadi ArrayBuffer — jalur tercepat yang tersedia.
 * Melempar Error bila semua jalur gagal.
 */
export async function fastFetchBuffer(
  storageKey: string,
  opts: FastFetchOptions = {}
): Promise<ArrayBuffer> {
  const { onProgress, signal } = opts;
  const link = await resolveLink(storageKey);

  // ── Jalur 1: URL presigned (S3) — multi-segmen paralel ──
  if (link?.url) {
    try {
      return await fetchBufferFromUrl(link.url, {
        total: link.size || null,
        allowSegments: link.segments === "auto",
        onProgress,
        signal,
        storageKey,
      });
    } catch (e) {
      if (signal?.aborted) throw e;
      // Direct gagal (CORS / jaringan) → fallback proxy, coba lagi.
      dropLink(storageKey);
    }
  }

  // ── Jalur 2: proxy /api/storage/[key] ──
  // - S3 (segments "auto" tanpa url presigned): multi-segmen Range —
  //   route kini menyajikan slice asli dari S3.
  // - MEGA/lokal (stream, segments 1): satu koneksi streaming.
  // - Link tak diketahui (gagal): aman → satu koneksi (segmentasi butuh
  //   jaminan Range murah; tanpa info kita bisa memicu unduhan penuh
  //   berulang kali di server).
  const allowSegments = link ? link.segments === "auto" : false;
  return fetchBufferFromUrl(storageProxyUrl(storageKey), {
    total: link?.size || null,
    allowSegments,
    onProgress,
    signal,
    storageKey,
    sameOrigin: true,
  });
}

async function fetchBufferFromUrl(
  url: string,
  args: {
    total: number | null;
    allowSegments: boolean;
    onProgress?: (p: FetchProgress) => void;
    signal?: AbortSignal;
    storageKey: string;
    sameOrigin?: boolean;
  }
): Promise<ArrayBuffer> {
  const { total, allowSegments, onProgress, signal } = args;

  // ── Satu koneksi (tanpa segmen): langsung streaming — TANPA probe ──
  // (probe Range pada file MEGA akan memicu unduhan penuh di server,
  //  jadi jalur ini tidak boleh mem-probe.)
  if (!allowSegments) {
    const res = await fetch(url, { cache: "no-store", signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await readSingle(res, total, onProgress, signal);
  }

  // ── Multi-segmen diizinkan: probe ukuran + dukungan Range ──
  // (GET 1 byte — murah utk S3 asli; respons 200 dibaca penuh langsung.)
  let size = total;
  let rangeOk = false;
  const probeRes = await fetch(url, {
    headers: { Range: "bytes=0-0" },
    cache: "no-store",
    signal,
  });
  if (probeRes.status === 206) {
    rangeOk = true;
    const cr = probeRes.headers.get("content-range");
    const m = cr ? /\/(\d+)$/.exec(cr.trim()) : null;
    if (m) size = parseInt(m[1], 10);
    try {
      await probeRes.body?.cancel();
    } catch {
      /* abaikan */
    }
  } else if (probeRes.ok) {
    // Server abaikan Range → body = SELURUH file; baca langsung.
    return await readSingle(probeRes, null, onProgress, signal);
  } else {
    throw new Error(`HTTP ${probeRes.status}`);
  }

  if (!size || size <= 0) {
    const res = await fetch(url, { cache: "no-store", signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await readSingle(res, null, onProgress, signal);
  }

  // File kecil → satu koneksi.
  const segs = rangeOk ? segmentCount(size) : 1;
  if (segs <= 1) {
    const res = await fetch(url, { cache: "no-store", signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await readSingle(res, size, onProgress, signal);
  }

  // ── Multi-segmen paralel ──
  const meter = new SpeedMeter();
  const plan = planSegments(size, segs);
  const out = new Uint8Array(size);
  let lastEmit = 0;

  await Promise.all(
    plan.map(async (seg) => {
      let attempt = 0;
      for (;;) {
        attempt++;
        try {
          const res = await fetch(url, {
            headers: { Range: `bytes=${seg.start}-${seg.end}` },
            cache: "no-store",
            signal,
          });
          if (res.status !== 206) {
            try {
              await res.body?.cancel();
            } catch {
              /* abaikan */
            }
            throw new Error(`Range ditolak (HTTP ${res.status})`);
          }
          const got = await drainWithProgress(
            res,
            out,
            seg.start,
            meter,
            (p) => {
              const now = Date.now();
              if (now - lastEmit >= 80) {
                lastEmit = now;
                onProgress?.(p);
              }
            },
            size,
            signal
          );
          if (got !== seg.end - seg.start + 1) {
            throw new Error("Segmen tidak lengkap");
          }
          return;
        } catch (e) {
          if (signal?.aborted) throw e;
          if (attempt >= 3) throw e;
          await new Promise((r) => setTimeout(r, 400 * attempt));
        }
      }
    })
  );

  onProgress?.({ loaded: size, total: size, speed: meter.speed });
  return out.buffer;
}

/** Baca satu response utuh menjadi ArrayBuffer dengan progress. */
async function readSingle(
  res: Response,
  total: number | null,
  onProgress?: (p: FetchProgress) => void,
  signal?: AbortSignal
): Promise<ArrayBuffer> {
  if (!res.ok && res.status !== 206) throw new Error(`HTTP ${res.status}`);
  const lenHeader = res.headers.get("content-length");
  const size = total ?? (lenHeader ? parseInt(lenHeader, 10) : null);
  const meter = new SpeedMeter();
  const chunks: Uint8Array[] = [];
  let lastEmit = 0;

  if (!res.body) {
    const buf = await res.arrayBuffer();
    return buf;
  }
  const reader = res.body.getReader();
  for (;;) {
    if (signal?.aborted) {
      try {
        await reader.cancel();
      } catch {
        /* abaikan */
      }
      throw new DOMException("Aborted", "AbortError");
    }
    const { done, value } = await reader.read();
    if (done) break;
    if (value && value.byteLength > 0) {
      chunks.push(value);
      meter.add(value.byteLength);
      const now = Date.now();
      if (onProgress && now - lastEmit >= 80) {
        lastEmit = now;
        onProgress({ loaded: meter.total, total: size, speed: meter.speed });
      }
    }
  }
  const out = new Uint8Array(size ?? meter.total);
  let pos = 0;
  for (const c of chunks) {
    out.set(c, pos);
    pos += c.byteLength;
  }
  onProgress?.({ loaded: pos, total: size ?? pos, speed: meter.speed });
  return out.buffer;
}

/** Info kecepatan ringkas untuk ditampilkan (mis. "12,4 MB/s"). */
export function formatSpeed(bps: number): string {
  if (!Number.isFinite(bps) || bps <= 0) return "…";
  const units = ["B/s", "KB/s", "MB/s", "GB/s"];
  let v = bps;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}
