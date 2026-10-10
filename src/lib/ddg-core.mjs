// ─────────────────────────────────────────────────────────────────────
// ddg-core.mjs — Pencarian web MULTI-MESIN tanpa dependensi (Task 30).
//
// File ini sengaja PLAIN ESM (bukan TS) supaya bisa dipakai dua-duanya:
//   1. Aplikasi Next.js  — src/lib/ddg-search.ts meng-import fungsi ini.
//   2. Server MCP        — mcp/ddg-search.mjs meng-import fungsi ini
//      (stdio JSON-RPC, bisa dipasang di Claude Desktop / klien MCP lain).
//
// MASALAH Task 30: endpoint DuckDuckGo sering DIBLOK dari IP server
// (datacenter/VPS — koneksi timeout, HTTP 202-anomali, atau halaman
// kosong), sehingga pencarian web "gagal, gabisa". Solusi: RANTAI
// FALLBACK multi-mesin — mesin pertama yang mengembalikan hasil menang;
// mesin yang gagal keras (jaringan/HTTP/timeout) diberi cooldown 10
// menit supaya pencarian berikutnya tidak menunggu lagi.
//
// Urutan default (semua gratis kecuali provider ber-kunci opsional):
//   1. Provider ber-API-key (opsional, paling andal utk produksi):
//      WEB_SEARCH_SERPER_KEY   → google.serper.dev
//      WEB_SEARCH_BRAVE_KEY    → api.search.brave.com
//      WEB_SEARCH_TAVILY_KEY   → api.tavily.com
//      WEB_SEARCH_SEARX_URL    → instans SearXNG sendiri (format=json)
//   2. ddg-html   → POST html.duckduckgo.com/html/  (hasil lengkap)
//   3. jina       → GET  s.jina.ai/<query> (mesin server-friendly —
//      dirancang untuk dipanggil dari server/agent; tanpa kunci tetap
//      jalan dengan batas laju; WEB_SEARCH_JINA_KEY utk kuota lebih)
//   4. brave      → GET  search.brave.com/search?q= (HTML, tanpa kunci)
//   5. bing       → GET  www.bing.com/search?q=     (HTML, tanpa kunci)
//   6. mojeek     → GET  www.mojeek.com/search?q=   (indeks sendiri,
//      paling toleran terhadap IP datacenter)
//   7. ecosia     → GET  www.ecosia.org/search?q=   (indeks Bing, HTML)
//   8. wikipedia  → API resmi id.wikipedia.org (→ en bila kosong) —
//      SELALU bisa dihubungi dari mana pun; bagus utk materi pelajaran
//   9. ddg-lite   → POST lite.duckduckgo.com/lite/  (fallback DDG)
//  10. ddg-api    → GET  api.duckduckgo.com (Instant Answer JSON resmi)
//
// Env:
//   DDG_BASE_URL            — override endpoint DDG (testing/mock).
//   JINA_BASE_URL           — override endpoint s.jina.ai (testing/mock).
//   WIKIPEDIA_BASE_URL      — override id.wikipedia.org (testing/mock).
//   MOJEEK_BASE_URL         — override www.mojeek.com (testing/mock).
//   ECOSIA_BASE_URL         — override www.ecosia.org (testing/mock).
//   WEB_SEARCH_ENGINES      — daftar id mesin dipisah koma (pin untuk
//                             testing, mis. "ddg-html,ddg-lite").
//   WEB_SEARCH_TIMEOUT_MS   — batas waktu per mesin (default 6000).
//   WEB_SEARCH_BUDGET_MS    — anggaran waktu TOTAL seluruh rantai
//                             (default 45000; mesin sisanya dilewati).
// ─────────────────────────────────────────────────────────────────────

export const DEFAULT_DDG_BASE =
  process.env.DDG_BASE_URL || "https://html.duckduckgo.com";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const ENGINE_TIMEOUT_MS = (() => {
  const n = Number(process.env.WEB_SEARCH_TIMEOUT_MS);
  return Number.isFinite(n) && n >= 500 ? n : 6000;
})();

/** Anggaran waktu TOTAL seluruh rantai (bukan per mesin). */
const CHAIN_BUDGET_MS = (() => {
  const n = Number(process.env.WEB_SEARCH_BUDGET_MS);
  return Number.isFinite(n) && n >= 2000 ? n : 45_000;
})();

