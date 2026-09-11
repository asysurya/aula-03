// ─────────────────────────────────────────────────────────────────────────────
// src/lib/study/text-analysis.ts
//
// Alat analisis teks materi belajar — 100% PURE functions (tanpa React, tanpa
// DOM, tanpa API eksternal). Semua diproses lokal di browser.
//
// Ekspor (kontrak study-hub):
//   splitSentences(text)                → string[]
//   summarizeSentences(text, count)      → string[]   (top-N, urutan asli)
//   extractKeywords(text, count)         → { word, count }[]
//   generateFlashcards(text)             → { front, back }[]   (maks ±40)
//   generateQuiz(text)                   → { type, question, answer, distractors }[] (maks ±20)
//   buildOutline(text)                   → { text, children }[] (peta konsep)
// ─────────────────────────────────────────────────────────────────────────────

/** Node peta konsep (rekursif). */
export interface OutlineNode {
  text: string
  children: OutlineNode[]
}

// ────────────────────────────────── Stopwords ───────────────────────────────
// Stopwords bahasa Indonesia (≥100 kata) — kata umum yang tidak membawa makna
// inti materi sehingga diabaikan saat menghitung frekuensi kata.
const STOPWORDS: Set<string> = new Set([
  // kopula & partikel
  "yang", "adalah", "ialah", "yaitu", "yakni", "merupakan", "menjadi", "ada",
  "itu", "ini", "tersebut", "demikian", "begitu", "begini", "tersebut",
  // konjungsi
  "dan", "atau", "serta", "karena", "sebab", "sehingga", "agar", "supaya",
  "bahwa", "jika", "kalau", "apabila", "maka", "ketika", "saat", "sewaktu",
  "tetapi",
  "tapi", "namun", "sedangkan", "sementara", "selain", "adapun", "apalagi",
  "malah", "malahan", "bahkan", "hanya", "saja", "juga", "pula", "pun",
  "kemudian", "lalu", "selanjutnya", "setelah", "sebelum", "sejak", "selama",
  "hingga", "sampai",
  // preposisi
  "di", "ke", "dari", "pada", "dalam", "kepada", "terhadap", "oleh", "bagi",
  "untuk", "tentang", "mengenai", "antara", "diantara", "dengan", "tanpa",
  "sebagai", "seperti", "bagaikan", "laksana", "sebagaimana", "daripada",
  "disekitar", "melalui", "secara", "berupa", "berbagai", "terutama",
  // pronomina
  "saya", "aku", "kami", "kita", "kamu", "kau", "engkau", "anda", "dia",
  "ia", "beliau", "mereka", "nya", "punya", "milik", "sendiri", "siapa",
  "apa", "mengapa", "kenapa", "bagaimana", "kapan", "dimana", "mana",
  // modal & keterangan umum
  "dapat", "bisa", "mampu", "sanggup", "harus", "wajib", "perlu", "mungkin",
  "biasanya", "umumnya", "sering", "kadang", "telah", "sudah", "akan",
  "sedang", "belum", "tidak", "bukan", "jangan", "sangat", "amat", "cukup",
  "sekali", "lebih", "paling", "terlalu", "kembali", "lagi",
  // kuantitas & penanda lain
  "para", "semua", "seluruh", "setiap", "masing", "beberapa", "banyak",
  "sedikit", "sebagian", "lain", "lainnya", "sama", "contoh", "misalnya",
  "antara", "yaitu", "termasuk", "terdiri", "disebut", "disebutkan",
  "memiliki", "mempunyai", "karenanya", "akibatnya", "dengan",
])

// Singkatan umum bahasa Indonesia — kalimat TIDAK boleh diputus setelah
// singkatan ini (mis. "dll. Selanjutnya..." masih satu kalimat).
const ABBREVIATIONS: Set<string> = new Set([
  "dll", "dst", "dsb", "dkk", "dr", "ir", "prof", "no", "vol", "hal", "hlm",
  "a.m", "p.m", "jl", "jln", "tsb", "yth", "cs", "cp", "red", "s.pd", "s.t",
  "m.si", "s.h", "s.e", "s.kom",
])

