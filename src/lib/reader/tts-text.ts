// ─────────────────────────────────────────────────────────────────────
// tts-text.ts — Perapi teks untuk fitur "Bacakan" (TTS) Aula Reader.
//
// Task 29: teks yang dibacakan harus enak DIDENGAR, bukan sekadar
// dibaca mentah dari lapisan teks PDF / hasil OCR vision:
//   • Footnote: penanda nomor kecil (¹ ² ³ / [1] / 1)) DILEPAS dari
//     tengah kalimat; penjelasannya di bawah halaman dibacakan sebagai
//     "Catatan kaki nomor satu: …" SETELAH isi halaman.
//   • Tabel markdown → dibaca baris per baris ("kolom: a, b, c").
//   • Difilter: nomor halaman, judul buku/bab berulang (running
//     header/footer), ISBN, alamat penerbit — khas buku pelajaran.
//   • Rumus LaTeX ($V_p I_p = V_s I_s$) → bentuk terbaca: "V sub p kali
//     I sub p sama dengan V sub s kali I sub s".
//   • Simbol matematika & tanda baca aneh → kata ("=", "%", "°", "→").
//
// Murni fungsi string — tanpa dependensi → aman dipakai di client
// (pdf-reader / text-reader / image-reader / selection-actions).
// ─────────────────────────────────────────────────────────────────────

/** Baris yang HANYA nomor halaman (arab / romawi / "Halaman 12"). */
const PAGE_NUM_LINE =
  /^\s*(?:hal(?:aman)?\.?\s*)?(?:\d{1,4}|[ivxlcdm]{1,6}|[IVXLCDM]{1,6})\s*[.\-–—]?\s*$/i;

/** Nomor halaman dengan peluru di kiri-kanan (khas footer buku: "• 12 •"). */
const PAGE_NUM_BULLETS =
  /^\s*[•·|–—-]?\s*(?:\d{1,4}|[ivxlcdm]{1,6})\s*[•·|–—-]?\s*$/i;

/** "Halaman 12 dari 120" / "hal. 12" utuh di satu baris. */
const PAGE_NUM_RANGE =
  /^\s*hal(?:aman|\.)?\s+\d{1,4}\s+(?:dari|of|\/)\s+\d{1,4}\s*\.?\s*$/i;

/** Nomor subbab sendirian: "3.2", "A.1", "12.3.4". */
const SECTION_NUM_LINE =
  /^\s*(?:\d+(?:\.\d+){1,3}|[A-Ga-g][.)])\s*\.?\s*$/;

/** Lepas token nomor halaman yang MENEMPel di awal/akhir baris teks
 *  (gaya "136 | Fisika SMA Kelas X" / "Kata Pengantar 136"). */
function stripInlinePageNum(line: string): string {
  let t = line;
  t = t.replace(/^\s*(?:\d{1,4}|[ivxlcdm]{1,6})\s*[|·•]\s*(?=\S)/i, "");
  t = t.replace(/\s*[|·•]\s*(?:\d{1,4}|[ivxlcdm]{1,6})\s*$/i, "");
  // "— 128 —" gaya em-dash di awal baris.
  t = t.replace(/^\s*[—–-]\s*\d{1,4}\s*[—–-]\s*/, "");
  return t;
}

/** Baris terlihat seperti JUDUL (heading) → dibacakan dengan jeda. */
function isHeadingLine(line: string): boolean {
  const t = line.trim();
  if (t.length < 4 || t.length > 70) return false;
  if (!/[a-zA-Zà-ÿ]/.test(t)) return false; // harus ada huruf
  if (/[.!?;:]$/.test(t)) return false; // kalimat berakhir normal → bukan judul
  const words = t.split(/\s+/);
  if (words.length > 10) return false; // terlalu panjang utk judul
  if (/^(?:bab|unit|kegiatan|latihan|ringkasan|rangkuman|tujuan|soal|ujian|evaluasi|kesimpulan|peta\s+konsep|ulasan|tugas)\b/i.test(t))
    return true;
  // HURUF KAPITAL SEMUA (judul bab khas buku pelajaran).
  const letters = t.replace(/[^a-zA-Zà-ÿ]/g, "");
  if (letters.length >= 4 && letters === letters.toUpperCase()) return true;
  // Kapital di tiap kata penting (Title Case) & pendek.
  const capWords = words.filter((w) => /^[A-ZÀ-Ý]/.test(w));
  if (t.length <= 60 && capWords.length >= Math.max(2, Math.ceil(words.length * 0.6))) return true;
  return false;
}