/** Mesin yang gagal keras (jaringan/HTTP/timeout) dijeda 10 menit. */
const COOLDOWN_MS = 10 * 60 * 1000;
const engineDeadUntil = new Map();

// ── Util umum ─────────────────────────────────────────────────────────

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

/** Tautan hasil Bing kadang dibungkus redirect /ck/a?…&u=a1<base64>. */
function unwrapBingHref(href) {
  const url = String(href ?? "").trim();
  if (!url) return "";
  try {
    const u = new URL(url, "https://www.bing.com");
    if (u.hostname.endsWith("bing.com") && u.pathname === "/ck/a") {
      const enc = u.searchParams.get("u");
      if (enc && /^a1/.test(enc)) {
        const b64 = enc.slice(2).replace(/-/g, "+").replace(/_/g, "/");
        try {
          const dec = Buffer.from(b64, "base64").toString("utf8");
          if (/^https?:\/\//i.test(dec)) return dec;
        } catch {
          /* base64 rusak — pakai apa adanya */
        }
      }
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
      out.push({ href: attrOf(attrs, "href") ?? "", inner: m[2] ?? "", start: m.index, end: m.index + m[0].length });
    }
  }
  return out;
}

/** Cari semua tag <p …> dengan class tertentu — urutan atribut bebas. */
function paragraphsByClass(html, cls) {
  const out = [];
  const re = /<p\b([^>]*)>([\s\S]*?)<\/p>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const classAttr = attrOf(m[1] ?? "", "class") ?? "";
    if (classAttr.split(/\s+/).includes(cls)) {
      out.push(htmlToText(m[2] ?? ""));
    }
  }
  return out;
}

/** Cari semua anchor <a …> dengan data-test-id tertentu (Ecosia). */
function anchorsByDataTestId(html, testId) {
  const out = [];
  const re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const attrs = m[1] ?? "";
    const tid = attrOf(attrs, "data-test-id");
    if (tid === testId) {
      out.push({ href: attrOf(attrs, "href") ?? "", inner: m[2] ?? "", start: m.index, end: m.index + m[0].length });
    }
  }
  return out;
}

/** fetch + baca isi sebagai teks dengan batas waktu KERAS per mesin
 *  (mencakup DNS, headers, DAN pembacaan isi — server yang membekukan
 *  koneksi justru menjebak di fase-fase itu). Tanpa dependensi. */
async function fetchEngText(url, init = {}, { timeoutMs = ENGINE_TIMEOUT_MS, signal = null } = {}) {
  const ac = new AbortController();
  const onOuterAbort = () => ac.abort();
  if (signal) {
    if (signal.aborted) throw new Error("dibatalkan");
    signal.addEventListener("abort", onOuterAbort, { once: true });
  }
  // Satu timer untuk seluruh durasi: fetch + res.text().
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ac.signal });
    const text = await res.text();
    return { status: res.status, ok: res.ok, headers: res.headers, text };
  } catch (err) {
    if (signal?.aborted) throw new Error("dibatalkan");
    throw new Error(
      String(err?.name === "AbortError" ? `timeout ${timeoutMs}ms` : (err?.message ?? err))
    );
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onOuterAbort);
  }
}

/** fetch JSON dengan batas waktu keras (dipakai provider ber-kunci). */
async function fetchEngJson(url, init = {}, opts = {}) {
  const r = await fetchEngText(url, init, opts);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  try {
    return JSON.parse(r.text);
  } catch {
    throw new Error("respons bukan JSON valid");
  }
}

function isHttpUrl(s) {
  return /^https?:\/\//i.test(String(s ?? ""));
}

// ── Parser DuckDuckGo (html + lite) — dipertahankan dari Task 29 ──────

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

// ── Parser Brave (search.brave.com/search — HTML publik, tanpa kunci) ──

const BRAVE_INTERNAL =
  /(^|\.)(brave\.(com|dev)|bravesoftware\.com|imgs\.search\.brave\.com|search\.brave\.com)$/i;