// Baris yang merupakan judul/penanda struktur (heading markdown / nomor / butir)
const HEADING_LINE_RE = /^(?:#{1,6}\s|[-*•]\s|\d{1,3}[.)]\s|\d+(?:\.\d+)+\s)/
// Baris yang HANYA berisi penanda daftar ("1." / "-" / "•")
const MARKER_ONLY_RE = /^(?:\d{1,3}[.)]?|[-*•])$/

/** Batas minimum materi agar fitur generate aktif (lihat isMaterialTooShort). */
const MIN_CHARS = 200
const MIN_SENTENCES = 3

/**
 * Materi dianggap terlalu pendek bila < 200 karakter atau < 3 kalimat.
 * Semua fungsi generator mengembalikan [] bila materi belum cukup.
 */
function isMaterialTooShort(text: string): boolean {
  if (!text || text.trim().length < MIN_CHARS) return true
  return splitSentences(text).length < MIN_SENTENCES
}

/** Escape karakter spesial regex pada kata yang akan disisipkan ke RegExp. */
function escapeRegExp(word: string): string {
  return word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

// ─────────────────────────────── splitSentences ─────────────────────────────

/**
 * Pecah teks menjadi daftar kalimat.
 *
 * Strategi:
 * - Diproses per baris agar struktur daftar/heading tidak "bocor" antar baris.
 * - Baris yang tidak diakhiri tanda baca digabung dengan baris berikutnya
 *   (menangani teks hard-wrap), KECUALI bila baris berikutnya adalah
 *   heading/penanda baru.
 * - Penanda daftar di awal baris ("1. ", "- ", "• ") dibuang.
 * - Kalimat dipotong pada . ! ? yang diikuti spasi (desimal "25.5" aman).
 * - Fragmen singkat (nomor / singkatan seperti "No.", "dll.") digabung ke
 *   bagian berikutnya agar tidak menjadi "kalimat" sampah.
 */
export function splitSentences(text: string): string[] {
  if (!text || !text.trim()) return []
  const lines = text.split(/\r?\n/)
  const sentences: string[] = []

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].replace(/[ \t]+/g, " ").trim()
    if (!line) continue

    // Gabungkan baris terpotong dengan baris berikutnya (hard-wrap).
    while (
      i + 1 < lines.length &&
      !HEADING_LINE_RE.test(line) && // baris ini sendiri heading/penanda
      !/[.!?:;"”'’)\]]$/.test(line) && // belum berakhir penutup kalimat
      !MARKER_ONLY_RE.test(lines[i + 1].trim()) && // berikutnya bukan penanda murni
      !HEADING_LINE_RE.test(lines[i + 1].replace(/[ \t]+/g, " ").trim()) // berikutnya bukan heading/poin baru
    ) {
      const next = lines[i + 1].replace(/[ \t]+/g, " ").trim()
      if (!next) break
      line = `${line} ${next}`
      i++
    }

    // Buang penanda daftar di awal baris ("1. ", "- ", "• ").
    line = line.replace(/^(?:\d{1,3}[.)]|[-*•])\s+/, "")

    // Pecah per terminator (. ! ?) yang diikuti spasi.
    const parts: string[] = []
    let current = ""
    for (let c = 0; c < line.length; c++) {
      const ch = line[c]
      current += ch
      if (ch === "." || ch === "!" || ch === "?") {
        // Konsumsi terminator beruntun ("!!", "?!", "...")
        while (
          c + 1 < line.length &&
          (line[c + 1] === "." || line[c + 1] === "!" || line[c + 1] === "?")
        ) {
          c++
          current += line[c]
        }
        if (line[c + 1] === " ") {
          if (current.trim()) parts.push(current.trim())
          current = ""
        }
      }
    }
    if (current.trim()) parts.push(current.trim())

    // Gabungkan fragmen singkat (nomor / singkatan) ke bagian berikutnya.
    const merged: string[] = []
    for (let p = 0; p < parts.length; p++) {
      const bare = parts[p].replace(/[.!?]+$/, "").trim().toLowerCase()
      const isShortNumber = /^\d{1,3}$/.test(bare)
      const isAbbrev = ABBREVIATIONS.has(bare)
      if ((isShortNumber || isAbbrev) && p + 1 < parts.length) {
        parts[p + 1] = `${parts[p]} ${parts[p + 1]}`
        continue
      }
      merged.push(parts[p])
    }

    for (const s of merged) {
      // Simpan hanya potongan yang benar-benar berisi huruf/angka.
      if (s && /[a-z0-9à-ÿ]/i.test(s)) sentences.push(s)
    }
  }

  return sentences
}

