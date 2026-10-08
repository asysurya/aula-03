// ─────────────────────────────────────────────────────────────────────
// Preprocessor rumus untuk jawaban AI (dipakai ai-markdown.tsx).
// Modul MURNI (tanpa React) supaya bisa diuji unit (E2E t30).
//
// Task 29: rumus polos "V_p I_p = V_s I_s" dibungkus $…$ otomatis.
// Task 30 — model kadang tetap menulis rumus dengan pembatas yang TIDAK
// dikenali remark-math, mis.:
//   [ Q = I^{2} R t = 3^{2} \times 2 \times 10 = 180,\text{J} ]
//   \[ Q = I^2 R t \]        (LaTeX display standar)
//   \( y = 2x \)             (LaTeX inline standar)
// Semua dinormalkan menjadi $…$ / $$…$$ supaya KaTeX merendernya.
//
// Urutan tahap (preprocessMath):
//   1. normalizeMathDelimiters — \[…\] → $$…$$, \(…\) → $…$
//   2. wrapBracketMath        — [ LaTeX ] → $…$ (pendek) / $$…$$ (panjang)
//   3. wrapBareFormulas       — "V_p I_p = V_s I_s" → $V_p I_p = V_s I_s$
// Blok kode ```…``` dan inline code `…` DILEWATI.
// ─────────────────────────────────────────────────────────────────────

// ── Token sub/superskrip — kini menerima grup {...}: I^{2}, V_{p} ──────
const SUBSUP_TOKEN =
  /[A-Za-z0-9)\]}](?:[_^](?:\{[A-Za-z0-9]{1,3}\}|[A-Za-z0-9]{1,2}))(?![A-Za-z0-9])/g;
const MATH_OP = /[=+\-−±×÷·≈≤≥^]/;

function countSubsupTokens(text: string): number {
  const m = text.match(SUBSUP_TOKEN);
  return m ? m.length : 0;
}

// ── Tahap 1: pembatas LaTeX standar \[…\] / \(…\) ─────────────────────

/** \[ … \] → $$…$$ ; \( … \) → $…$ (spasi tepi dipangkas). */
export function normalizeMathDelimiters(s: string): string {
  if (!s.includes("\\")) return s;
  return s
    .replace(/\\\[([\s\S]{1,2000}?)\\\]/g, (_m, inner: string) => `$$${String(inner).trim()}$$`)
    .replace(/\\\(([\s\S]{1,500}?)\\\)/g, (_m, inner: string) => `$${String(inner).trim()}$`);
}

// ── Tahap 2: rumus dalam kurung siku [ … ] ────────────────────────────

