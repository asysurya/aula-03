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
//   2. repairMathDelimiters   — perbaiki $/$$ rusak (orphan/ganjil/beda)
//   3. wrapBracketMath        — [ LaTeX ] → $…$ (pendek) / $$…$$ (panjang)
//   4. wrapBareFormulas       — "V_p I_p = V_s I_s" → $V_p I_p = V_s I_s$
//   5. displayifyLongMath     — $$…$$ ber-\frac dll → blok display
// Blok kode ```…``` dan inline code `…` DILEWATI.
//
// Task 31 — laporan user "masih gagal render $$…$$": model kadang menulis
// pembatas yang RUSAK — terverifikasi remark-math MENOLAK / salah pasang:
//   I_s = I_p\,\frac{V_p}{V_s}$$                  ← pembuka $$ hilang
//   $I_2=\frac{15}{200}\text{ A} =75\text{ mA}$$  ← pembuka $, penutup $$
//   …= I_p…$$ prosa … $$V_p I_p = …$$             ← jumlah $$ GANJIL →
//     prosa yang salah dirender jadi rumus & rumus tampil mentah
// repairMathDelimiters membetulkan semuanya dengan DFS + validasi penuh:
// hasil HANYA dipakai bila semua pasangan akhir sehat — teks yang tak
// bisa diselesaikan dibiarkan apa adanya (tidak pernah dirusak).
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

// ── Tahap 1b (Task 31): perbaiki pembatas $ / $$ yang rusak ───────────

/** Kata prosa umum yang dibuang dari tepi run rumus saat mencari awal
 *  rumus sebelum pembatas orphan (mis. "maka arus I_s = …$$"). */
const PROSE_DROP_WORDS = new Set([
  "dan", "atau", "maka", "adalah", "bahwa", "dengan", "dari", "pada",
  "untuk", "sehingga", "jika", "bila", "karena", "sebesar", "sekitar",
  "tersebut", "ialah", "yaitu", "yakni", "sementara", "sedangkan",
  "juga", "hanya", "masih", "sudah", "belum", "akan", "tidak", "bukan",
  "dapat", "boleh", "harus", "kita", "ini", "itu", "saja", "nya", "dia",
  "text", "teks", "rumus", "persamaan", "diperoleh", "dihitung",
  "besarnya", "nilai", "hasil", "jawaban", "penyelesaian", "diketahui",
  "ditanya", "jawab", "pembahasan", "arus", "listrik", "tegangan",
  "daya", "hambatan", "kuat", "energi", "massa", "waktu", "jarak",
  "kecepatan", "percepatan", "gaya", "usaha", "suhu", "kalor",
  "muatan", "besar", "kecil", "arah", "pertama", "kedua", "ketiga",
]);

/** Karakter yang wajar dalam run rumus saat memindai mundur/maju
 *  (= WAJIB — rumus selalu memuat tanda sama-dengan). */
