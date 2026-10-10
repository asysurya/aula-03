// ─────────────────────────────────────────────────────────────────────
// Pencarian web untuk Teman AI (Task 29 → upgrade Task 30).
// Implementasi inti ada di ddg-core.mjs (plain ESM — dipakai bersama
// server MCP mcp/ddg-search.mjs). Wrapper ini memberi tipe TS + batas
// keamanan sisi server.
//
// Task 30: DuckDuckGo sering diblokir dari IP server → ddg-core kini
// menjalankan RANTAI FALLBACK multi-mesin (DDG html/lite/API, Brave,
// Bing, + provider ber-kunci opsional). Outcome memberi tahu engine
// yang menang + jejak kegagalan supaya UI/chat bisa menampilkan status.
// ─────────────────────────────────────────────────────────────────────

import {
  webSearchMulti,
  formatSearchResults,
  readPageText,
  ENGINE_LABELS,
} from "./ddg-core.mjs";

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchOutcome {
  results: WebSearchResult[];
  /** Blok teks siap disisipkan ke konteks AI. */
  block: string;
  query: string;
  /** Id mesin yang berhasil ("brave", "ddg-html", …) / null bila gagal. */
  engine: string | null;
  /** Label ramah untuk mesin ("Brave", "DuckDuckGo", …). */
  engineLabel: string;
  ok: boolean;
  /** Jejak kegagalan per mesin: [idMesin, pesan]. */
  tried: Array<[string, string]>;
}

/** Batas kata kunci agar tidak disalahgunakan sebagai proxy tak terbatas. */
export const MAX_QUERY_LEN = 400;

/**
 * Cari web & susun blok konteks. TIDAK melempar — bila SEMUA mesin gagal,
 * dikemas sebagai block berisi catatan kegagalan supaya chat tetap bisa
 * menjawab (tanpa data web) dan user tahu pencariannya gagal.
 */
export async function webSearchForContext(
  query: string,
  opts: { max?: number } = {}
): Promise<WebSearchOutcome> {
  const q = query.slice(0, MAX_QUERY_LEN);
  const { results, engine, errors } = await webSearchMulti(q, {
    max: opts.max ?? 6,
  });
  const tried = errors as Array<[string, string]>;
  const engineLabel = engine ? (ENGINE_LABELS[engine] ?? engine) : "";

  if (results.length) {
    const block =
      `=== HASIL PENCARIAN WEB (${engineLabel} — teks ringkas, bukan isi penuh) ===\n` +
      "Gunakan hasil ini sebagai rujukan; sebut sumbernya (nomor [1], [2], …) di jawaban. " +
      "Kalau hasilnya kurang relevan, katakan begitu.\n\n" +
      formatSearchResults(results);
    return { results: results as WebSearchResult[], block, query: q, engine, engineLabel, ok: true, tried };
  }

  const triedText = tried.map(([id, msg]) => `${id}: ${msg}`).join("; ");
  return {
    results: [],
    block:
      "=== HASIL PENCARIAN WEB ===\n" +
      `Pencarian web gagal — semua mesin penelusuran tidak dapat dihubungi dari server (${triedText}).\n` +
      "(Jawab sebisamu dari pengetahuanmu dan katakan bahwa pencarian web sedang gagal/tidak tersedia.)",
    query: q,
    engine: null,
    engineLabel: "",
    ok: false,
    tried,
  };
}

/** Saran peningkatan keandalan pencarian utk admin (dipakai UI/status). */
export const WEB_SEARCH_HINT_ENV =
  "Untuk keandalan 100%, pasang salah satu env di server: WEB_SEARCH_SERPER_KEY / WEB_SEARCH_BRAVE_KEY / WEB_SEARCH_TAVILY_KEY / WEB_SEARCH_SEARX_URL / WEB_SEARCH_JINA_KEY.";

export { readPageText, ENGINE_LABELS };
