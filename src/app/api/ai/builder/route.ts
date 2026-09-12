import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/session";
import { db } from "@/lib/db";
import { decryptSecret } from "@/lib/crypto";
import {
  chatEndpoint,
  providerErrorMessage,
  resolveAiConfig,
  type AiSettingInput,
} from "@/lib/ai-providers";

// ─────────────────────────────────────────────────────────────────────
// POST /api/ai/builder — AI Builder (Pusat Belajar → tab AI Builder).
//
// Tugas AI: MENULIS KODE HTML/CSS/JS untuk siswa. Siswa menjelaskan
// aplikasi yang diinginkan (mis. "platform tes kecepatan mengetik"),
// AI menulis SATU dokumen HTML lengkap (CSS di <style>, JS di <script>)
// yang langsung bisa dijalankan di pratinjau sandbox.
//
// Provider DIPISAH dari Teman AI: hanya membaca AppSetting "ai.builder"
// (diatur admin di Admin Panel → tab AI Builder). Tidak ada BYOK user.
//
// Protokol response: NDJSON (sama seperti /api/ai/chat dan /api/ai/study):
//   {"type":"chunk","text":"..."} | {"type":"error","message":"..."} | {"type":"done"}
// ─────────────────────────────────────────────────────────────────────

export const runtime = "nodejs";
export const maxDuration = 60;

const TIMEOUT_MS = 55_000; // abort upstream — harus < maxDuration (60 dtk)

const CURRENT_HTML_LIMIT = 150_000; // karakter kode yang dikirim balik utk diedit

// Rate limit per user — generate kode lebih mahal dari chat biasa.
const RATE_LIMIT = 8; // permintaan
const RATE_WINDOW_MS = 60_000; // per menit
const rateHits = new Map<string, { n: number; reset: number }>();
function rateLimited(userId: string): boolean {
  const now = Date.now();
  const h = rateHits.get(userId);
  if (!h || h.reset < now) {
    rateHits.set(userId, { n: 1, reset: now + RATE_WINDOW_MS });
    return false;
  }
  h.n += 1;
  return h.n > RATE_LIMIT;
}

const SYSTEM_PROMPT = [
  'Kamu adalah "AI Builder" — web developer ahil yang menulis aplikasi web kecil untuk siswa Indonesia.',
  "",
  "TUGAS: tulis SATU dokumen HTML lengkap sesuai permintaan siswa.",
  "",
  "ATURAN KODE (WAJIB):",
  "- Satu file HTML mandiri: semua CSS di dalam <style>, semua JavaScript di dalam <script> (di dalam <body> atau <head>).",
  "- Mulai persis dengan <!DOCTYPE html> dan akhiri dengan </html>. JANGAN ada teks lain sebelum/sesudahnya.",
  "- JANGAN pakai localStorage, sessionStorage, cookie, fetch/XHR ke server, atau library eksternal (CDN).",
  "  (Kode dijalankan di pratinjau sandbox — simpan data di variabel JavaScript biasa.)",
  "- Harus responsif (bisa dipakai di HP) dan enak dipandang: gunakan CSS modern, warna, sudut membulat, bayangan halus.",
  "- Semua teks antarmuka dalam Bahasa Indonesia.",
  "- Kode rapi dan DIBERI KOMENTAR BAHASA INDONESIA singkat per bagian supaya siswa bisa belajar.",
  "- Elemen input (tombol/ kotak teks) harus benar-benar berfungsi; tidak boleh ada tombol mati.",
  "- Nama file yang dibuat: beri <title> yang jelas dan singkat.",
  "",
  "Bila ada KODE SAAT INI di bawah, siswa ingin MENGUBAH kode itu — tulis ulang SELURUH dokumen",
  "dengan perubahan yang diminta (jangan potong bagian yang tidak diubah).",
  "",
  "OUTPUT: HANYA dokumen HTML mulai dari <!DOCTYPE html> — TANPA penjelasan, TANPA sapaan,",
  "TANPA blok kode markdown (```). Langsung kodenya saja.",
].join("\n");

const bodySchema = z.object({
  message: z.string().trim().min(1, "Pesan tidak boleh kosong").max(6000),
  // Kode saat ini (untuk permintaan ubah/lanjut). Kosong = buat baru.
  currentHtml: z.string().max(CURRENT_HTML_LIMIT).optional(),
});