// ────────────────────────── Frekuensi & kata kunci ──────────────────────────

/**
 * Tokenisasi: huruf kecil, buang tanda baca, pisah per spasi/hyphen.
 * Hyphen ikut dipisah ("kata-kata" → "kata", "kata") agar akar kata terhitung.
 */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-zà-ÿ0-9\s-]/g, " ")
    .split(/[\s-]+/)
    .filter(Boolean)
}

/** Kata layak dihitung: ≥3 huruf, bukan stopword/angka murni/karakter berulang. */
function isContentWord(word: string): boolean {
  if (word.length < 3) return false
  if (STOPWORDS.has(word)) return false
  if (/^\d+$/.test(word)) return false
  if (/^(.)\1+$/.test(word)) return false // "aaa", "000"…
  return true
}

/** Peta frekuensi kata bermakna pada teks. */
function wordFrequency(text: string): Map<string, number> {
  const freq = new Map<string, number>()
  for (const w of tokenize(text)) {
    if (!isContentWord(w)) continue
    freq.set(w, (freq.get(w) ?? 0) + 1)
  }
  return freq
}

/**
 * Kata kunci utama materi, diurutkan frekuensi tertinggi.
 * Tie-break: kata lebih panjang diprioritaskan (lebih informatif).
 */
export function extractKeywords(
  text: string,
  count: number
): { word: string; count: number }[] {
  const limit = Math.max(0, Math.floor(count))
  if (limit === 0) return []
  const freq = wordFrequency(text)
  return Array.from(freq.entries())
    .sort(
      (a, b) =>
        b[1] - a[1] || b[0].length - a[0].length || a[0].localeCompare(b[0])
    )
    .slice(0, limit)
    .map(([word, c]) => ({ word, count: c }))
}

// ───────────────────────────── summarizeSentences ───────────────────────────

/**
 * Rangkuman ekstraktif: ambil N kalimat teratas berdasarkan skor frekuensi
 * kata (kata bermakna dihitung dari seluruh materi), dinormalisasi panjang,
 * lalu dikembalikan dalam URUTAN ASLI teks.
 */
export function summarizeSentences(text: string, count: number): string[] {
  if (isMaterialTooShort(text)) return []
  const sentences = splitSentences(text)
  const freq = wordFrequency(text)

  const scored = sentences.map((sentence, index) => {
    const words = tokenize(sentence).filter(isContentWord)
    const unique = new Set(words) // kata ganda dalam 1 kalimat tidak double skor
    let raw = 0
    unique.forEach((w) => {
      raw += freq.get(w) ?? 0
    })
    // Normalisasi panjang: dibagi akar jumlah kata agar kalimat panjang
    // tidak otomatis menang, tapi tetap sedikit dihargai kelengkapannya.
    const score = raw / Math.sqrt(Math.max(words.length, 1))
    return { index, sentence, score }
  })

  const n = Math.max(1, Math.min(Math.floor(count), sentences.length))
  return scored
    .slice()
    .sort((a, b) => b.score - a.score) // ambil skor tertinggi…
    .slice(0, n)
    .sort((a, b) => a.index - b.index) // …lalu urutkan sesuai posisi asli
    .map((x) => x.sentence)
}