/** Pola running header/footer buku pelajaran umum (konservatif). */
const RUNNING_HEAD =
  /^\s*(?:isbn[\s\d\-–x]+|hak\s+cipta\b.{0,80}|copyright\s*©?\s*\d{4}.{0,60}|(?:ditulis|di\s+tulis|penulis|editor|ilustrator|perancang\s+kemasan|fotografer)\s*:\s*.{0,60}|bab\s+(?:\d|[ivxlcdm]+)\s*[:\-—.]?\s*$|.{0,60}\b(?:fisika|matematika|biologi|kimia|sejarah|geografi|ekonomi|sosiologi|antropologi|bahasa\s+indonesia|bahasa\s+inggris|pa\s?kp|ppkn|pkn|pjok|penjas|ipa|ips|tik|informatika|prakarya|seni\s+budaya|agama)\b.{0,50}\b(?:sma|smp|smk|mts|ma\b|sd|mi\b|kelas\s+\S+)\b.{0,40}|.{0,70}\b(?:sma\/ma|sma\/smk|smp\/mts|smk\/mak|sd\/mi)\b.{0,40}\bkelas\s+(?:\d{1,2}|vii|viii|ix|xi|xii)\b.{0,40})\s*$/i;

const GREEK: Record<string, string> = {
  alpha: "alpha", beta: "beta", gamma: "gamma", delta: "delta",
  epsilon: "epsilon", theta: "theta", lambda: "lambda", mu: "mu",
  pi: "pi", rho: "rho", sigma: "sigma", tau: "tau", phi: "phi",
  omega: "omega", Delta: "delta besar", Sigma: "sigma besar",
  Omega: "omega besar", Phi: "phi besar", Theta: "theta besar",
  Lambda: "lambda besar",
};

const LATEX_SYMBOLS: [RegExp, string][] = [
  [/\\times|\\cdot/g, " kali "],
  [/\\div/g, " bagi "],
  [/\\pm/g, " plus minus "],
  [/\\leq?|\\leqslant/g, " kurang dari sama dengan "],
  [/\\geq?|\\geqslant/g, " lebih dari sama dengan "],
  [/\\neq?/g, " tidak sama dengan "],
  [/\\approx|\\cong/g, " kira-kira sama dengan "],
  [/\\infty/g, " tak hingga "],
  [/\\degree|\\circ/g, " derajat "],
  [/\\sqrt\s*\{([^{}]*)\}/g, " akar dari $1 "],
  [/\\sqrt/g, " akar "],
  [/\\frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, " $1 per $2 "],
  [/\\dfrac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, " $1 per $2 "],
  [/\\sum/g, " sigma "],
  [/\\int/g, " integral "],
  [/\\lim/g, " limit "],
  [/\\log/g, " log "],
  [/\\ln/g, " ln "],
  [/\\sin/g, " sinus "],
  [/\\cos/g, " cosinus "],
  [/\\tan/g, " tangen "],
  [/\\to|\\rightarrow/g, " menuju "],
  [/\\left|\\right|\\!|\\,|\\;|\\quad|\\qquad|\\displaystyle|\\text\b|\\mathrm\b|\\mathit\b/g, " "],
];

/** Superskrip unicode → bentuk ucapan (¹ = penanda footnote → hilang). */
const SUB_SUP: Record<string, string> = {
  "¹": "", "²": " pangkat dua ", "³": " pangkat tiga ", "⁴": " pangkat empat ",
  "⁵": " pangkat lima ", "⁶": " pangkat enam ", "⁰": " pangkat nol ",
  "⁷": " pangkat tujuh ", "⁸": " pangkat delapan ", "⁹": " pangkat sembilan ",
};

/** Angka → kata (untuk "Catatan kaki nomor satu"). */
const NUM_WORDS = [
  "nol", "satu", "dua", "tiga", "empat", "lima", "enam", "tujuh",
  "delapan", "sembilan", "sepuluh", "sebelas",
];
function numToWord(n: number): string {
  if (n >= 0 && n < NUM_WORDS.length) return NUM_WORDS[n];
  return String(n);
}

