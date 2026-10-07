// ─────────────────────────────────────────────────────────────────────
// ddg-core.mjs — Pencarian web DuckDuckGo TANPA dependensi & TANPA API
// key (Task 29: "MCP DDG untuk web search").
//
// File ini sengaja PLAIN ESM (bukan TS) supaya bisa dipakai dua-duanya:
//   1. Aplikasi Next.js  — src/lib/ddg-search.ts meng-import fungsi ini.
//   2. Server MCP        — mcp/ddg-search.mjs meng-import fungsi ini
//      (stdio JSON-RPC, bisa dipasang di Claude Desktop / klien MCP lain).
//
// Endpoint yang dipakai (gratis, tanpa kunci):
//   • POST https://html.duckduckgo.com/html/  (hasil lengkap)
//   • GET  https://lite.duckduckgo.com/lite/  (fallback sederhana)
// Override untuk pengujian: env DDG_BASE_URL (mis. http://127.0.0.1:3889).
// ─────────────────────────────────────────────────────────────────────

export const DEFAULT_DDG_BASE =
  process.env.DDG_BASE_URL || "https://html.duckduckgo.com";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

/** Bersihkan HTML entitas + tag → teks polos. */
export function htmlToText(s) {
  return String(s ?? "")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/gi, "/")
    .replace(/\s+/g, " ")
    .trim();
}

/** Tautan hasil DDG berupa redirect — ambil URL asli dari param uddg=. */
export function unwrapDdgHref(href) {
  let url = String(href ?? "").trim();
  if (!url) return "";
  if (url.startsWith("//")) url = "https:" + url;
  try {
    const u = new URL(url, "https://duckduckgo.com");
    if (u.pathname === "/l/") {
      const uddg = u.searchParams.get("uddg");
      if (uddg) return uddg;
    }
    return u.toString();
  } catch {
    return url;
  }
}

/** Ekstrak atribut dari tag pembuka <a ...>. */
function attrOf(openTag, name) {
  const m = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i").exec(openTag);
  return m ? (m[2] ?? m[3] ?? "") : null;
}

/** Cari semua anchor <a> dengan class tertentu — urutan atribut bebas. */
function anchorsWithClass(html, cls) {
  const out = [];
  const re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const attrs = m[1] ?? "";
    const classAttr = attrOf(attrs, "class") ?? "";
    if (classAttr.split(/\s+/).includes(cls)) {
      out.push({ href: attrOf(attrs, "href") ?? "", inner: m[2] ?? "" });
    }
  }
  return out;
}

/** Parse halaman hasil html.duckduckgo.com/html/ → daftar hasil. */
export function parseDdgHtml(html, max = 6) {
  const out = [];
  const seen = new Set();
  const links = anchorsWithClass(html, "result__a");
  const snippets = anchorsWithClass(html, "result__snippet").map((a) =>
    htmlToText(a.inner)
  );

  let idx = 0;
  for (const a of links) {
    if (out.length >= max) break;
    const url = unwrapDdgHref(a.href);
    const title = htmlToText(a.inner);
    if (!url || !title) {
      idx++;
      continue;
    }
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({ title, url, snippet: snippets[idx] ?? "" });
    idx++;
  }
  return out;
}

/** Parse halaman lite.duckduckgo.com/lite/ (tabel sederhana). */
export function parseDdgLite(html, max = 6) {
  const out = [];
  const seen = new Set();
  const links = anchorsWithClass(html, "result-link");
  // Lite: snippet ada di <td class="result-snippet"> (bukan anchor).
  const snippets = [];
  const tdRe = /<td\b([^>]*)>([\s\S]*?)<\/td>/gi;
  let tm;
  while ((tm = tdRe.exec(html)) !== null) {
    const classAttr = attrOf(tm[1] ?? "", "class") ?? "";
    if (classAttr.split(/\s+/).includes("result-snippet")) {
      snippets.push(htmlToText(tm[2] ?? ""));
    }
  }
  let idx = 0;
  for (const a of links) {
    if (out.length >= max) break;
    const url = unwrapDdgHref(a.href);
    const title = htmlToText(a.inner);
    if (!url || !title || seen.has(url)) {
      idx++;
      continue;
    }
    seen.add(url);
    out.push({ title, url, snippet: snippets[out.length] ?? "" });
    idx++;
  }
  return out;
}

/**
 * Cari web dengan DuckDuckGo. Return array {title, url, snippet}.
 * Melempar Error bila DDG tidak bisa dihubungi / diblokir (anomali).
 */
export async function ddgWebSearch(query, opts = {}) {
  const q = String(query ?? "").trim();
  if (!q) throw new Error("Kata kunci kosong");
  const max = Math.max(1, Math.min(opts.max ?? 6, 10));
  const base = (opts.base || DEFAULT_DDG_BASE).replace(/\/+$/, "");
  const signal = opts.signal ?? null;

  // ── 1) endpoint html ──
  try {
    const res = await fetch(base + "/html/", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": UA,
        Accept: "text/html",
        "Accept-Language": "id,en;q=0.8",
      },
      body: new URLSearchParams({ q, kl: "id-id" }).toString(),
      redirect: "follow",
      ...(signal ? { signal } : {}),
    });
    if (res.ok) {
      const html = await res.text();
      const results = parseDdgHtml(html, max);
      if (results.length) return results;
      // Halaman anomali/captcha → coba endpoint lite.
    }
  } catch (err) {
    if (signal?.aborted) throw err;
    // lanjut ke lite
  }

  // ── 2) endpoint lite (fallback) ──
  // (hanya bila base bukan override lokal — endpoint html mock lokal
  // biasanya tidak punya /lite/)
  const liteBase = base.includes("127.0.0.1") || base.includes("localhost")
    ? base
    : "https://lite.duckduckgo.com";
  const res = await fetch(liteBase + "/lite/", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": UA,
      "Accept-Language": "id,en;q=0.8",
    },
    body: new URLSearchParams({ q }).toString(),
    ...(signal ? { signal } : {}),
  });
  if (!res.ok) {
    throw new Error(`DuckDuckGo menjawab HTTP ${res.status}`);
  }
  const liteHtml = await res.text();
  const liteResults = parseDdgLite(liteHtml, max);
  if (!liteResults.length) {
    throw new Error(
      "DuckDuckGo tidak mengembalikan hasil (kemungkinan diblokir / kata kunci terlalu spesifik)"
    );
  }
  return liteResults;
}

/** Ambil isi halaman sebagai teks polos (cap maxLength). */
export async function readPageText(url, opts = {}) {
  const maxLen = opts.maxLength ?? 20_000;
  const signal = opts.signal ?? null;
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "text/html,*/*" },
    redirect: "follow",
    ...(signal ? { signal } : {}),
  });
  if (!res.ok) throw new Error(`Halaman menjawab HTTP ${res.status}`);
  const type = res.headers.get("content-type") ?? "";
  const raw = await res.text();
  const text = htmlToText(
    raw
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
  );
  const body = type.includes("html") ? text : raw;
  return body.length > maxLen ? body.slice(0, maxLen) + "\n…[dipotong]" : body;
}

/** Format hasil pencarian jadi blok teks (untuk konteks AI / MCP). */
export function formatSearchResults(results, { source = "DuckDuckGo" } = {}) {
  if (!results.length) return "";
  return results
    .map((r, i) => `[${i + 1}] ${r.title}\nURL: ${r.url}${r.snippet ? `\nRingkas: ${r.snippet}` : ""}`)
    .join("\n\n");
}
