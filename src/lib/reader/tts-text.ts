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
  /^\s*(?:hal(?:aman)?\.?\s*)?(?:\d{1,4}|[ivxlcdm]{1,6}|[IVXLCDM]{1,6})\s*[.\-–]?\s*$/i;

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