export async function POST(req: NextRequest) {
  const user = await requireUser().catch(() => null);
  if (!user) return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });

  if (rateLimited(user.id)) {
    return NextResponse.json(
      { error: "Terlalu banyak permintaan beruntun — tunggu sebentar lalu coba lagi." },
      { status: 429 }
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Data tidak valid" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    const first = parsed.error.issues[0]?.message ?? "Data tidak valid";
    return NextResponse.json({ error: first }, { status: 400 });
  }
  const { message, currentHtml } = parsed.data;

  // ── Config aktif: HANYA default admin "ai.builder" (dipisah dari Teman AI) ──
  const adminRow = await db.appSetting.findUnique({ where: { key: "ai.builder" } });
  let adminDefault: AiSettingInput | null = null;
  if (adminRow) {
    try {
      const raw = JSON.parse(adminRow.value) as {
        provider?: string;
        baseUrl?: string | null;
        apiKeyEnc?: string | null;
        model?: string | null;
      };
      adminDefault = {
        provider: raw.provider ?? "",
        baseUrl: raw.baseUrl ?? null,
        apiKey: decryptSecret(raw.apiKeyEnc ?? null),
        model: raw.model ?? null,
      };
    } catch {
      adminDefault = null;
    }
  }

  const config = resolveAiConfig(null, adminDefault);
  if (!config) {
    return NextResponse.json(
      {
        error:
          "AI Builder belum diatur — hubungi admin untuk mengatur provider di Admin Panel → AI Builder.",
      },
      { status: 400 }
    );
  }

  // ── Susun messages ──
  const cur = (currentHtml ?? "").trim();
  const system = cur
    ? `${SYSTEM_PROMPT}\n\n=== KODE SAAT INI (ubah sesuai permintaan terakhir) ===\n${cur}`
    : SYSTEM_PROMPT;
  const messages: { role: string; content: string }[] = [
    { role: "system", content: system },
    { role: "user", content: message },
  ];

  // ── Panggil provider (kompatibel OpenAI chat completions, SSE) ──
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, TIMEOUT_MS);

  // User menutup halaman / menekan batal → hentikan upstream.
  let clientAborted = false;
  const onClientAbort = () => {
    clientAborted = true;
    controller.abort();
  };
  req.signal?.addEventListener("abort", onClientAbort);

  let upstream: Response;
  try {
    upstream = await fetch(chatEndpoint(config.baseUrl), {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: config.model,
        messages,
        stream: true,
        max_tokens: 8000,
      }),
    });
  } catch {
    clearTimeout(timer);
    req.signal?.removeEventListener("abort", onClientAbort);
    const msg = timedOut
      ? "Waktu tunggu habis — provider tidak merespons dalam waktu cukup. Coba lagi atau ganti model."
      : "Gagal menghubungi server AI. Periksa koneksi internet.";
    return NextResponse.json({ error: msg }, { status: 502 });
  }

  if (!upstream.ok) {
    let detail: string | null = null;
    try {
      const errJson = await upstream.json().catch(() => null);
      detail =
        errJson?.error?.metadata?.raw ??
        errJson?.error?.message ??
        errJson?.message ??
        null;
      if (typeof detail !== "string") detail = null;
    } catch {
      /* abaikan */
    }
    clearTimeout(timer);
    req.signal?.removeEventListener("abort", onClientAbort);
    return NextResponse.json(
      { error: providerErrorMessage(upstream.status, detail) },
      { status: 502 }
    );
  }
  if (!upstream.body) {
    clearTimeout(timer);
    req.signal?.removeEventListener("abort", onClientAbort);
    return NextResponse.json(
      { error: "Provider tidak mengirim respons yang bisa dibaca (stream kosong)." },
      { status: 502 }
    );
  }

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(ctl) {
      const send = (obj: Record<string, unknown>) => {
        try {
          ctl.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
        } catch {
          /* stream sudah ditutup client */
        }
      };
      const reader = upstream.body!.getReader();
      let buf = "";
      let got = false;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop() ?? "";
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) continue;
            const data = trimmed.slice(5).trim();
            if (!data || data === "[DONE]") continue;
            try {
              const json = JSON.parse(data);
              const delta: unknown = json?.choices?.[0]?.delta?.content;
              if (typeof delta === "string" && delta.length > 0) {
                got = true;
                send({ type: "chunk", text: delta });
              }
            } catch {
              /* baris SSE rusak — abaikan */
            }
          }
        }

        if (got) {
          send({ type: "done" });
        } else {
          send({
            type: "error",
            message: "AI tidak mengirim kode (respons kosong). Coba lagi atau ganti model di pengaturan.",
          });
        }
      } catch {
        if (!clientAborted && !controller.signal.aborted) {
          send({
            type: "error",
            message: timedOut
              ? "Waktu tunggu habis — provider berhenti di tengah penulisan kode. Coba lagi."
              : "Koneksi ke provider terputus di tengah penulisan kode. Coba lagi.",
          });
        }
      } finally {
        clearTimeout(timer);
        req.signal?.removeEventListener("abort", onClientAbort);
        try {
          ctl.close();
        } catch {
          /* sudah tertutup */
        }
      }
    },
    cancel() {
      clientAborted = true;
      controller.abort();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