/** Judul bersih dari isi anchor Brave: pakai elemen class *title*, buang breadcrumb "›". */
function braveTitleOf(inner) {
  const t = /class="[^"]*\btitle\b[^"]*"[^>]*>([^<]+)/i.exec(inner);
  let title = htmlToText(t ? t[1] : inner);
  if (title.includes("›")) {
    const after = title.slice(title.lastIndexOf("›") + 1).trim();
    if (after.length >= 6) title = after;
  }
  return title;
}

/** Parse halaman hasil Brave Search → daftar hasil. */
export function parseBraveHtml(html, max = 6) {
  const out = [];
  const seen = new Set();
  const anchors = [];
  const re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const href = attrOf(m[1] ?? "", "href") ?? "";
    if (!isHttpUrl(href)) continue;
    let host = "";
    try {
      host = new URL(href).hostname;
    } catch {
      continue;
    }
    if (BRAVE_INTERNAL.test(host)) continue;
    anchors.push({ href, inner: m[2] ?? "", start: m.index, end: m.index + m[0].length });
  }
  for (let i = 0; i < anchors.length && out.length < max; i++) {
    const a = anchors[i];
    const title = braveTitleOf(a.inner);
    if (title.length < 8) continue;
    // URL tanpa fragmen untuk dedup (tautan "#Lihat_pula" dibuang).
    const noFrag = a.href.split("#")[0];
    if (seen.has(noFrag)) continue;
    seen.add(noFrag);
    // Snippet: teks di antara anchor ini dan anchor eksternal berikutnya.
    const nextStart = anchors[i + 1]?.start ?? Math.min(a.end + 1500, html.length);
    const raw = html.slice(a.end, Math.min(nextStart, a.end + 1500));
    const snippet = htmlToText(
      raw
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    ).slice(0, 240);
    out.push({ title: title.slice(0, 160), url: noFrag, snippet });
  }
  return out;
}

// ── Parser Bing (www.bing.com/search — HTML publik, tanpa kunci) ──────

/** Parse halaman hasil Bing → daftar hasil (blok li.b_algo). */
export function parseBingHtml(html, max = 6) {
  const out = [];
  const seen = new Set();
  const blocks = html.split(/<li\b[^>]*class="[^"]*\bb_algo\b[^"]*"[^>]*>/i).slice(1);
  for (const rawBlock of blocks) {
    if (out.length >= max) break;
    const block = rawBlock.slice(0, 4000);
    const am =
      /<h2[^>]*>\s*<a\b([^>]*)>([\s\S]*?)<\/a>/i.exec(block) ??
      /<a\b([^>]*class="[^"]*\bb_title\b[^"]*"[^>]*)>([\s\S]*?)<\/a>/i.exec(block);
    if (!am) continue;
    const href = attrOf(am[1] ?? "", "href") ?? "";
    const url = unwrapBingHref(href);
    const title = htmlToText(am[2]);
    if (!isHttpUrl(url) || !title) continue;
    let host = "";
    try {
      host = new URL(url).hostname;
    } catch {
      continue;
    }
    if (/(^|\.)bing\.com$/i.test(host)) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    const pm = /<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(block);
    const snippet = pm ? htmlToText(pm[1]).slice(0, 240) : "";
    out.push({ title: title.slice(0, 160), url, snippet });
  }
  return out;
}

// ── Parser DuckDuckGo Instant Answer API (JSON resmi, tanpa kunci) ────

/** Parse JSON api.duckduckgo.com/?q=…&format=json → daftar hasil. */
export function parseDdgApi(data, max = 6) {
  const out = [];
  const push = (title, url, snippet) => {
    if (out.length >= max) return;
    if (!title || !isHttpUrl(url)) return;
    out.push({
      title: String(title).slice(0, 160),
      url: String(url),
      snippet: String(snippet ?? "").slice(0, 240),
    });
  };
  if (data?.AbstractText) {
    push(data.Heading || "Hasil DuckDuckGo", data.AbstractURL, data.AbstractText);
  }
  const walk = (arr) => {
    for (const t of arr ?? []) {
      if (Array.isArray(t.Topics)) walk(t.Topics);
      else if (t.FirstURL && t.Text) push(String(t.Text).split(" - ")[0], t.FirstURL, t.Text);
    }
  };
  walk(data?.RelatedTopics);
  return out;
}