// ───────────────────────────── generateFlashcards ──────────────────────────

/** Kapitalkan huruf pertama (untuk istilah di sisi depan kartu). */
function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1)
}

/**
 * Buat deck flashcard (maks ±40) dengan tiga strategi:
 *  a. Definisi  — kalimat berpola "X adalah/yaitu/ialah/merupakan Y"
 *                 (X = frasa ≤ 8 kata) → depan: "Apa itu X?"
 *  b. Cloze     — kalimat dengan kata kunci tersering disamarkan "…"
 *  c. Istilah   — kata berkapital di tengah kalimat / akronim / istilah
 *                 teknikal berulang → depan: "Jelaskan: istilah"
 */
export function generateFlashcards(
  text: string
): { front: string; back: string }[] {
  if (isMaterialTooShort(text)) return []
  const sentences = splitSentences(text)
  const cards: { front: string; back: string }[] = []
  const seenFronts = new Set<string>()

  const push = (front: string, back: string) => {
    if (cards.length >= 40) return
    const key = front.toLowerCase().replace(/\s+/g, " ").trim()
    if (!key || !back || seenFronts.has(key)) return
    seenFronts.add(key)
    cards.push({ front, back })
  }

  // ── a) Pola definisi ──
  const defRe = /^(?:\d{1,3}[.)]\s*)?([^:]{2,120}?)\s+(adalah|yaitu|ialah|merupakan)\s+(.{10,})$/i
  for (const s of sentences) {
    if (cards.length >= 40) break
    const m = s.match(defRe)
    if (!m) continue
    // Bersihkan istilah: buang penanda & spasi ekstrem, tolak kalau terlalu panjang.
    const term = m[1]
      .replace(/^[-–—•*\s]+/, "")
      .replace(/[\s,;:–—-]+$/, "")
      .trim()
    const termWords = term.split(/\s+/).filter(Boolean)
    if (!term || termWords.length === 0 || termWords.length > 8) continue
    if (/[.!?]$/.test(term)) continue
    push(`Apa itu ${term}?`, s)
  }

  // ── b) Cloze: kata kunci tersering disamarkan ──
  const clozeWords = extractKeywords(text, 12)
    .map((k) => k.word)
    .filter((w) => w.length >= 4)
  for (const w of clozeWords) {
    if (cards.length >= 40) break
    const re = new RegExp(`\\b${escapeRegExp(w)}\\b`, "i")
    // Kalimat host harus cukup panjang agar lubang bermakna.
    const host = sentences.find((s) => s.length >= 40 && re.test(s))
    if (!host) continue
    const cloze = host.replace(
      new RegExp(`\\b${escapeRegExp(w)}\\b`, "gi"),
      "…"
    )
    push(cloze, w)
  }

  // ── c) Istilah: kata kapital di tengah kalimat / akronim ──
  const firstSentence = new Map<string, string>()
  const termFreq = new Map<string, number>()
  for (const s of sentences) {
    const tokens = s.split(/\s+/)
    for (let i = 1; i < tokens.length; i++) {
      // Kata pertama kalimat selalu kapital → lewati.
      const raw = tokens[i].replace(/[^A-Za-zÀ-ÿ0-9-]/g, "")
      const lower = raw.toLowerCase()
      if (raw.length < 4 || STOPWORDS.has(lower)) continue
      const isCapitalized = /^[A-ZÀ-Ý][a-zà-ÿ-]+$/.test(raw)
      const isAcronym = /^[A-ZÀ-Ý]{2,6}\d*$/.test(raw)
      if (!isCapitalized && !isAcronym) continue
      if (!firstSentence.has(lower)) firstSentence.set(lower, s)
      termFreq.set(lower, (termFreq.get(lower) ?? 0) + 1)
    }
  }
  const termCandidates = Array.from(termFreq.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
  for (const [term] of termCandidates) {
    if (cards.length >= 40) break
    const host = firstSentence.get(term)
    if (!host) continue
    push(`Jelaskan: ${capitalize(term)}`, host)
  }

  // ── c-lanjutan) Istilah teknikal berulang (huruf kecil, panjang, frek ≥ 2) ──
  // Hanya dipakai bila deck masih sangat sedikit, agar tidak duplikat cloze.
  if (cards.length < 12) {
    const freq = wordFrequency(text)
    const technical = Array.from(freq.entries())
      .filter(([w, c]) => c >= 2 && w.length >= 6)
      .sort((a, b) => b[1] - a[1])
    for (const [w] of technical) {
      if (cards.length >= 40) break
      const host = sentences.find((s) => s.toLowerCase().includes(w))
      if (!host) continue
      push(`Jelaskan: ${w}`, host)
    }
  }

  return cards.slice(0, 40)
}

