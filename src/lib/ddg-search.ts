// ─────────────────────────────────────────────────────────────────────
// Pencarian web DuckDuckGo untuk Teman AI (Task 29).
// Implementasi inti ada di ddg-core.mjs (plain ESM — dipakai bersama
// server MCP mcp/ddg-search.mjs). Wrapper ini memberi tipe TS + batas
// keamanan sisi server.
// ─────────────────────────────────────────────────────────────────────

import {
  ddgWebSearch,
  formatSearchResults,
  readPageText,
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
}

/** Batas kata kunci agar tidak disalahgunakan sebagai proxy tak terbatas. */
export const MAX_QUERY_LEN = 400;

/**
 * Cari web & susun blok konteks. TIDAK melempar — error dikemas sebagai
 * block berisi catatan kegagalan supaya chat tetap bisa menjawab.
 */
export async function webSearchForContext(
  query: string,
  opts: { max?: number } = {}
): Promise<WebSearchOutcome> {
  const q = query.slice(0, MAX_QUERY_LEN);
  try {
    const results = (await ddgWebSearch(q, { max: opts.max ?? 6 })) as WebSearchResult[];
    const block =
      "=== HASIL PENCARIAN WEB (DuckDuckGo — teks ringkas, bukan isi penuh) ===\n" +
      "Gunakan hasil ini sebagai rujukan; sebut sumbernya (nomor [1], [2], …) di jawaban. " +
      "Kalau hasilnya kurang relevan, katakan begitu.\n\n" +
      formatSearchResults(results);
    return { results, block, query: q };
  } catch (e) {
    return {
      results: [],
      block:
        "=== HASIL PENCARIAN WEB ===\nPencarian gagal: " +
        String((e as Error)?.message ?? "kesalahan tak dikenal") +
        "\n(Jawab sebisamu dari pengetahuanmu dan katakan bahwa pencarian web sedang gagal.)",
      query: q,
    };
  }
}

export { readPageText };