// ── Parser Jina (s.jina.ai — server-friendly, tanpa kunci opsional) ──

const JINA_INTERNAL = /(^|\.)(jina\.ai|jina-ai\.com)$/i;

/** Parse respons s.jina.ai — bisa JSON {data:[…]} ATAU markdown link. */
export function parseJinaSearch(text, max = 6) {
  const out = [];
  const seen = new Set();
  const push = (title, url, snippet) => {
    if (out.length >= max) return;
    const t = String(title ?? "").replace(/^[\[\d.\]\s]+/, "").replace(/\*+/g, "").trim();
    const u = String(url ?? "").trim();
    if (!t || !isHttpUrl(u) || seen.has(u)) return;
    let host = "";
    try {
      host = new URL(u).hostname;
    } catch {
      return;
    }
    if (JINA_INTERNAL.test(host)) return;
    seen.add(u);
    out.push({ title: t.slice(0, 160), url: u, snippet: String(snippet ?? "").slice(0, 240) });
  };

  // Bentuk 1: JSON {"data":[{"title","url","snippet"|"content"}]}.
  try {
    const j = JSON.parse(text);
    const arr = Array.isArray(j) ? j : (j?.data ?? j?.results);
    if (Array.isArray(arr)) {
      for (const r of arr) {
        push(r?.title ?? r?.title ?? r?.name, r?.url ?? r?.link, r?.snippet ?? r?.content ?? r?.description);
      }
      if (out.length) return out;
    }
  } catch {
    /* bukan JSON — lanjut markdown */
  }

  // Bentuk 2: markdown link [judul](url) — snippet = teks di antara link.
  const links = [];
  const re = /\[(?:\[(\d+)\]\s*)?([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    links.push({ title: m[2], url: m[3], end: m.index + m[0].length });
  }
  for (let i = 0; i < links.length && out.length < max; i++) {
    const nextStart = links[i + 1]?.end ?? text.length;
    const snippet = text.slice(links[i].end, Math.min(nextStart, links[i].end + 400)).replace(/\s+/g, " ").trim();
    push(links[i].title, links[i].url, snippet);
  }

  // Bentuk 3: daftar bernomor "[1] Judul\nhttps://url\nsnippet".
  if (out.length < max) {
    const re2 = /^\s*\[\d+\]\s*([^\n]{8,200})\n\s*(https?:\/\/\S+)\n?\s*([^\n]{0,300})/gm;
    let m2;
    while ((m2 = re2.exec(text)) !== null) {
      push(m2[1], m2[2], m2[3]);
    }
  }
  return out;
}

// ── Parser Wikipedia (API resmi — selalu bisa dihubungi) ─────────────

/** Parse JSON MediaWiki list=search → daftar hasil. */
export function parseWikipediaApi(data, base, max = 6) {
  const out = [];
  const search = data?.query?.search;
  if (!Array.isArray(search)) return out;
  for (const s of search) {
    if (out.length >= max) break;
    if (!s?.title) continue;
    const url = `${base}/wiki/${encodeURIComponent(String(s.title).replace(/ /g, "_"))}`;
    const snippet = htmlToText(String(s.snippet ?? ""));
    out.push({ title: String(s.title).slice(0, 160), url, snippet: snippet.slice(0, 240) });
  }
  return out;
}

// ── Parser Mojeek (indeks sendiri — toleran IP datacenter) ─────────────

const MOJEEK_INTERNAL = /(^|\.)mojeek\.com$/i;

/** Parse halaman hasil Mojeek → daftar hasil. */
export function parseMojeekHtml(html, max = 6) {
  let links = anchorsWithClass(html, "ob"); // judul hasil
  if (!links.length) links = anchorsWithClass(html, "title");
  const snippets = paragraphsByClass(html, "s");
  const out = [];
  const seen = new Set();

  if (links.length) {
    let idx = 0;
    for (const a of links) {
      if (out.length >= max) break;
      let host = "";
      try {
        host = new URL(a.href).hostname;
      } catch {
        idx++;
        continue;
      }
      if (!isHttpUrl(a.href) || MOJEEK_INTERNAL.test(host)) {
        idx++;
        continue;
      }
      const title = htmlToText(a.inner);
      if (title.length < 6) {
        idx++;
        continue;
      }
      const noFrag = a.href.split("#")[0];
      if (seen.has(noFrag)) {
        idx++;
        continue;
      }
      seen.add(noFrag);
      out.push({ title: title.slice(0, 160), url: noFrag, snippet: (snippets[out.length] ?? "").slice(0, 240) });
      idx++;
    }
    if (out.length) return out;
  }

  // Fallback generik: anchor eksternal pertama di tiap blok hasil.
  const anchors = [];
  const re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const href = attrOf(m[1] ?? "", "href") ?? "";
    if (!isHttpUrl(href)) continue;
    let host = "";
    try {
      host = new URL(href).hostname;
    } catch {
      continue;
    }
    if (MOJEEK_INTERNAL.test(host)) continue;
    anchors.push({ href, inner: m[2] ?? "" });
  }
  for (const a of anchors) {
    if (out.length >= max) break;
    const title = htmlToText(a.inner);
    if (title.length < 10) continue;
    const noFrag = a.href.split("#")[0];
    if (seen.has(noFrag)) continue;
    seen.add(noFrag);
    out.push({ title: title.slice(0, 160), url: noFrag, snippet: "" });
  }
  return out;
}

// ── Parser Ecosia (indeks Bing, HTML tanpa kunci) ─────────────────────

const ECOSIA_INTERNAL = /(^|\.)(ecosia\.org|ecosia\.net)$/i;

/** Parse halaman hasil Ecosia → daftar hasil (a[data-test-id=result-link]). */
export function parseEcosiaHtml(html, max = 6) {
  const out = [];
  const seen = new Set();
  const links = anchorsByDataTestId(html, "result-link");
  const snippets = [];
  const re = /<p\b([^>]*)>([\s\S]*?)<\/p>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    if (attrOf(m[1] ?? "", "data-test-id") === "result-snippet") {
      snippets.push(htmlToText(m[2] ?? ""));
    }
  }
  let idx = 0;
  for (const a of links) {
    if (out.length >= max) break;
    let host = "";
    try {
      host = new URL(a.href).hostname;
    } catch {
      idx++;
      continue;
    }
    if (!isHttpUrl(a.href) || ECOSIA_INTERNAL.test(host)) {
      idx++;
      continue;
    }
    const title = htmlToText(a.inner).replace(/\s+/g, " ").trim();
    if (title.length < 6) {
      idx++;
      continue;
    }
    const noFrag = a.href.split("#")[0];
    if (seen.has(noFrag)) {
      idx++;
      continue;
    }
    seen.add(noFrag);
    out.push({ title: title.slice(0, 160), url: noFrag, snippet: (snippets[out.length] ?? "").slice(0, 240) });
    idx++;
  }
  return out;
}

