// ─────────────────────────────────────────────────────────────────────
// EKSTRAKSI TEKS DENGAN MODEL VISION (Task 29).
//
// Dipakai oleh:
//   • Lampiran materi AI (ai-extract.ts) — gambar asli & PDF hasil scan
//     tanpa lapisan teks → OCR per halaman via model multimodal.
//   • Aula Reader "Bacakan" (/api/ai/vision/page) — halaman PDF yang
//     sedang dibuka dirender jadi JPEG di client, dikirim ke sini.
//
// Prinsip "per halaman, jangan langsung semua": tiap halaman dirender
// terpisah & dikirim sebagai SATU gambar per panggilan (bukan seluruh
// PDF sekaligus) — akurasi OCR jauh lebih tinggi dan memori terkendali.
// Loop halaman dijalankan SEKUENSIAL dengan anggaran waktu lunak.
//
// Semua panggilan lewat chain kategori "vision" (fallback berurutan —
// entri #1 gagal → coba entri #2, dst) memakai tryChatCompletion.
// ─────────────────────────────────────────────────────────────────────

import {
  resolveChain,
  tryChatCompletion,
  summarizeFailures,
  type ChatAttemptFailure,
} from "@/lib/ai-config-chain";
import type { ResolvedAiConfig } from "@/lib/ai-providers";

// ── Prompt OCR (Bahasa Indonesia, aturan cleanup buku pelajaran) ──────

const PROMPT_HALAMAN = `Kamu adalah OCR presisi untuk halaman buku pelajaran / modul Indonesia. Salin SELURUH teks yang terlihat pada gambar halaman ini, lalu rapikan formatnya.

ATURAN FORMAT:
- Susun paragraf mengikuti alur baca asli (kiri-ke-kanan, atas-ke-bawah).
- Tabel: tulis sebagai tabel markdown (| kolom | kolom |) dengan header jelas; bila sel tak masuk akal sebagai tabel, uraikan per baris.
- Catatan kaki (penanda nomor kecil di atas garis: ¹ ² ³ atau 1) 2) 3)): JANGAN sisipkan penandanya di tengah kalimat. Kumpulkan penjelasan catatan kakinya di BAGIAN PALING BAWAH dengan format:
  Catatan kaki (1): …
  Catatan kaki (2): …
- Rumus matematika/fisika/kimia: tulis dalam LaTeX — $V_p I_p = V_s I_s$, $x^2 + 2x + 1$, $\\frac{1}{2}gt^2$, $H_2O$, $\\sqrt{a^2 + b^2}$.
- Soal uji/latihan: pertahankan penomoran soal persis seperti aslinya (1. … 2. … 16. …) — JANGAN dinomori ulang.

FILTER — JANGAN ikutsertakan dalam hasil:
- Nomor halaman (angka sendirian di pojok atas/bawah halaman).
- Header/footer berulang: judul buku, judul bab, nama penerbit, "Fisika SMA/MTs Kelas VIII", logo, alamat penerbit, ISBN.
- Watermark dan nomor iklan.

Jawab HANYA teks halaman yang sudah dirapikan — tanpa kata pengantar, tanpa penjelasan proses, tanpa tanda kutip pembungkus. Bila halaman murni gambar/ilustrasi tanpa teks, jawab satu baris: [halaman gambar tanpa teks]`;

const PROMPT_GAMBAR = `Kamu adalah OCR presisi untuk gambar (foto lembar soal, screenshot, foto papan tulis, materi). Salin SELURUH teks yang terlihat pada gambar ini dengan format rapi:
- Pertahankan penomoran soal persis aslinya (1. … 16. …) — JANGAN dinomori ulang.
- Tabel → tabel markdown; rumus → LaTeX ($V_p I_p = V_s I_s$, $x^2$, $\\frac{1}{2}gt^2$).
- Abaikan watermark/stempel/nomor halaman.
Jawab HANYA teksnya — tanpa kata pengantar, tanpa penjelasan, tanpa tanda kutip. Bila tidak ada teks terbaca, jawab satu baris: [gambar tanpa teks]`;

// ── Error ─────────────────────────────────────────────────────────────

