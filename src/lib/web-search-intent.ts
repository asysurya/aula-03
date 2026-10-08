// ─────────────────────────────────────────────────────────────────────
// Deteksi maksud pencarian web (dipakai SERVER route chat DAN KLIEN UI).
// Modul murni tanpa dependensi server — Teman AI memakai deteksi yang
// SAMA untuk menampilkan animasi "Mencari di web…" tepat saat pesan
// dikirim, sebelum respons server mulai mengalir (Task 30).
// ─────────────────────────────────────────────────────────────────────

export const MAX_QUERY_LEN = 400;

/** Perintah eksplisit: "/cari …", "/search …", "/web …", "/google …". */
export const SEARCH_CMD = /^\/(?:cari|search|web|google|googling)\s+([\s\S]+)/i;

/** Sinyal otomatis (berita terkini, suruh googling, dsb.). */
export const SEARCH_AUTO =
  /\b(?:cari(?:kan)?\s+(?:di\s+)?(?:google|internet|web|online|net)|googling(?:kan)?|search\s+(?:di\s+)?(?:web|internet|online)|berita\s+(?:terbaru|terkini|hari\s+ini)|hari\s+ini\s+(?:apa|siapa|berapa)|tren\s+(?:sekarang|terbaru)|sedang\s+tren|kapan\s+(?:sekarang|tahun\s+ini)\b.*\?)/i;

export interface SearchIntent {
  active: boolean;
  query: string;
}

/** Deteksi apakah pesan pengguna meminta pencarian web. */
export function detectSearchIntent(message: string): SearchIntent {
  const cmd = SEARCH_CMD.exec(message);
  if (cmd) {
    return { active: true, query: cmd[1].trim().slice(0, MAX_QUERY_LEN) };
  }
  if (SEARCH_AUTO.test(message)) {
    return { active: true, query: message.trim().slice(0, MAX_QUERY_LEN) };
  }
  return { active: false, query: "" };
}

/** Label tampilan per id mesin pencarian (sinkron ddg-core.mjs). */
export const SEARCH_ENGINE_LABELS: Record<string, string> = {
  serper: "Google via Serper",
  "brave-api": "Brave API",
  tavily: "Tavily",
  searx: "SearXNG",
  "ddg-html": "DuckDuckGo",
  "ddg-lite": "DuckDuckGo",
  brave: "Brave",
  bing: "Bing",
  "ddg-api": "DuckDuckGo",
};