// ── Mesin scraping gratis ──────────────────────────────────────────────
// NOTE: mesin mengembalikan ARRAY hasil (boleh kosong); keputusan
// "0 hasil → lanjut mesin berikutnya" dan cooldown ada di webSearchMulti.

async function searchDdgHtml(q, max, o) {
  const base = (o?.base || DEFAULT_DDG_BASE).replace(/\/+$/, "");
  const r = await fetchEngText(
    base + "/html/",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": UA,
        Accept: "text/html",
        "Accept-Language": "id,en;q=0.8",
      },
      body: new URLSearchParams({ q, kl: "id-id" }).toString(),
      redirect: "follow",
    },
    o
  );
  return parseDdgHtml(r.text, max);
}

async function searchDdgLite(q, max, o) {
  const base = (o?.base || DEFAULT_DDG_BASE).replace(/\/+$/, "");
  const liteBase =
    base.includes("127.0.0.1") || base.includes("localhost")
      ? base
      : "https://lite.duckduckgo.com";
  const r = await fetchEngText(
    liteBase + "/lite/",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": UA,
        "Accept-Language": "id,en;q=0.8",
      },
      body: new URLSearchParams({ q }).toString(),
      redirect: "follow",
    },
    o
  );
  return parseDdgLite(r.text, max);
}