export class VisionUnavailableError extends Error {
  failures: ChatAttemptFailure[];
  constructor(failures: ChatAttemptFailure[]) {
    super(
      failures.length
        ? `Semua model vision gagal — ${summarizeFailures(failures)}`
        : "Belum ada model vision terpasang (atur kategori Vision di Pengaturan AI)."
    );
    this.name = "VisionUnavailableError";
    this.failures = failures;
  }
}

// ── Panggilan vision (non-streaming) ──────────────────────────────────

export interface VisionImage {
  data: Buffer;
  mime: string;
}

/** Satu panggilan vision: teks instruksi + satu/lebih gambar.
 * Mengembalikan teks jawaban + config entri yang berhasil (fallback). */
export async function visionChat(
  chain: ResolvedAiConfig[],
  images: VisionImage[],
  instruction: string,
  opts: { maxTokens?: number; timeoutMs?: number } = {}
): Promise<{ text: string; used: ResolvedAiConfig | null }> {
  if (!chain.length) throw new VisionUnavailableError([]);
  const content: unknown[] = [{ type: "text", text: instruction }];
  for (const img of images.slice(0, 4)) {
    content.push({
      type: "image_url",
      image_url: { url: `data:${img.mime};base64,${img.data.toString("base64")}` },
    });
  }
  const res = await tryChatCompletion(
    chain,
    {
      messages: [{ role: "user", content }],
      stream: false,
      max_tokens: opts.maxTokens ?? 3500,
      temperature: 0,
    },
    { timeoutMs: opts.timeoutMs ?? 90_000 }
  );
  if (!res.response) throw new VisionUnavailableError(res.failures);
  let json: unknown;
  try {
    json = await res.response.json();
  } catch {
    throw new VisionUnavailableError([
      { provider: res.config?.provider ?? "?", model: res.config?.model ?? "?", status: null, detail: "respons bukan JSON" },
    ]);
  }
  const c = (json as { choices?: { message?: { content?: unknown } }[] })?.choices?.[0]
    ?.message?.content;
  const text =
    typeof c === "string"
      ? c
      : Array.isArray(c)
        ? c
            .map((p) => (p && typeof p === "object" && typeof (p as { text?: unknown }).text === "string" ? (p as { text: string }).text : ""))
            .join("")
        : "";
  return { text: text.trim(), used: res.config };
}

// ── Render halaman PDF → JPEG (server-side, pdfjs + napi canvas) ──────

interface PdfPageLike {
  getViewport: (o: { scale: number }) => { width: number; height: number };
  render: (o: Record<string, unknown>) => { promise: Promise<unknown> };
}
interface PdfDocLike {
  numPages: number;
  getPage: (n: number) => Promise<PdfPageLike>;
  destroy?: () => Promise<void>;
}

export async function loadPdfDoc(buf: Buffer): Promise<PdfDocLike> {
  const pdfjs = (await import("pdfjs-dist/legacy/build/pdf.mjs")) as unknown as {
    getDocument: (o: Record<string, unknown>) => { promise: Promise<PdfDocLike> };
  };
  return pdfjs.getDocument({
    data: new Uint8Array(buf),
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
  }).promise;
}

/** Render satu halaman PDF menjadi JPEG (maks sisi ~maxDim px). */
export async function renderPdfPageToJpeg(
  doc: PdfDocLike,
  pageNum: number,
  opts: { maxDim?: number } = {}
): Promise<{ data: Buffer; mime: "image/jpeg" }> {
  const { createCanvas } = await import("@napi-rs/canvas");
  const page = await doc.getPage(pageNum);
  const base = page.getViewport({ scale: 1 });
  const maxDim = opts.maxDim ?? 1600;
  const scale = Math.min(2.2, Math.max(1, maxDim / Math.max(base.width, base.height)));
  const viewport = page.getViewport({ scale });
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  const ctx = canvas.getContext("2d");
  // Latar PUTIH wajib: halaman scan transparan → JPEG hitam tanpa ini.
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({
    canvasContext: ctx,
    viewport,
    canvas,
    background: "#ffffff",
  } as unknown as Record<string, unknown>).promise;
  const jpeg = await canvas.encode("jpeg", 82);
  return { data: Buffer.from(jpeg), mime: "image/jpeg" };
}

