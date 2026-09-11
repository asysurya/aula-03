// src/lib/study/local-ai.ts
//
// Mesin jawaban LOKAL "Teman Belajar" — 100% berjalan di browser, tanpa
// internet, tanpa API, tanpa limit, tanpa biaya. Dipakai sebagai:
//   1. Mode default (provider "local"), dan
//   2. Fallback ketika AI eksternal (Gemini / OpenAI-compatible) gagal.
//
// Bukan LLM — ini mesin berbasis aturan + retrieval sederhana atas materi
// yang ditempel siswa: normalisasi teks, ekstraksi kata kunci (stopwords
// bahasa Indonesia), deteksi intent, lalu susun jawaban dari kalimat-kalimat
// materi yang paling relevan. Semua util ditulis di file ini (tidak import
// dari modul agent lain) supaya bisa dipakai di mana saja tanpa dependensi.

// ---------------------------------------------------------------------------
// Util dasar: normalisasi & tokenisasi
// ---------------------------------------------------------------------------

/** Lowercase, buang tanda baca, rapikan spasi. */
function normalize(text: string): string {
  return (text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Pecah teks jadi token kata yang sudah dinormalisasi. */
function tokenize(text: string): string[] {
  const n = normalize(text);
  return n ? n.split(" ") : [];
}

/**
 * "Stemmer" ringan bahasa Indonesia (sangat sederhana, cukup untuk
 * pencocokan): buang partikel (nya/lah/kah/pun) lalu sufiks turunan
 * (kan/an/i) selama kata hasilnya masih >= 4 huruf.
 * Contoh: "fotosintesisnya" -> "fotosintesis", "melakukan" -> "melakuk".
 */
function stem(word: string): string {
  let w = word;
  for (const p of ["nya", "lah", "kah", "pun"]) {
    if (w.length - p.length >= 4 && w.endsWith(p)) {
      w = w.slice(0, -p.length);
      break;
    }
  }
  for (const s of ["kan", "an", "i"]) {
    if (w.length - s.length >= 4 && w.endsWith(s)) {
      w = w.slice(0, -s.length);
      break;
    }
  }
  return w;
}

// ---------------------------------------------------------------------------
// Stopwords bahasa Indonesia (+ sedikit Inggris) — 120+ kata
// ---------------------------------------------------------------------------

const STOPWORDS = new Set<string>([
  // kata tanya & perintah
  "apa", "apakah", "gimana", "bagaimana", "mengapa", "kenapa", "kapan",
  "dimana", "kemana", "siapa", "berapa", "jelaskan", "jelasin", "ceritakan",
  "sebutkan", "tolong", "coba", "kasih", "beri", "buat", "bikin", "bikinin",
  // kata sambung & preposisi
  "yang", "yg", "dan", "atau", "tapi", "namun", "kalau", "jika", "karena", "sebab", "oleh",
  "untuk", "pada", "dalam", "di", "ke", "dari", "kepada", "terhadap",
  "tentang", "antara", "sampai", "hingga", "setelah", "sebelum", "selama",
  "sementara", "agar", "supaya", "bahwa", "serta", "maupun", "lalu", "kemudian",
  "misalnya", "yaitu", "yakni", "ialah", "adalah", "merupakan", "seperti",
  "dengan", "secara", "sebagai", "para", "sang", "si",
  // pronomina
  "saya", "aku", "kamu", "kau", "anda", "dia", "ia", "mereka", "kita", "kami",
  "nya", "punya", "milik",
  // kata kerja bantu & keterangan umum
  "ada", "tidak", "bukan", "jangan", "belum", "sudah", "telah", "sedang",
  "akan", "lagi", "pernah", "sering", "biasanya", "juga", "hanya", "saja",
  "paling", "lebih", "sangat", "amat", "terlalu", "cukup", "begitu", "begini",
  "kayak", "kira", "bisa", "dapat", "boleh", "harus", "wajib", "mungkin",
  "tentu", "kata", "adanya",
  // partikel, sapaan & kata pengisi
  "ya", "yah", "nah", "sih", "deh", "kok", "tuh", "eh", "dong", "nih", "oi",
  "woi", "oke", "ok", "hehe", "wkwk", "kak", "bang", "mbak", "mas", "halo", "hai",
  "hei", "hay", "mau", "ingin", "pengen", "mohon", "min", "banget", "bgt", "udah",
  "aja", "saja", "ga", "gak", "nggak", "ngga", "enggak", "gimana", "gmn", "dgn", "utk", "krn",
  // kata meta tentang aplikasi ini
  "itu", "ini", "hal", "benda", "orang", "tempat", "waktu", "contoh",
  "misal", "macam", "jenis", "bagian", "cara", "semua", "setiap", "situ",
  "sana", "mana", "apa-apa", "materi", "materinya", "pelajaran", "soal",
  "soalnya", "pertanyaan", "jawab", "jawaban", "bahan", "latihan", "kuis",
  "analogi", "rangkum", "ringkas", "ringkasan", "intisari", "poin",
  "penting", "utama", "terpenting", "kesimpulan", "pemula", "sederhana",
  "gampang", "mudah", "awam", "anak", "tahun", "bahasa", "kata", "sendiri",
  "kata-katamu", "versi",
  // sedikit Inggris yang sering nyelip
  "the", "a", "an", "is", "are", "am", "was", "what", "why", "how", "who",
  "when", "where", "which", "of", "to", "and", "or", "in", "on", "at", "for",
  "with", "that", "this", "these", "those", "it", "be", "can", "could", "you",
  "your", "me", "my", "please", "explain", "make", "give", "do", "does",
  "did", "not", "no", "yes",
]);

// ---------------------------------------------------------------------------
// Util: kalimat & frekuensi kata kunci
// ---------------------------------------------------------------------------

/**
 * Pecah materi jadi kalimat-kalimat bersih: pisah per baris dan per tanda
 * akhir kalimat (./!/?/;), buang penanda bullet/numbering di awal, buang
 * fragmen yang terlalu pendek untuk berguna (< 10 karakter).
 */
function splitSentences(text: string): string[] {
  const out: string[] = [];
  for (const line of (text ?? "").replace(/\r/g, "").split(/\n+/)) {
    const parts = line.match(/[^.!?;]+[.!?;]*/g) ?? [];
    for (const p of parts) {
      const s = p
        .trim()
        .replace(/^([-*•>]|\d{1,2}[.)])\s+/, "") // bullet & "1. " / "a) "
        .replace(/\s+/g, " ")
        .trim();
      if (s.length >= 10) out.push(s);
    }
  }
  return out;
}

/** Frekuensi kata bermakna (stem + filter stopwords) -> dipakai menilai relevansi. */
function keywordFreq(text: string): Map<string, number> {
  const freq = new Map<string, number>();
  for (const t of tokenize(text)) {
    if (t.length < 3 || /^\d+$/.test(t)) continue;
    if (STOPWORDS.has(t)) continue;
    const s = stem(t);
    if (s.length < 3 || STOPWORDS.has(s)) continue;
    freq.set(s, (freq.get(s) ?? 0) + 1);
  }
  return freq;
}

/** Kata kunci teratas (stem) dari sebuah teks. */
function topKeywords(text: string, limit: number): string[] {
  return [...keywordFreq(text).entries()]
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .slice(0, limit)
    .map(([w]) => w);
}

/**
 * Skor relevansi sebuah kalimat terhadap sekumpulan kata kunci target:
 * +bobot tiap kata kunci yang muncul, +bonus kecil bila kalimatnya
 * definisional (memuat "adalah/yaitu/ialah/merupakan/:").
 */
function scoreSentence(sentence: string, target: Map<string, number>): number {
  if (!sentence || target.size === 0) return 0;
  const toks = new Set(tokenize(sentence).map(stem));
  let score = 0;
  for (const [kw, weight] of target) {
    if (toks.has(kw)) score += weight;
  }
  if (/(adalah|ialah|yaitu|yakni|merupakan)\b|:/i.test(sentence)) score += 0.75;
  return score;
}

/** Pilih item secara deterministik dari benih string (biar variasinya stabil). */
function pickFrom<T>(arr: readonly T[], seed: string): T {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  return arr[Math.abs(h) % arr.length];
}

/** Bungkus kalimat panjang biar tetap nyaman dibaca (maks ~320 karakter). */
function clampSentence(s: string, max = 320): string {
  return s.length > max ? `${s.slice(0, max).trimEnd()}…` : s;
}

/** Ambil bentuk asli kata di kalimat yang cocok dengan stem-nya (untuk ditampilkan). */
function surfaceForm(sentence: string, stemWord: string): string {
  const toks = sentence.match(/[A-Za-z][A-Za-z0-9-]*/g) ?? [];
  for (const t of toks) {
    if (stem(t.toLowerCase()) === stemWord) return t;
  }
  return stemWord;
}

// ---------------------------------------------------------------------------
// Deteksi intent
// ---------------------------------------------------------------------------

type Intent =
  | { kind: "greeting" }
  | { kind: "thanks" }
  | { kind: "define"; term: string }
  | { kind: "summary"; count: number }
  | { kind: "simple" }
  | { kind: "practice" }
  | { kind: "analogy" }
  | { kind: "socratic" };

function wordCount(s: string): number {
  return s ? s.split(" ").filter(Boolean).length : 0;
}

function detectIntent(q: string): Intent {
  const words = wordCount(q);

  // Sapaan singkat (bukan pertanyaan isi)
  if (
    words <= 4 &&
    /^(hal+o+|ha+i+|he+i+|hi+|hay+|woi|oi|assalamualaikum|assalamu ?alaikum|salam|selamat (pagi|siang|sore|malam)|pagi|siang|sore|malam|permisi)\b/.test(q) &&
    !/(tanya|jelaskan|apa|gimana|kenapa|mengapa|adalah|bisa)/.test(q)
  ) {
    return { kind: "greeting" };
  }

  // Ucapan terima kasih singkat
  if (
    words <= 4 &&
    /(terima ?kasih|makasih|maksih|thank ?s?|thankyou|thank you|thx|tq|tengkyu|syukur)/.test(q)
  ) {
    return { kind: "thanks" };
  }

  // Minta soal/latihan/kuis
  if (
    /(buat|bikin|bikinin|tolong buat|kasih|beri)( aku)?[^.;]{0,24}(soal|pertanyaan|kuis|latihan)|soal latihan|latihan soal|(^|\s)(kuis|quiz|latihan)(\s|$)|tes pemahaman|uji pemahaman|soal-soal/.test(
      q
    )
  ) {
    return { kind: "practice" };
  }

  // Minta analogi / contoh
  if (/(analogi|ibarat|perumpamaan|metafora|perbandingan sederhana|contoh)/.test(q)) {
    return { kind: "analogy" };
  }

  // Minta rangkuman / poin penting (boleh dengan jumlah: "apa 3 poin terpenting")
  const summaryMatch = q.match(
    /(rangkum|ringkas|ringkasan|intisari|poin (ter)?penting|poin utama|hal penting|paling penting|kesimpulan|garis besar)/
  );
  if (summaryMatch) {
    const num = q.match(/(\d+)\s*(poin|kalimat|hal|bagian)/);
    const count = num ? Math.min(5, Math.max(3, parseInt(num[1], 10))) : 0;
    return { kind: "summary", count };
  }

  // Minta penjelasan versi sederhana ("seperti aku 12 tahun")
  if (
    /(1[0-5] tahun|anak kecil|anak sd|anak smp|bahasa sederhana|bahasa awam|bahasa gampang|bahasa manusia|sederhananya|gampangnya|mudahnya|untuk pemula|seperti aku|bagai awam)/.test(
      q
    )
  ) {
    return { kind: "simple" };
  }

  // Pertanyaan definisi
  const define =
    q.match(/apa (sih )?(yang )?itu (.+)/) ||
    q.match(/apa yang dimaksud (dengan |dari )?(.+)/) ||
    q.match(/(.+) itu apa( sih)?$/) ||
    q.match(/definisi (dari |istilah )?(.+)/) ||
    q.match(/maksud(nya)?( dari| tentang)? (.+)/) ||
    q.match(/siapa (.+)/) ||
    q.match(/^(jelaskan|jelasin|ceritakan|sebutkan|tolong jelaskan|jelasin dong)\s+(.+)/);
  if (define) {
    const raw = define[define.length - 1] ?? "";
    const term = raw
      .replace(/^(itu|ini|yang|tentang|dengan|adalah|kak)\s+/, "")
      .replace(/\s+(itu|ini|dong|ya|sih|deh|aja)$/, "")
      .trim();
    if (term && !/^(apa|sih|dong|ya|gimana|bagaimana|maksudnya)$/.test(term)) {
      return { kind: "define", term };
    }
  }

  // Selain itu: mode sokratik
  return { kind: "socratic" };
}

// ---------------------------------------------------------------------------
// Bank kalimat penutup & tips (variasi deterministik dari pertanyaan)
// ---------------------------------------------------------------------------

const CLOSINGS = [
  "Coba tulis ulang jawaban ini dengan kata-katamu sendiri — cara tercepat memastikan kamu benar-benar paham.",
  "Setelah ini, tutup layar dan coba jelaskan materi barusan ke teman atau di atas kertas. Kalau lancar, kamu siap lanjut.",
  "Kalau masih ada yang mengganjal, tanyakan bagian mana yang bikin bingung — nanti kita bedah pelan-pelan.",
  "Tulis satu kalimat kesimpulan versimu di catatan, lalu bandingkan dengan kalimat aslinya di materi.",
  "Coba buat satu contoh sendiri dari konsep di atas — membuat contoh adalah latihan terbaik.",
  "Ulangi membaca bagian yang tadi kita bahas 5 menit sebelum tidur — ingatan paling menempel di waktu itu.",
];

const TIPS = [
  "Baca pelan satu kalimat, lalu bayangkan gambarnya di kepalamu sebelum lanjut ke kalimat berikutnya.",
  "Ubah tiap poin materi jadi pertanyaan kecil di catatanmu — nanti tinggal dijawab saat belajar ulang.",
  "Jelaskan materi ini ke teman/orang tua selama 60 detik; bagian yang tersendat itulah yang perlu diulang.",
  "Tandai bagian yang masih membingungkan, lalu tanyakan bagian itu secara spesifik — pertanyaan sempit lebih mudah dijawab.",
  "Beri jeda 5 menit tiap selesai satu bagian, lalu ingat-ingat kembali isinya tanpa melihat.",
];

function closing(question: string): string {
  return pickFrom(CLOSINGS, question || "default");
}

function tip(question: string): string {
  return pickFrom(TIPS, `tip:${question || "default"}`);
}

// ---------------------------------------------------------------------------
// Jawaban per intent
// ---------------------------------------------------------------------------

function answerGreeting(): string {
  return [
    "Halo! Senang kamu mampir. Aku Teman Belajar-mu — jawabanku disusun langsung di browser-mu, jadi gratis, tanpa limit, dan tetap jalan tanpa internet.",
    "",
    "Biar aku bisa bantu maksimal:",
    '1. Tempel dulu materi pelajaranmu di kotak "Materi pelajaran" di atas.',
    "2. Lalu tanya apa saja tentang materi itu — atau klik salah satu pertanyaan cepat di bawah.",
    "3. Mau jawaban AI eksternal (Gemini / OpenRouter)? Atur lewat tombol pengaturan (ikon roda gigi) — pakai API key milikmu sendiri.",
    "",
    'Sudah menempel materi? Coba mulai dari: "Apa 3 poin terpenting dari materi?"',
  ].join("\n");
}

function answerThanks(): string {
  return [
    "Sama-sama! Senang bisa bantu.",
    "",
    "Kalau mau lanjut belajar: coba jelaskan ulang materi barusan ke temanmu (atau ke cermin) dalam 60 detik — kalau lancar artinya kamu paham, kalau tersendat itulah bagian yang perlu ditanyakan lagi.",
    "",
    "Aku selalu di sini — gratis dan tanpa batas.",
  ].join("\n");
}

function answerNoMaterial(question: string): string {
  const kws = topKeywords(question, 3);
  const kwLine = kws.length
    ? kws.join(", ")
    : "pertanyaanmu belum memuat kata kunci yang bisa dicari — coba tulis lebih spesifik";
  return [
    "Aku belum punya materi untuk dijadikan rujukan. Tempel dulu materi pelajaranmu di kotak \"Materi pelajaran\" di atas — setelah itu aku bisa menjawab persis dari materimu, termasuk minta rangkuman, soal latihan, atau analogi.",
    "",
    "Sementara itu, untuk pertanyaanmu coba langkah ini:",
    `- Pecah pertanyaan jadi kata kunci: ${kwLine}.`,
    "- Cari kata kunci itu di buku/catatanmu, lalu baca satu kalimat sebelum dan sesudahnya.",
    "- Tulis dulu apa yang sudah kamu ketahui — bagian yang tidak bisa kamu tulis biasanya inti yang perlu dicari.",
    "",
    closing(question),
  ].join("\n");
}

function answerDefine(question: string, term: string, material: string): string {
  const sentences = splitSentences(material);
  if (!sentences.length) return answerNoMaterial(question);

  const termFreq = keywordFreq(term);
  if (!termFreq.size) return answerSocratic(question, material);

  const scored = sentences
    .map((s, i) => ({ s, i, score: scoreSentence(s, termFreq) }))
    .filter((x) => x.score >= 1)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .sort((a, b) => a.i - b.i);

  if (!scored.length) {
    const kws = topKeywords(material, 3);
    return [
      `Hmm, aku belum menemukan "${term}" di materi yang kamu tempel. Aku mencocokkan kata, bukan makna — jadi coba salah satu ini:`,
      "- Periksa lagi ejaan istilahnya (persis seperti yang tertulis di materi).",
      kws.length
        ? `- Tanyakan istilah lain di sekitar topik ini, misalnya: "Apa itu ${kws[0]}?"`
        : "- Tanyakan istilah lain yang ada di materi.",
      '- Atau mulai dari yang luas: "Apa 3 poin terpenting dari materi?" — nanti kita perkecil pelan-pelan.',
      "",
      closing(question),
    ].join("\n");
  }

  return [
    "Berdasarkan materimu:",
    "",
    ...scored.map((x) => `- "${clampSentence(x.s)}"`),
    "",
    "Kalimat pertama di atas biasanya definisi utamanya; sisanya penjelas tambahan dari materi.",
    "",
    closing(question),
  ].join("\n");
}

function summarizeSentences(material: string, count: number): string[] {
  const sentences = splitSentences(material);
  if (!sentences.length) return [];
  const freq = keywordFreq(material);
  const n = Math.min(
    Math.max(count, 3),
    Math.max(3, Math.min(5, Math.ceil(sentences.length / 6)))
  );
  return sentences
    .map((s, i) => ({ s, i, score: scoreSentence(s, freq) + (sentences.length - i) * 0.005 }))
    .sort((a, b) => b.score - a.score)
    .slice(0, n)
    .sort((a, b) => a.i - b.i)
    .map((x) => clampSentence(x.s));
}

function answerSummary(question: string, material: string, count: number): string {
  const picked = summarizeSentences(material, count || 3);
  if (!picked.length) return answerNoMaterial(question);
  const kws = topKeywords(material, 4);
  const lines = [
    `Intisari materimu — ${picked.length} poin terpenting:`,
    "",
    ...picked.map((s, i) => `${i + 1}. ${s}`),
    "",
  ];
  if (kws.length) lines.push(`Kata kunci utamanya: ${kws.join(", ")}.`, "");
  lines.push(closing(question));
  return lines.join("\n");
}

function answerSimple(question: string, material: string): string {
  const picked = summarizeSentences(material, 3);
  if (!picked.length) return answerNoMaterial(question);
  return [
    "Oke, versi gampangnya — ini inti materimu dalam bahasa sehari-hari:",
    "",
    ...picked.map((s, i) => `${i + 1}. ${s}`),
    "",
    'Kalau masih ada nomor yang terasa berat, tanya aja spesifik — misalnya: "jelaskan nomor 2 seperti aku 12 tahun" — nanti aku pecah lagi lebih sederhana.',
    "",
    closing(question),
  ].join("\n");
}

function answerPractice(question: string, material: string): string {
  const sentences = splitSentences(material);
  if (!sentences.length) return answerNoMaterial(question);

  const freq = keywordFreq(material);
  const picked = sentences
    .map((s, i) => ({ s, i, score: scoreSentence(s, freq) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .sort((a, b) => a.i - b.i);

  const templates = [
    (s: string) => `Jelaskan dengan kata-katamu sendiri: "${clampSentence(s, 220)}"`,
    (s: string) => `Menurut materimu: ${clampSentence(s, 220).replace(/[.!?]+$/, "")} — setujukah? Jelaskan alasannya.`,
    (s: string) => `Beri satu contoh nyata (dari kehidupan sehari-hari) dari kalimat ini: "${clampSentence(s, 220)}"`,
  ];

  return [
    "Siap! Ini latihannya — kubuat dari bagian materimu yang paling \"berdaging\":",
    "",
    ...picked.map((x, i) => `${i + 1}. ${templates[i % templates.length](x.s)}`),
    "",
    "Cara pakai: jawab dulu TANPA mengintip materi, lalu cocokkan jawabanmu dengan bagian aslinya. Salah tidak apa-apa — justru di situ belajarnya.",
    "",
    closing(question),
  ].join("\n");
}

function answerAnalogy(question: string, material: string): string {
  const materialKeywords = topKeywords(material, 1);
  const questionKeywords = topKeywords(question.replace(/(analogi|contoh|ibarat|buat|untuk|materi|sederhana)/g, " "), 1);
  const topic =
    questionKeywords[0] && material.includes(questionKeywords[0])
      ? questionKeywords[0]
      : materialKeywords[0] ?? "materimu";

  const patterns = [
    (t: string) =>
      `Bayangkan ${t} seperti memasak: ada bahan-bahannya, ada urutan langkahnya, dan ada hidangan jadi di akhir. Ganti satu bahan saja, hasil akhirnya ikut berubah.`,
    (t: string) =>
      `Anggap ${t} seperti sebuah tim: setiap anggota punya peran, dan hasilnya baru muncul kalau semuanya bekerja bersamaan.`,
    (t: string) =>
      `Bayangkan ${t} seperti perjalanan dari hulu ke hilir: mulai dari titik awal yang jelas, melewati beberapa "pos", sampai ke hasil akhir di ujung.`,
    (t: string) =>
      `Anggap ${t} seperti menanam tanaman: butuh bibit (bahan), perawatan rutin (proses), dan waktu sebelum hasilnya terlihat.`,
    (t: string) =>
      `Bayangkan ${t} seperti aliran air di pipa: masuk dari satu sisi, berubah di tengah, keluar dengan bentuk baru di sisi yang lain.`,
  ];

  const first = pickFrom(patterns, `a:${question}`);
  const second = pickFrom(patterns, `b:${question}`);
  const secondText = second === first ? patterns[(patterns.indexOf(first) + 1) % patterns.length] : second;

  return [
    `Aku bantu buatkan analoginya — topik utamanya: "${topic}".`,
    "",
    "Coba bayangkan seperti ini:",
    `- ${first(topic)}`,
    `- ${secondText(topic)}`,
    "",
    "Rahasianya: hampir semua topik pelajaran bisa dianalogikan dengan (1) bahan, (2) proses, (3) hasil — padankan tiga itu dengan hal sehari-hari yang kamu kenal, dan tiba-tiba materinya terasa jauh lebih ringan.",
    "",
    "Mau analogi yang lebih pas? Tanyakan bagian spesifiknya, misalnya: \"buat analogi untuk bagian tentang " + topic + "\".",
    "",
    closing(question),
  ].join("\n");
}

function answerSocratic(question: string, material: string): string {
  const sentences = splitSentences(material);
  if (!sentences.length) return answerNoMaterial(question);

  const qFreq = keywordFreq(question);
  const best = sentences
    .map((s, i) => ({ s, i, score: qFreq.size ? scoreSentence(s, qFreq) : scoreSentence(s, keywordFreq(material)) * 0.5 }))
    .sort((a, b) => b.score - a.score)[0];

  const kws = topKeywords(question, 3);
  // Kata pemantik utama: kata kunci pertama yang benar-benar muncul di
  // kalimat terpilih — kalau tidak ada, pakai kata kunci teratas.
  const bestToks = new Set(tokenize(best?.s ?? "").map(stem));
  const kw1 = kws.find((k) => bestToks.has(k)) ?? kws[0] ?? topKeywords(material, 1)[0] ?? "kata kuncinya";
  const kw2 = kws.find((k) => k !== kw1) ?? kw1;

  if (best && best.score >= 1) {
    const kw1Display = surfaceForm(best.s, kw1);
    return [
      "Pertanyaan yang bagus. Dari materimu, bagian ini paling nyambung:",
      "",
      `"${clampSentence(best.s)}"`,
      "",
      "Mari kita bedah bertahap:",
      `1. Pemanasan — perhatikan kata "${kw1Display}" di kalimat itu: menurutmu kenapa ia penting?`,
      "2. Naik level — coba jelaskan kalimat di atas dengan bahasamu sendiri, satu-dua kalimat saja.",
      `3. Tantangan — kalau "${kw2 === kw1 ? kw1Display : kw2}" dihilangkan, apa yang akan berubah pada hasil akhirnya?`,
      "",
      `Tips belajar: ${tip(question)}`,
      "",
      closing(question),
    ].join("\n");
  }

  const materialKws = topKeywords(material, 3);
  return [
    `Hmm, aku belum menemukan bagian materi yang cocok dengan pertanyaan itu. Bisa jadi materinya belum memuat topik "${kw1}", atau istilahnya berbeda.`,
    "",
    "Coba salah satu ini:",
    materialKws.length
      ? `- Ganti dengan istilah yang persis ada di materi (misalnya: ${materialKws
          .map((k) => `"${k}"`)
          .join(", ")}).`
      : "- Tanyakan istilah yang persis ada di materi.",
    '- Atau mulai dari yang luas: "Apa 3 poin terpenting dari materi?" lalu kita perkecil pelan-pelan.',
    "- Bisa juga materinya belum kamu tempel lengkap — tambahkan dulu di panel atas.",
    "",
    `Tips belajar: ${tip(question)}`,
    "",
    closing(question),
  ].join("\n");
}

// ---------------------------------------------------------------------------
// API publik
// ---------------------------------------------------------------------------

/**
 * Jawab pertanyaan siswa sepenuhnya di "lokal" (browser), berdasarkan materi
 * yang ditempel. Selalu mengembalikan string — tidak pernah melempar error,
 * tidak butuh internet, tidak memanggil API apa pun.
 */
export function answerLocally(question: string, material: string): string {
  try {
    const q = question ?? "";
    const mat = material ?? "";
    const norm = normalize(q);

    if (!norm) {
      return [
        "Sepertinya pertanyaannya belum tertulis. Tulis dulu pertanyaanmu di kotak bawah, ya.",
        "",
        'Kalau bingung mulai dari mana: "Apa 3 poin terpenting dari materi?" atau "Buat 5 pertanyaan latihan dari materi".',
      ].join("\n");
    }

    const intent = detectIntent(norm);

    switch (intent.kind) {
      case "greeting":
        return answerGreeting();
      case "thanks":
        return answerThanks();
      case "define":
        return answerDefine(q, intent.term, mat);
      case "summary":
        return answerSummary(q, mat, intent.count);
      case "simple":
        return answerSimple(q, mat);
      case "practice":
        return answerPractice(q, mat);
      case "analogy":
        return answerAnalogy(q, mat);
      default:
        return answerSocratic(q, mat);
    }
  } catch {
    // Mesin lokal tidak boleh gagal — kalau ada yang tidak terduga, balas
    // dengan jawaban yang tetap membantu.
    return [
      "Maaf, aku kesulitan menyusun jawaban untuk pertanyaan itu.",
      "",
      'Coba cara ini: tanyakan dengan kalimat lebih spesifik (misalnya "Apa itu <istilah>?"), atau mulai dari "Apa 3 poin terpenting dari materi?".',
      "",
      "Jangan menyerah — satu pertanyaan baik lebih berguna dari sepuluh yang tidak jelas.",
    ].join("\n");
  }
}