// ─────────────────────────────── generateQuiz ───────────────────────────────

/**
 * Buat satu pernyataan SALAH dari kalimat asli:
 * ganti SATU kata kunci dengan kata kunci lain (yang belum ada di kalimat,
 * agar makna benar-benar berubah), atau naikkan satu angka bila tidak ada
 * kata kunci yang cocok.
 */
function makeFalseStatement(sentence: string, keywords: string[]): string | null {
  const lower = sentence.toLowerCase()
  for (const kw of keywords) {
    const re = new RegExp(`\\b${escapeRegExp(kw)}\\b`, "i")
    if (!re.test(sentence)) continue
    const other = keywords.find((k) => k !== kw && !lower.includes(k))
    if (!other) continue
    return sentence.replace(re, other)
  }
  const hasNumber = /\b\d+\b/.test(sentence)
  if (hasNumber) {
    const n = sentence.match(/\b\d+\b/)?.[0] ?? "0"
    const next = String(parseInt(n, 10) + 1)
    return sentence.replace(/\b\d+\b/, next)
  }
  return null
}

/**
 * Buat kuis (maks ±20 soal, campuran):
 *  a. fill — kata kunci pada kalimat diganti "_____" (jawaban = kata kunci,
 *     distraktor = 3 kata kunci lain dari extractKeywords).
 *  b. tf   — pernyataan BENAR (kalimat asli) atau SALAH (satu kata kunci/
 *     angka diganti). Soal fill & tf diseling agar urutannya variatif.
 */