// ── Ekstraksi PDF hasil scan per halaman ──────────────────────────────

export interface PdfVisionResult {
  /** Teks gabungan dengan penanda [Halaman N]. */
  text: string;
  /** Jumlah halaman yang berhasil diekstrak. */
  pagesDone: number;
  /** Total halaman dokumen. */
  totalPages: number;
  /** Berhenti karena anggaran waktu / batas halaman. */
  truncated: boolean;
}

export async function extractPdfWithVision(
  buf: Buffer,
  chain: ResolvedAiConfig[],
  opts: {
    maxPages?: number;
    softBudgetMs?: number;
    onPage?: (n: number, text: string) => void;
  } = {}
): Promise<PdfVisionResult> {
  const maxPages = opts.maxPages ?? 24;
  const softBudgetMs = opts.softBudgetMs ?? 90_000;
  const doc = await loadPdfDoc(buf);
  const totalPages = doc.numPages;
  const limit = Math.min(totalPages, maxPages);
  const started = Date.now();
  const parts: string[] = [];
  let pagesDone = 0;
  let truncated = false;

  try {
    for (let i = 1; i <= limit; i++) {
      if (Date.now() - started > softBudgetMs) {
        truncated = true;
        break;
      }
      const img = await renderPdfPageToJpeg(doc, i);
      let text: string;
      try {
        text = (await visionChat(chain, [img], PROMPT_HALAMAN, { maxTokens: 3500, timeoutMs: 60_000 })).text;
      } catch (err) {
        // Halaman pertama gagal total (provider mati) → hentikan seluruh
        // proses; kegagalan sesudah halaman pertama dianggap transien.
        if (i === 1) throw err;
        text = "[halaman ini gagal diekstrak]";
      }
      parts.push(`[Halaman ${i}]\n${text || "[halaman kosong]"}`);
      pagesDone = i;
      opts.onPage?.(i, text);
    }
    if (pagesDone < limit || (totalPages > maxPages && pagesDone === maxPages)) {
      truncated = true;
    }
  } finally {
    void doc.destroy?.().catch(() => {});
  }

  let text = parts.join("\n\n");
  if (truncated) {
    text += `\n\n…[ekstraksi vision berhenti di halaman ${pagesDone} dari ${totalPages}${
      totalPages > maxPages ? " (batas 24 halaman pertama)" : " (anggaran waktu habis)"
    }]`;
  }
  return { text, pagesDone, totalPages, truncated };
}

// ── Extractor untuk ai-extract.ts (lampiran materi) ───────────────────

/**
 * Ekstrak SATU gambar (mode "image": foto lembar soal/screenshot) atau
 * SATU halaman (mode "page": hasil render halaman PDF) — dipakai
 * /api/ai/vision/page (Aula Reader "Bacakan").
 */
export async function visionExtractImage(
  chain: ResolvedAiConfig[],
  image: VisionImage,
  mode: "page" | "image"
): Promise<{ text: string; used: ResolvedAiConfig | null }> {
  const r = await visionChat(chain, [image], mode === "image" ? PROMPT_GAMBAR : PROMPT_HALAMAN, {
    maxTokens: 3500,
    timeoutMs: 100_000,
  });
  return r;
}

export type VisionExtractorInput =
  | { type: "image"; data: Buffer; mime: string }
  | { type: "pdf"; data: Buffer };

export type VisionExtractor = (
  input: VisionExtractorInput
) => Promise<string | null>;

/**
 * Buat extractor vision untuk user (chain kategori vision miliknya /
 * default admin). Return null bila vision tidak aktif atau gagal —
 * pemanggil (ai-extract) memakai teks fallback.
 */
export async function makeVisionExtractor(
  userId: string | null
): Promise<VisionExtractor> {
  const chain = await resolveChain(userId, "vision");
  if (!chain.length) return async () => null;
  return async (input) => {
    try {
      if (input.type === "image") {
        const { text } = await visionChat(chain, [
          { data: input.data, mime: input.mime },
        ], PROMPT_GAMBAR);
        return text || null;
      }
      const r = await extractPdfWithVision(input.data, chain);
      return r.text || null;
    } catch {
      return null;
    }
  };
}