async function searchBraveHtml(q, max, o) {
  const u = new URL("https://search.brave.com/search");
  u.searchParams.set("q", q);
  u.searchParams.set("source", "web");
  const r = await fetchEngText(
    u.toString(),
    {
      headers: {
        "User-Agent": UA,
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "id,en;q=0.8",
      },
      redirect: "follow",
    },
    o
  );
  if (r.status === 429) throw new Error("Brave rate-limit (429)");
  return parseBraveHtml(r.text, max);
}

async function searchBingHtml(q, max, o) {
  const u = new URL("https://www.bing.com/search");
  u.searchParams.set("q", q);
  u.searchParams.set("setlang", "id");
  u.searchParams.set("count", String(Math.min(max * 2, 20)));
  const r = await fetchEngText(
    u.toString(),
    {
      headers: {
        "User-Agent": UA,
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "id,en;q=0.8",
      },
      redirect: "follow",
    },
    o
  );
  return parseBingHtml(r.text, max);
}

async function searchDdgApi(q, max, o) {
  const u = new URL("https://api.duckduckgo.com/");
  u.searchParams.set("q", q);
  u.searchParams.set("format", "json");
  u.searchParams.set("no_html", "1");
  u.searchParams.set("skip_disambig", "1");
  const j = await fetchEngJson(
    u.toString(),
    { headers: { "User-Agent": UA, Accept: "application/json" } },
    o
  );
  return parseDdgApi(j, max);
}

async function searchJina(q, max, o) {
  const base = (o?.jinaBase || process.env.JINA_BASE_URL || "https://s.jina.ai").replace(/\/+$/, "");
  const headers = {
    Accept: "application/json",
    "X-Retain-Images": "none",
    "User-Agent": UA,
  };
  const key = process.env.WEB_SEARCH_JINA_KEY;
  if (key) headers.Authorization = `Bearer ${key}`;
  const r = await fetchEngText(
    `${base}/${encodeURIComponent(q)}`,
    { headers, redirect: "follow" },
    o
  );
  return parseJinaSearch(r.text, max);
}

async function searchWikipedia(q, max, o) {
  const base = (
    o?.wikipediaBase ||
    process.env.WIKIPEDIA_BASE_URL ||
    "https://id.wikipedia.org"
  ).replace(/\/+$/, "");
  // CATATAN: base boleh ber-path (mis. mock http://host/wikipedia) →
  // path endpoint digabung STRING (new URL absolut akan membuang prefix).
  const run = async (host) => {
    const u = new URL(host + "/w/api.php");
    u.searchParams.set("action", "query");
    u.searchParams.set("list", "search");
    u.searchParams.set("srsearch", q);
    u.searchParams.set("srlimit", String(max));
    u.searchParams.set("format", "json");
    u.searchParams.set("origin", "*");
    const j = await fetchEngJson(
      u.toString(),
      { headers: { "User-Agent": UA, Accept: "application/json" } },
      o
    );
    return parseWikipediaApi(j, host, max);
  };
  let results = await run(base);
  // Indonesian Wikipedia kosong → coba English (hanya saat base default).
  if (!results.length && base === "https://id.wikipedia.org") {
    results = await run("https://en.wikipedia.org");
  }
  return results;
}

async function searchMojeek(q, max, o) {
  const base = (
    o?.mojeekBase ||
    process.env.MOJEEK_BASE_URL ||
    "https://www.mojeek.com"
  ).replace(/\/+$/, "");
  const u = new URL(base + "/search");
  u.searchParams.set("q", q);
  const r = await fetchEngText(
    u.toString(),
    {
      headers: {
        "User-Agent": UA,
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "id,en;q=0.8",
      },
      redirect: "follow",
    },
    o
  );
  return parseMojeekHtml(r.text, max);
}

async function searchEcosia(q, max, o) {
  const base = (
    o?.ecosiaBase ||
    process.env.ECOSIA_BASE_URL ||
    "https://www.ecosia.org"
  ).replace(/\/+$/, "");
  const u = new URL(base + "/search");
  u.searchParams.set("q", q);
  const r = await fetchEngText(
    u.toString(),
    {
      headers: {
        "User-Agent": UA,
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "id,en;q=0.8",
      },
      redirect: "follow",
    },
    o
  );
  return parseEcosiaHtml(r.text, max);
}