/** Ubah satu potongan LaTeX ($...$) jadi bentuk terbaca TTS. */
function latexToSpeech(s: string): string {
  let t = s.replace(/^\$+|\$+$/g, "");
  for (const [re, rep] of LATEX_SYMBOLS) t = t.replace(re, rep);
  for (const [k, v] of Object.entries(GREEK)) {
    t = t.replace(new RegExp("\\\\" + k + "\\b", "g"), " " + v + " ");
  }
  // Pangkat / subskrip — bentuk brace dan bentuk satu karakter (V_p, x^2).
  t = t.replace(/\^\{([^{}]*)\}/g, " pangkat $1 ");
  t = t.replace(/\^([A-Za-z0-9]+)/g, " pangkat $1 ");
  t = t.replace(/_\{([^{}]*)\}/g, " sub $1 ");
  t = t.replace(/_([A-Za-z0-9]+)/g, " sub $1 ");
  // Simbol sisa.
  t = t.replace(/[{}]/g, " ");
  t = t.replace(/\s+/g, " ").trim();
  return t;
}

/** Ganti semua $...$ / $$...$$ dalam teks dengan bentuk terbaca. */
function mathToSpeech(text: string): string {
  return text
    .replace(/\$\$([\s\S]*?)\$\$/g, (_, m) => " " + latexToSpeech(m) + " ")
    .replace(/\$([^$\n]*?)\$/g, (_, m) => " " + latexToSpeech(m) + " ");
}

/** Penggantian simbol umum → kata (dipakai body DAN catatan kaki). */
function symbolsToSpeech(t: string): string {
  return t
    .replace(/=/g, " sama dengan ")
    .replace(/\+/g, " plus ")
    .replace(/%/g, " persen ")
    .replace(/°/g, " derajat ")
    .replace(/→/g, " menjadi ")
    .replace(/≈|≅/g, " kira-kira sama dengan ")
    .replace(/±/g, " plus minus ")
    .replace(/•|·/g, ", ")
    .replace(/_{2,}/g, " ")
    .replace(/×/g, " kali ")
    .replace(/÷/g, " bagi ");
}

/** Baris tabel markdown → kalimat terbaca per baris. */
function tableRowToSpeech(line: string): string | null {
  const cells = line
    .split("|")
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
  if (!cells.length) return null;
  // Baris pemisah |---|---| → lewati.
  if (cells.every((c) => /^:?-{2,}:?$/.test(c))) return "";
  return cells.join(", ");
}

export interface CleanedTts {
  /** Teks utama siap dibacakan (footnote sudah dibuang dari sini). */
  body: string;
  /** Catatan kaki terkumpul dari bawah halaman — dibacakan setelah body. */
  footnotes: string[];
}

/**
 * Rapikan teks halaman untuk dibacakan.
 * Mengembalikan body + catatan kaki terpisah supaya pemanggil bisa
 * mengucapkan "Catatan kaki:…" dengan jeda.
 */