const MATH_BACK_CHARS = /[\\(){}\[\]A-Za-z0-9=+\-−±×÷·/^_.,%°'′ ]/;

type DollarRun = { start: number; len: number };

function collectDollarRuns(seg: string): DollarRun[] {
  const runs: DollarRun[] = [];
  let i = 0;
  while (i < seg.length) {
    if (seg[i] === "$") {
      let j = i;
      while (j < seg.length && seg[j] === "$") j++;
      runs.push({ start: i, len: j - i });
      i = j;
    } else {
      i++;
    }
  }
  return runs;
}

/** Badan rumus dari sebuah run: sufiks TERPANJANG yang tampak seperti
 *  rumus (mis. "Bisa lewat perbandingan = I_p\,…" → "= I_p\,…") —
 *  batas kata di tiap spasi diuji; fallback ke daftar kata prosa. */
function trimProsePrefix(run: string): string {
  let best = "";
  const bounds: number[] = [0];
  const re = /\s+/g;
  while (re.exec(run)) bounds.push(re.lastIndex);
  for (const b of bounds) {
    const suffix = run.slice(b).trim();
    if (suffix.length > best.length && looksLikeBracketMath(suffix)) best = suffix;
  }
  if (best) return best;
  // fallback lama: buang kata prosa dari daftar di awal run.
  let s = run;
  for (;;) {
    const m = /^([A-Za-z]{2,})[\s,;:]+/.exec(s);
    if (!m || !PROSE_DROP_WORDS.has(m[1].toLowerCase())) break;
    s = s.slice(m[0].length);
  }
  return s.trim();
}

/** Badan rumus dari sebuah run (pembuka orphan): prefiks TERPANJANG yang
 *  tampak seperti rumus, lalu kata prosa daftar di ujung dibuang. */
function trimProseSuffix(run: string): string {
  let best = "";
  const bounds: number[] = [run.length];
  const re = /\s+/g;
  while (re.exec(run)) bounds.push(re.index);
  for (const b of bounds) {
    const prefix = run.slice(0, b).trim();
    if (prefix.length > best.length && looksLikeBracketMath(prefix)) best = prefix;
  }
  if (best) {
    let s = best;
    for (;;) {
      const m = /[\s,;:]+([A-Za-z]{2,})$/.exec(s);
      if (!m || !PROSE_DROP_WORDS.has(m[1].toLowerCase())) break;
      s = s.slice(0, s.length - m[0].length);
    }
    return s.trim();
  }
  let s2 = run;
  for (;;) {
    const m = /[\s,;:]+([A-Za-z]{2,})$/.exec(s2);
    if (!m || !PROSE_DROP_WORDS.has(m[1].toLowerCase())) break;
    s2 = s2.slice(0, s2.length - m[0].length);
  }
  return s2.trim();
}

/** Posisi awal run rumus sebelum pembatas (mundur; berhenti di baris baru,
 *  titik-akhir-kalimat, atau karakter non-mathy). */
function findFormulaStartBackward(text: string, closePos: number): number {
  let i = closePos;
  while (i > 0 && (text[i - 1] === " " || text[i - 1] === "\t")) i--;
  let j = i;
  let depth = 0;
  while (j > 0) {
    const c = text[j - 1];
    if (c === "\n") break;
    // "…kalimat. Rumus" — titik + spasi = akhir kalimat (desimal 3.14 lanjut).
    if (c === "." && /\s/.test(text[j] ?? "")) break;
    if (c === "}") {
      depth++;
      j--;
      continue;
    }
    if (c === "{") {
      if (depth > 0) {
        depth--;
        j--;
        continue;
      }
      break;
    }
    if (MATH_BACK_CHARS.test(c)) {
      j--;
      continue;
    }
    break;
  }
  return j;
}

/** Posisi akhir run rumus setelah pembuka yang belum ditutup (maju). */
function findFormulaEndForward(text: string, fromIdx: number): number {
  let j = fromIdx;
  let depth = 0;
  while (j < text.length) {
    const c = text[j];
    if (c === "\n") break;
    if (c === "{") {
      depth++;
      j++;
      continue;
    }
    if (c === "}") {
      if (depth > 0) {
        depth--;
        j++;
        continue;
      }
      break;
    }
    if (MATH_BACK_CHARS.test(c)) {
      j++;
      continue;
    }
    break;
  }
  return j;
}

/** Apakah isi di antara sepasang pembatas layak jadi rumus?
 *  Wajib penanda LaTeX; prosa ≥4 huruf kecil (setelah \cmd dilucuti) menolak. */
function pairLooksLikeMath(inner: string): boolean {
  const t = inner.trim();
  if (!t || t.length > 2000) return false;
  if (!LATEX_MARK.test(t)) return false;
  return !PROSE_WORD.test(stripLatexCommands(t));
}

/** Pasangan "cukup sehat" untuk validasi akhir: rumus LaTeX ATAU segmen
 *  pendek ≤40 kar. tanpa kata prosa ("x", "V = 5", "D"). */
function cleanPairInner(inner: string): boolean {
  if (pairLooksLikeMath(inner)) return true;
  const t = inner.trim();
  if (!t || t.length > 40) return false;
  return !PROSE_WORD.test(stripLatexCommands(t));
}

function mathRunsState(seg: string) {
  const runs = collectDollarRuns(seg);
  const pairs: Array<[DollarRun, DollarRun]> = [];
  for (let k = 0; k + 1 < runs.length; k += 2) pairs.push([runs[k], runs[k + 1]]);
  const leftover = runs.length % 2 === 1 ? runs[runs.length - 1] : null;
  return { runs, pairs, leftover };
}

/** Semua $ berpasangan sama panjang & isinya layak jadi rumus. */
function isFullyClean(seg: string): boolean {
  const { runs, pairs, leftover } = mathRunsState(seg);
  if (runs.length === 0 || leftover) return false;
  if (runs.some((r) => r.len > 2)) return false;
  return pairs.every(
    ([a, b]) => a.len === b.len && cleanPairInner(seg.slice(a.start + a.len, b.start))
  );
}

type Edit = { pos: number; insert: string };

/** Kandidat: run "$$" ini sebenarnya PENUTUP orphan — sisipkan "$$"
 *  sebelum badan rumus yang mendahuluinya. */
function orphanCloseEdit(seg: string, runPos: number): Edit | null {
  if (runPos === 0) return null;
  const fs = findFormulaStartBackward(seg, runPos);
  const run = seg.slice(fs, runPos);
  const body = trimProsePrefix(run);
  if (!body || !LATEX_MARK.test(body)) return null; // ketat: wajib penanda LaTeX
  return { pos: runPos - body.length, insert: "$$" };
}

/** Kandidat: run "$$" ini sebenarnya PEMBUKA orphan (stream terpotong) —
 *  tambahkan "$$" setelah badan rumus yang mengikutinya. */
function orphanOpenEdit(seg: string, afterPos: number): Edit | null {
  if (afterPos >= seg.length) return null;
  const fe = findFormulaEndForward(seg, afterPos);
  const run = seg.slice(afterPos, fe);
  const body = trimProseSuffix(run);
  if (!body || !LATEX_MARK.test(body)) return null;
  return { pos: afterPos + body.length, insert: "$$" };
}

/** Plausibilitas isi untuk perbaikan panjang beda: rumus LaTeX, ATAU
 *  segmen pendek dengan sinyal math (= \ ^ _) tanpa kata prosa. */
function mismatchPlausible(inner: string): boolean {
  if (pairLooksLikeMath(inner)) return true;
  const t = inner.trim();
  if (!t || t.length > 60) return false;
  if (!/[=\\^_]/.test(t)) return false;
  return !PROSE_WORD.test(stripLatexCommands(t));
}

/** Kandidat edit untuk ronde ini (sedikit — DFS yang mengeksplorasi). */
function candidatesFor(seg: string): Edit[] {
  const { pairs, leftover } = mathRunsState(seg);
  const out: Edit[] = [];
  // 1) pasangan panjang beda ($…$$ / $$…$) ber-isi rumus → samakan jadi $$
  for (const [a, b] of pairs) {
    if (a.len === b.len) continue;
    if (a.len < 1 || a.len > 2 || b.len < 1 || b.len > 2) continue;
    const inner = seg.slice(a.start + a.len, b.start);
    if (!mismatchPlausible(inner)) continue;
    out.push(a.len === 1 ? { pos: a.start, insert: "$" } : { pos: b.start, insert: "$" });
    break;
  }
  // 2) pasangan pertama yang berisi prosa → PEMBUKANYA = penutup orphan
  //    (boleh di indeks mana pun — rumus sebelumnya kehilangan pembuka).
  if (out.length === 0) {
    for (const [a, b] of pairs) {
      if (a.len !== 2) continue;
      if (cleanPairInner(seg.slice(a.start + a.len, b.start))) continue;
      const e = orphanCloseEdit(seg, a.start);
      if (e) out.push(e);
      break; // satu kandidat per ronde (DFS mengeksplorasi)
    }
  }
  // 3) sisa ganjil: coba jadi penutup orphan, lalu pembuka orphan
  if (out.length === 0 && leftover && leftover.len === 2) {
    const e = orphanCloseEdit(seg, leftover.start);
    if (e) out.push(e);
    const f = orphanOpenEdit(seg, leftover.start + leftover.len);
    if (f) out.push(f);
  }
  return out;
}

/** DFS: terapkan kandidat satu per satu; HANYA diterima bila hasil akhirnya
 *  bersih total (semua pasangan sehat) — jika tidak, rollback penuh. */
function solveMathRepair(seg: string, depth: number): string | null {
  if (isFullyClean(seg)) return seg;
  if (depth <= 0) return null;
  for (const e of candidatesFor(seg)) {
    const trial = seg.slice(0, e.pos) + e.insert + seg.slice(e.pos);
    const r = solveMathRepair(trial, depth - 1);
    if (r !== null) return r;
  }
  return null;
}

/** Perbaiki pembatas $/$$ rusak (orphan / panjang beda / jumlah ganjil).
 *  Teks yang tak bisa diselesaikan dibiarkan APA ADANYA (aman). */
export function repairMathDelimiters(seg: string): string {
  if (!seg.includes("$")) return seg;
  const runs = collectDollarRuns(seg);
  if (runs.length < 1 || runs.some((r) => r.len > 2)) return seg;
  if (isFullyClean(seg)) return seg;
  return solveMathRepair(seg, 3) ?? seg;
}

/** Untuk balanceMath saat streaming: apakah "$$" terakhir tampak seperti
 *  PEMBUKA yang belum ditutup (perlu "$$" tambahan)? Jika ia penutup
 *  orphan (pembuka hilang dari model), JANGAN ditutup — biarkan
 *  repairMathDelimiters yang membetulkan pasangannya. */
export function mathTailNeedsClosing(s: string): boolean {
  const runs = collectDollarRuns(s);
  if (runs.length === 0 || runs.length % 2 === 0) return false;
  const last = runs[runs.length - 1];
  if (last.len !== 2) return false;
  const after = s.slice(last.start + last.len);
  if (after.trim() !== "" && PROSE_WORD.test(after)) return false; // prosa → bukan isi rumus
  // Ada badan rumus SEBELUM $$ → ia penutup orphan, bukan pembuka.
  if (orphanCloseEdit(s, last.start)) return false;
  return true;
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
  // _ ^ \ (LaTeX/subskrip), $$ (pembatas display), atau kurung siku berisi
  // "=" (mis. "[ Q = 180 ]").
  return /[_^\\]|\$\$|\[[^\[\]]*=|\[\s*$/.test(content);
}

// ── Tahap 5 (Task 31): rumus display panjang → blok $$\n…\n$$ ────────

/** Perintah yang butuh ruang besar — sinyal rumus "display". */
const DISPLAY_CMDS =
  /\\(?:frac|dfrac|tfrac|binom|sum|prod|int|begin|cases|array|matrix|aligned)/;

/** Pasangan $$…$$ ber-perintah besar & cukup panjang diubah jadi blok
 *  display (baris sendiri) supaya KaTeX merender ukuran penuh & enak dibaca.
 *  Rumus pendek / tanpa perintah besar tetap inline. */
function displayifyLongMath(seg: string): string {
  if (!seg.includes("$$")) return seg;
  let out = "";
  let i = 0;
  while (i < seg.length) {
    if (seg.startsWith("$$", i)) {
      const close = seg.indexOf("$$", i + 2);
      if (close === -1) {
        out += seg.slice(i);
        break;
      }
      const inner = seg.slice(i + 2, close).trim();
      if (
        inner &&
        !inner.includes("\n") &&
        inner.length >= 12 &&
        DISPLAY_CMDS.test(inner) &&
        pairLooksLikeMath(inner)
      ) {
        out += `\n\n$$\n${inner}\n$$\n\n`;
        i = close + 2;
        continue;
      }
      out += "$$";
      i += 2;
      continue;
    }
    out += seg[i];
    i++;
  }
  return out;
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
        : displayifyLongMath(
            wrapBareFormulas(
              wrapBracketMath(repairMathDelimiters(normalizeMathDelimiters(p)))
            )
          )
    )
    .join("");
}