// ── Provider ber-API-key (opsional — paling andal untuk produksi) ─────

async function searchSerper(q, max, key, o) {
  const j = await fetchEngJson(
    "https://google.serper.dev/search",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-KEY": key },
      body: JSON.stringify({ q, num: Math.min(max, 10), hl: "id" }),
    },
    o
  );
  return (j.organic ?? []).map((r) => ({ title: r.title, url: r.link, snippet: r.snippet ?? "" }));
}

async function searchBraveApi(q, max, key, o) {
  const u = new URL("https://api.search.brave.com/res/v1/web/search");
  u.searchParams.set("q", q);
  u.searchParams.set("count", String(Math.min(max, 10)));
  u.searchParams.set("country", "id");
  const j = await fetchEngJson(
    u.toString(),
    { headers: { Accept: "application/json", "X-Subscription-Token": key } },
    o
  );
  return (j?.web?.results ?? []).map((r) => ({
    title: r.title,
    url: r.url,
    snippet: r.description ?? "",
  }));
}

async function searchTavily(q, max, key, o) {
  const j = await fetchEngJson(
    "https://api.tavily.com/search",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: key, query: q, max_results: Math.min(max, 10) }),
    },
    o
  );
  return (j.results ?? []).map((r) => ({ title: r.title, url: r.url, snippet: r.content ?? "" }));
}

async function searchSearx(q, max, baseUrl, o) {
  const u = new URL("/search", baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl);
  u.searchParams.set("q", q);
  u.searchParams.set("format", "json");
  u.searchParams.set("safesearch", "1");
  const j = await fetchEngJson(
    u.toString(),
    { headers: { Accept: "application/json" } },
    o
  );
  return (j.results ?? []).map((r) => ({ title: r.title, url: r.url, snippet: r.content ?? "" }));
}

// ── Registri mesin + rantai fallback ──────────────────────────────────

/** Nama tampilan per id mesin (dipakai UI & blok konteks). */
export const ENGINE_LABELS = {
  serper: "Google via Serper",
  "brave-api": "Brave API",
  tavily: "Tavily",
  searx: "SearXNG",
  "ddg-html": "DuckDuckGo",
  jina: "Jina",
  brave: "Brave",
  bing: "Bing",
  mojeek: "Mojeek",
  ecosia: "Ecosia",
  wikipedia: "Wikipedia",
  "ddg-lite": "DuckDuckGo Lite",
  "ddg-api": "DuckDuckGo (Instant Answer)",
};

function engineFactories() {
  const list = [];
  const add = (id, run) => list.push({ id, run });
  if (process.env.WEB_SEARCH_SERPER_KEY)
    add("serper", (q, max, o) => searchSerper(q, max, process.env.WEB_SEARCH_SERPER_KEY, o));
  if (process.env.WEB_SEARCH_BRAVE_KEY)
    add("brave-api", (q, max, o) => searchBraveApi(q, max, process.env.WEB_SEARCH_BRAVE_KEY, o));
  if (process.env.WEB_SEARCH_TAVILY_KEY)
    add("tavily", (q, max, o) => searchTavily(q, max, process.env.WEB_SEARCH_TAVILY_KEY, o));
  if (process.env.WEB_SEARCH_SEARX_URL)
    add("searx", (q, max, o) => searchSearx(q, max, process.env.WEB_SEARCH_SEARX_URL, o));
  add("ddg-html", searchDdgHtml);
  add("jina", searchJina);
  add("brave", searchBraveHtml);
  add("bing", searchBingHtml);
  add("mojeek", searchMojeek);
  add("ecosia", searchEcosia);
  add("wikipedia", searchWikipedia);
  add("ddg-lite", searchDdgLite);
  add("ddg-api", searchDdgApi);
  return list;
}

/**
 * Cari web dengan RANTAI FALLBACK multi-mesin.
 * Return { results, engine, errors } — TIDAK melempar; mesin pertama yang
 * mengembalikan ≥1 hasil menang. errors = [[idMesin, pesan], …] jejak
 * kegagalan sebelum sukses (atau semua bila gagal total).
 */