export function cleanForTtsParts(raw: string): CleanedTts {
  if (!raw) return { body: "", footnotes: [] };
  const lines = raw.split(/\r?\n/);
  const bodyLines: string[] = [];
  const footnotes: string[] = [];

  for (let line of lines) {
    const trimmed = line.trim();

    // Placeholder halaman gambar dari OCR vision.
    if (/^\[halaman (gambar|kosong|ini gagal)/i.test(trimmed)) continue;

    // Nomor halaman sendirian / pola running header-footer buku.
    if (PAGE_NUM_LINE.test(trimmed)) continue;
    if (PAGE_NUM_BULLETS.test(trimmed)) continue;
    if (PAGE_NUM_RANGE.test(trimmed)) continue;
    if (SECTION_NUM_LINE.test(trimmed)) continue;
    // Nomor halaman menempel di awal baris ("136 | Fisika …") → lepas
    // dulu, lalu uji ulang sebagai nomor murni / running header.
    const stripped = stripInlinePageNum(trimmed);
    if (stripped !== trimmed) {
      if (!stripped.trim()) continue; // ternyata murni nomor halaman
      if (PAGE_NUM_LINE.test(stripped)) continue;
      if (RUNNING_HEAD.test(stripped)) continue;
      line = stripped;
    }
    if (RUNNING_HEAD.test(trimmed)) continue;

    // Baris catatan kaki di bagian bawah: "1) penjelasan",
    // "Catatan kaki (1): …", "1 – penjelasan".
    const fnLabel =
      /^(?:catatan\s+kaki\s*[(\[]?\s*(\d+)\s*[)\]]?\s*[:.]\s*|(\d)\s*[).]\s+|(\d)\s*[-–]\s+)/i.exec(trimmed);
    if (fnLabel) {
      const n = fnLabel[1] ?? fnLabel[2] ?? fnLabel[3];
      const rest = trimmed.slice(fnLabel[0].length).trim();
      if (rest.length > 3) {
        footnotes.push(
          `Catatan kaki nomor ${numToWord(parseInt(n, 10))}: ${rest}`
        );
        continue;
      }
    }

    // Tabel markdown → baris terbaca.
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const spoken = tableRowToSpeech(line);
      if (spoken !== null) {
        if (spoken) bodyLines.push(spoken);
        continue;
      }
    }

    bodyLines.push(line);
  }

  // Susun body.
  let body = bodyLines.join("\n");
  // Rumus LaTeX / simbol → bentuk terbaca.
  body = mathToSpeech(body);
  // Penanda superskrip footnote di tengah kalimat (¹ ² ³ dan bracket [1]).
  body = body.replace(/[\u00b9\u00b2\u00b3\u2070-\u209f]/g, (ch) => SUB_SUP[ch] ?? "");
  body = body.replace(/\s*\[\d{1,2}\](?=\s|[.,;:!?]|$)/g, " ");
  body = body.replace(/(?<=\w)\s*\(\s*[1-9]\s*\)\s*(?=\s*[A-Z])/g, " ");
  // Heading markdown → polos.
  body = body.replace(/^\s{0,3}#{1,6}\s+/gm, "");
  body = body.replace(/\*\*([^*]+)\*\*/g, "$1").replace(/\*([^*]+)\*/g, "$1");
  body = body.replace(/`([^`]+)`/g, "$1");
  body = body.replace(/\[([^\]]+)\]\((?:https?:\/\/|\/)[^)]*\)/g, "$1");
  // Simbol umum.
  body = symbolsToSpeech(body);
  // Spasi berulang & baris kosong bertumpuk.
  body = body.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();

  const cleanedFootnotes = footnotes
    .map((f) =>
      symbolsToSpeech(mathToSpeech(f)).replace(/\s+/g, " ").trim())
    .filter(Boolean);

  return { body, footnotes: cleanedFootnotes };
}

/** Bentuk gabungan siap pakai: body + jeda + catatan kaki. */
export function cleanForTts(raw: string): string {
  const { body, footnotes } = cleanForTtsParts(raw);
  if (!footnotes.length) return body;
  return `${body}\n\n${footnotes.join(". ")}.`;
}

/**
 * Potong teks bersih menjadi potongan kalimat (≤ maxChar) untuk antrean
 * utterance — mulai cepat & bisa berhenti di tengah halus.
 */
export function splitTtsChunks(
  raw: string,
  max = 220
): string[] {
  const text = raw.replace(/\s+/g, " ").trim();
  if (!text) return [];
  const sentences = text.match(/[^.!?…]+[.!?…]*\s*/g) ?? [text];
  const out: string[] = [];
  let cur = "";
  for (const s of sentences) {
    const piece = s.trim();
    if (!piece) continue;
    if ((cur + " " + piece).trim().length > max && cur) {
      out.push(cur.trim());
      cur = piece;
    } else {
      cur = (cur + " " + piece).trim();
    }
    // Kalimat tunggal raksasa (mis. deretan rumus) → potong paksa di koma.
    while (cur.length > max) {
      let cut = cur.lastIndexOf(",", max);
      if (cut < max * 0.5) cut = max;
      out.push(cur.slice(0, cut).trim());
      cur = cur.slice(cut).replace(/^,\s*/, "").trim();
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

// ── Task 31: potongan dengan JEDA + grouping baris lapisan teks PDF ──

export interface TtsChunk {
  /** Teks yang diucapkan. */
  text: string;
  /** Jeda SETELAH potongan ini selesai (ms) — judul/paragraf/list. */
  pauseAfterMs?: number;
}

/** Jeda setelah potongan yang merupakan JUDUL (bab/subbab). */
const HEADING_PAUSE_MS = 700;
/** Jeda antar paragraf (baris kosong). */
const PARAGRAPH_PAUSE_MS = 450;
/** Jeda antar butir daftar (• / 1. / a. — satu baris satu butir). */
const LIST_PAUSE_MS = 280;

/** Butir daftar: "• teks", "1. teks", "a. teks", "- teks". */
const LIST_ITEM = /^\s*(?:[•·*-]|\d{1,2}[.)]|[a-g][.)])\s+\S/;

/**
 * Susun potongan TTS dengan JEDA NATURAL:
 *   • baris JUDUL → potongan sendiri + jeda 700 ms (judul TIDAK
 *     "nyambung" dibacakan dengan paragraf di bawahnya);
 *   • akhir paragraf → jeda 450 ms;
 *   • butir daftar → jeda 280 ms antar butir.
 * Input adalah hasil cleanForTts (baris dipertahankan dengan \n).
 */
export function buildTtsChunks(raw: string, max = 220): TtsChunk[] {
  const lines = String(raw ?? "").split(/\r?\n/);
  const out: TtsChunk[] = [];
  let paraBuf: string[] = [];
  let paraIsHeading = false;
  let paraIsList = false;

  const flushParagraph = () => {
    if (!paraBuf.length) return;
    const para = paraBuf.join(" ").replace(/\s+/g, " ").trim();
    paraBuf = [];
    if (!para) return;
    // Kalimat-kalimat paragraf → potongan ≤ max.
    const sentences = para.match(/[^.!?…]+[.!?…]*\s*/g) ?? [para];
    let cur = "";
    const pushCur = (pause?: number) => {
      const t = cur.trim();
      cur = "";
      if (t) out.push(pause ? { text: t, pauseAfterMs: pause } : { text: t });
    };
    for (const s of sentences) {
      const piece = s.trim();
      if (!piece) continue;
      if ((cur + " " + piece).trim().length > max && cur) {
        pushCur();
        cur = piece;
      } else {
        cur = (cur + " " + piece).trim();
      }
      while (cur.length > max) {
        let cut = cur.lastIndexOf(",", max);
        if (cut < max * 0.5) cut = max;
        const t = cur.slice(0, cut).trim();
        if (t) out.push({ text: t });
        cur = cur.slice(cut).replace(/^,\s*/, "").trim();
      }
    }
    pushCur(
      paraIsHeading
        ? HEADING_PAUSE_MS
        : paraIsList
          ? LIST_PAUSE_MS
          : PARAGRAPH_PAUSE_MS
    );
    paraIsHeading = false;
    paraIsList = false;
  };

  for (const line of lines) {
    const t = line.trim();
    if (!t) {
      flushParagraph();
      continue;
    }
    const heading = isHeadingLine(t);
    if (heading) {
      flushParagraph(); // judul selalu potongan sendiri
      out.push({ text: t, pauseAfterMs: HEADING_PAUSE_MS });
      continue;
    }
    if (LIST_ITEM.test(t) && t.length <= max) {
      // Satu baris = satu butir — jeda kecil antar butir.
      flushParagraph();
      out.push({ text: t, pauseAfterMs: LIST_PAUSE_MS });
      paraIsList = true;
      continue;
    }
    paraIsList = paraIsList || LIST_ITEM.test(t);
    paraBuf.push(t);
    // Baris panjang (tanpa baris kosong pemisah — khas PDF) → anggap
    // pergantian paragraf bila baris berakhiran tanda baca lengkap.
    if (paraBuf.length > 1 && /[.!?:]$/.test(t)) {
      flushParagraph();
    }
  }
  flushParagraph();

  // Jeda terakhir tidak perlu.
  if (out.length) {
    const last = out[out.length - 1];
    delete last.pauseAfterMs;
  }
  return out.filter((c) => c.text);
}

/** Antarmuka item teks pdf.js (str + posisi y di transform). */
export interface PdfTextItemLike {
  str?: string;
  hasEOL?: boolean;
  transform?: number[];
}

/**
 * Susun item teks pdf.js menjadi BARIS teks (dipisah "\n") berdasarkan
 * koordinat-y transform — BUKAN digabung rata dengan spasi. Tanpa ini
 * seluruh halaman jadi SATU baris panjang: nomor halaman, judul bab,
 * running header tidak pernah cocok dengan filter baris, dan judul
 * "menyambung" dibacakan dengan paragraf (bug Task 31).
 */
export function groupPdfTextItems(items: PdfTextItemLike[]): string {
  const lines: string[] = [];
  let cur = "";
  let curY: number | null = null;
  for (const it of items) {
    const s = it.str ?? "";
    const y = Array.isArray(it.transform) && it.transform.length >= 6
      ? it.transform[5]
      : null;
    if (curY !== null && y !== null && Math.abs(y - curY) > 2.5) {
      if (cur.trim()) lines.push(cur.trim());
      cur = "";
      curY = y;
    } else if (y !== null) {
      curY = y;
    }
    // Spasi antar item di baris yang sama (pdf.js kadang tanpa spasi).
    if (cur && s && !/\s$/.test(cur) && !/^\s/.test(s)) cur += " ";
    cur += s;
    if (it.hasEOL) {
      if (cur.trim()) lines.push(cur.trim());
      cur = "";
      curY = null;
    }
  }
  if (cur.trim()) lines.push(cur.trim());
  return lines.join("\n");
}