/** Penanda LaTeX kuat: perintah \frac, \times, \text… atau ^{ / _{ / ^2 / _2. */
const LATEX_MARK =
  /\\[a-zA-Z]{2,}|\^\{|\_\{|\^[A-Za-z0-9]+|_[A-Za-z0-9]+/;
/** Kata prosa (≥4 huruf kecil berurutan) — penanda BUKAN rumus murni. */
const PROSE_WORD = /[a-z]{4,}/;
/** Karakter yang wajar dalam rumus sederhana (untuk heuristik "… = …"). */
const MATHY_CHARSET = /^[\sA-Za-z0-9=+\-−±×÷·/^_.,()%°{}\\]*$/;

function stripLatexCommands(c: string): string {
  return c
    .replace(/\\[a-zA-Z]+\{[^{}]*\}/g, " ") // \text{J} → spasi
    .replace(/\\[a-zA-Z]+/g, " "); // \times, \frac → spasi
}

/** Apakah isi kurung siku tampak seperti rumus (bukan tautan/prosa)? */
function looksLikeBracketMath(inner: string): boolean {
  const c = inner.trim();
  if (!c || c.length > 600) return false;
  if (c.includes("$")) return false; // sudah ada pembatas math di dalam
  if (/^\^[^{}]/.test(c)) return false; // footnote markdown [^1]
  const stripped = stripLatexCommands(c);
  if (PROSE_WORD.test(stripped)) return false;
  if (LATEX_MARK.test(c)) return true;
  // Tanpa penanda LaTeX: terima hanya pola "… = …" pendek yang karakternya
  // mathy semua (mis. "[ Q = 180 ]") — bukan "[ lihat lampiran ]".
  return c.length <= 80 && c.includes("=") && MATHY_CHARSET.test(c);
}

/**
 * Ganti [ rumus ] menjadi math. Pendek satu baris (≤40 kar.) → $…$ inline;
 * lainnya → $$…$$ sebagai blok sendiri (baris kosong di kiri-kanannya)
 * supaya remark-math memparse sebagai flow math.
 */
export function wrapBracketMath(text: string): string {
  if (!text.includes("[") || !text.includes("]")) return text;
  return text.replace(
    /\[([^\[\]]{1,600})\]/g,
    (whole: string, inner: string, offset: number) => {
      const after = text.slice(offset + whole.length);
      // Tautan markdown [teks](url), referensi [teks][ref], definisi [label]: …
      if (/^[[(:]/.test(after)) return whole;
      if (!looksLikeBracketMath(inner)) return whole;
      const c = inner.trim();
      // Baris asli melingkupi bracket (rumus ditulis multi-baris) → blok
      // display; satu baris & pendek → inline.
      const multiLine = inner.includes("\n");
      if (!multiLine && c.length <= 40) return `$${c}$`;
      return `\n\n$$${c}$$\n\n`;
    }
  );
}

// ── Tahap 3: rumus polos tanpa pembatas apa pun ───────────────────────

/** Bungkus bagian baris yang tampak seperti rumus dengan $…$ (per kata). */
function wrapBareFormulas(text: string): string {
  if (!text || text.includes("$")) return text; // sudah ada LaTeX — jangan ganggu
  if (!/[_^]/.test(text)) return text;
  return text
    .split("\n")
    .map((line) => {
      if (!/[_^]/.test(line) || line.includes("$")) return line;

      // pecah baris jadi kata + pemisah (spasi dipertahankan)
      const rawParts = line.split(/(\s+)/);
      type W = { text: string; token: boolean; op: boolean; block: boolean; numeric: boolean };
      const words: W[] = rawParts
        .filter((p) => p.length > 0 && !/^\s+$/.test(p))
        .map((w) => {
          // JANGAN pangkas { } dari tepi kata — grup braced (V_{p})
          // harus utuh agar terdeteksi sebagai token sub/superskrip.
          const clean = w.replace(/^[(["'“—-]+|[)\]"'”.,;:!?-]+$/g, "");
          const block =
            clean.includes("://") || /^(https?:|www\.|data:)/i.test(clean);
          return {
            text: w,
            token: !block && countSubsupTokens(clean) > 0,
            op: !block && MATH_OP.test(clean),
            block,
            numeric: /^[0-9][0-9.,%°]*$/.test(clean),
          };
        });

      const interesting = (w: W) => w.token || w.op;
      let out = "";
      let i = 0;
      const n = words.length;
      while (i < n) {
        if (!interesting(words[i])) {
          out += words[i].text + " ";
          i++;
          continue;
        }
        // cluster: dari kata menarik pertama sampai terakhir, blok URL
        // / kata prosa murni (>2 huruf a-z tanpa angka/op) memutus cluster.
        let last = i;
        for (let k = i + 1; k < n; k++) {
          const w = words[k];
          if (w.block) break;
          if (interesting(w)) {
            last = k;
            continue;
          }
          // kata interior: numerik / pendek → masih bagian rumus; prosa
          // murni panjang → putus.
          if (w.numeric || /^[a-zA-Z]{1,2}$/.test(w.text.replace(/[^\w]/g, ""))) {
            continue;
          }
          break;
        }
        // perluas ke numerik tepian (mis. "= 220" di "V_p = 220 V")
        let end = last;
        while (end + 1 < n && words[end + 1].numeric) end++;
        let start = i;
        while (start - 1 >= 0 && words[start - 1].numeric) start--;

        const cluster = words.slice(start, end + 1);
        const tokenCount = cluster.filter((w) => w.token).length;
        const hasOp = cluster.some((w) => w.op);
        const joined = cluster.map((w) => w.text).join(" ");
        const isShort = joined.length <= 200;
        if (tokenCount >= 1 && (tokenCount >= 2 || hasOp) && isShort) {
          out += `$${joined}$ `;
        } else {
          out += joined + " ";
        }
        i = end + 1;
      }
      return out.replace(/[ ]+$/g, "").replace(/[ ]{2,}/g, " ");
    })
    .join("\n");
}

/** true bila konten mungkin memuat rumus (gerbang murah). */
function maybeHasMath(content: string): boolean {
  // _ ^ \ (LaTeX/subskrip), atau kurung siku berisi "=" (mis. "[ Q = 180 ]").
  return /[_^\\]|\[[^\[\]]*=|\[\s*$/.test(content);
}

/**
 * Preprocess konten markdown: normalkan pembatal LaTeX, bungkus rumus
 * dalam kurung siku & rumus polos menjadi LaTeX.
 * Blok kode ``` … ``` dan inline code ` … ` DILEWATI (jangan sentuh kode).
 */
export function preprocessMath(content: string): string {
  if (!content || !maybeHasMath(content)) return content;
  const parts = content.split(/(```[\s\S]*?```|`[^`\n]*`)/g);
  return parts
    .map((p, i) =>
      i % 2 === 1
        ? p
        : wrapBareFormulas(wrapBracketMath(normalizeMathDelimiters(p)))
    )
    .join("");
}