export async function webSearchMulti(query, opts = {}) {
  const q = String(query ?? "").trim();
  if (!q) return { results: [], engine: null, errors: [["query", "Kata kunci kosong"]] };
  const max = Math.max(1, Math.min(opts.max ?? 6, 10));
  const timeoutMs = opts.timeoutMs ?? ENGINE_TIMEOUT_MS;

  let engines = engineFactories();
  const pinned = String(opts.engines ?? process.env.WEB_SEARCH_ENGINES ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (pinned.length) {
    const allow = new Set(pinned);
    engines = engines.filter((e) => allow.has(e.id));
  }

  const errors = [];
  const now = Date.now();
  const budget = opts.budgetMs ?? CHAIN_BUDGET_MS;
  const startedAt = Date.now();
  for (const eng of engines) {
    if (Date.now() - startedAt > budget && errors.length) {
      errors.push([eng.id, "dilewati — anggaran waktu rantai habis"]);
      continue;
    }
    const deadUntil = engineDeadUntil.get(eng.id);
    if (deadUntil && deadUntil > now && !opts.noCooldown) {
      errors.push([eng.id, "dilewati (cooldown 10 mnt setelah gagal)"]);
      continue;
    }
    // Pengaman keras: seluruh operasi mesin (DNS + headers + baca isi +
    // parse) dibatasi timeoutMs + 2 dtk — koneksi yang dibekukan server
    // tidak boleh menggantung rantai lebih lama dari itu.
    let results = null;
    const guard = setTimeout(
      () => rejectGuard(new Error(`timeout mesin ${timeoutMs + 2000}ms`)),
      timeoutMs + 2000
    );
    let rejectGuard = (_e) => {};
    const guardPromise = new Promise((_resolve, reject) => {
      rejectGuard = reject;
    });
    try {
      results = await Promise.race([
        // Teruskan seluruh opts (base per-mesin utk testing: jinaBase,
        // wikipediaBase, mojeekBase, ecosiaBase, base utk DDG).
        eng.run(q, max, { ...opts, timeoutMs, signal: opts.signal ?? null }),
        guardPromise,
      ]);
    } catch (e) {
      const msg = String(e?.message ?? e).slice(0, 140);
      errors.push([eng.id, msg]);
      // Kegagalan jaringan/HTTP/timeout → cooldown agar pencarian
      // berikutnya tidak menunggu mesin mati itu lagi.
      if (!/dibatalkan|Kata kunci/.test(msg)) {
        engineDeadUntil.set(eng.id, Date.now() + COOLDOWN_MS);
      }
      continue;
    } finally {
      clearTimeout(guard);
    }
    if (results && results.length) {
      return { results: results.slice(0, max), engine: eng.id, errors };
    }
    // 0 hasil = halaman anomali/diblokir/kata kunci tak ketemu — coba
    // mesin berikutnya TANPA cooldown (mesin mungkin sehat, hanya kosong).
    errors.push([eng.id, results ? "tidak ada hasil" : "respons kosong"]);
  }
  return { results: [], engine: null, errors };
}

/** Reset cooldown mesin (dipakai pengujian / debug). */
export function resetEngineCooldown() {
  engineDeadUntil.clear();
}

/**
 * Cari web (kompatibilitas Task 29 — dipakai MCP).
 * Melempar Error bila SEMUA mesin gagal, pesannya merangkum jejaknya.
 */
export async function ddgWebSearch(query, opts = {}) {
  const { results, errors } = await webSearchMulti(query, opts);
  if (!results.length) {
    throw new Error(
      "semua mesin penelusuran gagal — " +
        errors.map(([id, msg]) => `${id}: ${msg}`).join("; ")
    );
  }
  return results;
}

/** Ambil isi halaman sebagai teks polos (cap maxLength). */
export async function readPageText(url, opts = {}) {
  const maxLen = opts.maxLength ?? 20_000;
  const signal = opts.signal ?? null;
  const r = await fetchEngText(
    url,
    { headers: { "User-Agent": UA, Accept: "text/html,*/*" }, redirect: "follow" },
    { timeoutMs: opts.timeoutMs ?? 15_000, signal }
  );
  if (!r.ok) throw new Error(`Halaman menjawab HTTP ${r.status}`);
  const type = r.headers.get("content-type") ?? "";
  const raw = r.text;
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