export function generateQuiz(
  text: string
): {
  type: "fill" | "tf"
  question: string
  answer: string
  distractors: string[]
}[] {
  if (isMaterialTooShort(text)) return []
  const sentences = splitSentences(text)
  const keywords = extractKeywords(text, 18).map((k) => k.word)
  if (keywords.length < 2) return []

  const used = new Set<string>() // kalimat yang sudah dipakai soal lain
  const fills: {
    type: "fill"
    question: string
    answer: string
    distractors: string[]
  }[] = []
  const tfs: {
    type: "tf"
    question: string
    answer: string
    distractors: string[]
  }[] = []

  // Kalimat "layak soal" (cukup panjang) — dibagi agar soal fill tidak
  // menghabiskan semua kalimat dan soal benar/salah kekurangan bahan.
  const longSentences = sentences.filter((s) => s.length >= 40)
  const fillCap = Math.min(10, Math.max(1, Math.floor(longSentences.length / 2)))

  // ── a) Soal isian ──
  for (const kw of keywords) {
    if (fills.length >= fillCap) break
    const re = new RegExp(`\\b${escapeRegExp(kw)}\\b`, "i")
    const host = sentences.find(
      (s) => s.length >= 40 && !used.has(s) && re.test(s)
    )
    if (!host) continue
    used.add(host)
    const distractors = keywords.filter((k) => k !== kw).slice(0, 3)
    fills.push({
      type: "fill",
      question: host.replace(re, "_____"),
      answer: kw,
      distractors,
    })
  }

  // ── b) Soal benar/salah ──
  const rest = sentences.filter((s) => !used.has(s) && s.length >= 40)
  const targetTf = Math.min(
    10,
    Math.max(4, Math.min(20 - fills.length, Math.ceil(longSentences.length / 2)))
  )
  for (let i = 0; i < rest.length && tfs.length < targetTf; i++) {
    const s = rest[i]
    // Selang-seling salah/benar; hitung berjalan menjaga keseimbangan.
    const falseCount = tfs.filter((t) => t.answer === "Salah").length
    const trueCount = tfs.filter((t) => t.answer === "Benar").length
    if (falseCount <= trueCount) {
      const modified = makeFalseStatement(s, keywords)
      if (modified) {
        tfs.push({ type: "tf", question: modified, answer: "Salah", distractors: [] })
        used.add(s)
        continue
      }
    }
    tfs.push({ type: "tf", question: s, answer: "Benar", distractors: [] })
    used.add(s)
  }

  // Interleave fill ↔ tf, total maksimal 20.
  const quiz: {
    type: "fill" | "tf"
    question: string
    answer: string
    distractors: string[]
  }[] = []
  let fi = 0
  let ti = 0
  while (quiz.length < 20 && (fi < fills.length || ti < tfs.length)) {
    if (fi < fills.length) quiz.push(fills[fi++])
    if (quiz.length < 20 && ti < tfs.length) quiz.push(tfs[ti++])
  }
  return quiz
}

// ──────────────────────────────── buildOutline ──────────────────────────────

/**
 * Bangun outline/peta konsep hierarkis dari teks.
 *
 * Pola yang dikenali (prioritas: nomor > tanda > teks biasa):
 *  - Markdown heading  "## Judul"           → level = jumlah tanda #
 *  - Penomoran         "1." / "1.1" / "1)"  → level = kedalaman angka
 *  - Butir             "- " / "* " / "• "    → anak dari heading aktif
 *  - Baris berakhiran ":"                   → sub-judul di bawah heading aktif
 *  - Teks biasa                            → isi di bawah heading aktif
 *
 * Bila tidak ada pola struktur sama sekali → kalimat dikelompokkan per 3
 * menjadi "Bagian N" (anak = kalimat-kalimatnya).
 */
export function buildOutline(text: string): OutlineNode[] {
  if (isMaterialTooShort(text)) return []

  const lines = text
    .split(/\r?\n/)
    .map((l) => l.replace(/[ \t]+/g, " ").trim())
    .filter((l) => l.length > 0)

  type Kind = "heading" | "bullet" | "colon" | "plain"
  type Entry = { level: number | null; text: string; kind: Kind }

  const entries: Entry[] = []
  let structuredCount = 0 // berapa baris yang mengikuti pola struktur

  // Kumpulkan baris teks biasa berurutan → nanti dipecah per kalimat.
  let plainBuffer: string[] = []
  const flushPlain = () => {
    if (plainBuffer.length === 0) return
    const paragraph = plainBuffer.join(" ")
    // Teks biasa dipecah per kalimat supaya peta konsep lebih granular.
    const parts = splitSentences(paragraph)
    for (const p of parts.length ? parts : [paragraph]) {
      entries.push({ level: null, text: p, kind: "plain" })
    }
    plainBuffer = []
  }

  for (const line of lines) {
    // Markdown heading: "#" … "######"
    let m = line.match(/^(#{1,6})\s+(.+)$/)
    if (m) {
      flushPlain()
      entries.push({
        level: Math.min(m[1].length, 4),
        text: m[2].trim(),
        kind: "heading",
      })
      structuredCount++
      continue
    }
    // Penomoran: "1." / "1)" / "1.1" / "1.1.2"
    m = line.match(/^(\d{1,3}(?:\.\d{1,3}){0,3})[.)]?\s+(.+)$/)
    if (m) {
      flushPlain()
      entries.push({
        level: Math.min(m[1].split(".").length, 4),
        text: m[2].trim(),
        kind: "heading",
      })
      structuredCount++
      continue
    }
    // Butir / tanda: "-", "*", "•"
    m = line.match(/^[-*•]\s+(.+)$/)
    if (m) {
      flushPlain()
      entries.push({ level: null, text: m[1].trim(), kind: "bullet" })
      structuredCount++
      continue
    }
    // Baris berakhiran ":" ATAU berpola "Label pendek: penjelasan"
    // (umum pada daftar istilah) → judul sub-bagian. Kolon yang langsung
    // diikuti digit (mis. "10:30") diabaikan agar tidak salah deteksi.
    const labelColon = line.match(/^([^:]{1,60}):(?!\d)\s+(\S.*)$/)
    const isColonLine =
      (line.length <= 100 && /:$/.test(line)) ||
      (labelColon !== null &&
        labelColon[1].trim().split(/\s+/).length <= 6 &&
        line.length <= 160)
    if (isColonLine) {
      flushPlain()
      entries.push({ level: null, text: line, kind: "colon" })
      structuredCount++
      continue
    }
    plainBuffer.push(line)
  }
  flushPlain()

  // ── Fallback: tanpa struktur → kelompokkan kalimat per 3 ──
  if (structuredCount === 0) {
    const sentences = splitSentences(text)
    const roots: OutlineNode[] = []
    for (let i = 0; i < sentences.length; i += 3) {
      roots.push({
        text: `Bagian ${roots.length + 1}`,
        children: sentences.slice(i, i + 3).map((s) => ({
          text: s,
          children: [],
        })),
      })
    }
    return roots
  }

  // ── Bangun pohon dengan stack ──
  // - level absolut (heading) menentukan kedalaman pasti;
  // - level relatif (bullet/colon/plain) = anak dari node terakhir;
  // - butir/teks berikutnya yang sama jenis = saudara (tidak makin dalam);
  // - label "X: y" setelah isi label sebelumnya = saudara label itu.
  const roots: OutlineNode[] = []
  const stack: { level: number; node: OutlineNode }[] = []
  let prevKind: Kind | null = null
  let prevRelLevel = 1
  let lastColonLevel: number | null = null // level label "X:" terkini

  for (const e of entries) {
    let level: number
    if (e.level != null) {
      level = e.level
      lastColonLevel = null // heading absolut memulai konteks baru
    } else if (
      e.kind === "colon" &&
      prevKind !== null &&
      prevKind !== "heading"
    ) {
      // Label baru setelah isi/label lain → kembali sejajar dengan label
      // pemilik konteks sebelumnya.
      level =
        prevKind === "colon"
          ? prevRelLevel
          : (lastColonLevel ?? prevRelLevel)
    } else if (
      prevKind !== null &&
      (e.kind === "bullet" || e.kind === "plain") &&
      (prevKind === "bullet" || prevKind === "plain")
    ) {
      // Butir setelah butir / teks setelah teks (atau butir↔teks) → saudara.
      level = prevRelLevel
    } else {
      level = (stack.length ? stack[stack.length - 1].level : 0) + 1
    }
    prevKind = e.kind
    prevRelLevel = level
    if (e.kind === "colon") lastColonLevel = level

    const node: OutlineNode = { text: e.text, children: [] }
    while (stack.length && stack[stack.length - 1].level >= level) stack.pop()
    const parentList = stack.length
      ? stack[stack.length - 1].node.children
      : roots
    parentList.push(node)
    stack.push({ level, node })
  }

  return roots
}
