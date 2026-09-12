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
// POST /api/ai/study — AI untuk Pusat Belajar (Teman Belajar + pembuat
// materi), dipakai tab "Teman AI" dan "Alat Materi".
//
// Provider SAMA dengan Teman AI: kunci sendiri (BYOK, tersimpan
// terenkripsi di server) → default admin. Tidak ada lagi panggilan
// langsung dari browser dengan key di localStorage.
//
// Dua task:
//   task "chat"     → tanya-jawab dengan konteks MATERI + riwayat chat
//   task "material" → tulis materi pelajaran baru dari sebuah topik
//
// Protokol response: NDJSON (sama seperti /api/ai/chat):
//   {"type":"chunk","text":"..."} | {"type":"error","message":"..."} | {"type":"done"}
//
// Riwayat chat study TIDAK disimpan ke DB — tetap di localStorage
// perangkat user (perilaku lama dipertahankan; riwayat Teman AI di menu
// utama memakai AiMessage yang terpisah).
// ─────────────────────────────────────────────────────────────────────

export const runtime = "nodejs";
export const maxDuration = 60;

const TIMEOUT_MS = 55_000; // abort upstream — harus < maxDuration (60 dtk)

const HISTORY_LIMIT = 12; // pesan konteks dari client
const MATERIAL_LIMIT = 20_000; // karakter materi yang diterima server

// Rate limit per user (in-memory, best-effort lintas instance serverless).
const RATE_LIMIT = 20; // permintaan
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

const CHAT_SYSTEM_PROMPT = [
  'Kamu adalah "Teman Belajar" — asisten belajar yang sabar, hangat, dan memotivasi untuk siswa Indonesia.',
  "- Menjelaskan bertahap dengan bahasa sederhana, memakai contoh dan analogi sehari-hari.",
  "- Jika ada MATERI di bawah, utamakan menjawab dari materi itu dan kutip bagian yang relevan.",
  "- Jika ditanya di luar materi, tetap bantu dengan hati-hati.",
  "- Akui bila tidak yakin — jangan mengarang.",
  "- Dorong siswa berpikir sendiri: beri satu pertanyaan pemantik kecil di akhir bila cocok.",
  "Jawab ringkas dan terstruktur (poin-poin), dalam Bahasa Indonesia.",
  "Format jawaban dengan markdown bila membantu (daftar, tebal, blok kode).",
].join("\n");

const MATERIAL_SYSTEM_PROMPT = [
  "Kamu adalah penulis materi pelajaran untuk siswa Indonesia.",
  "Tulis MATERI PEMBELAJARAN lengkap dan berstruktur sesuai permintaan topik.",
  "Aturan:",
  "- Bahasa Indonesia yang jelas dan ramah untuk siswa.",
  "- Struktur markdown: judul dengan '#', bagian dengan '##', poin bertingkat, dan diakhiri bagian '## Rangkuman'.",
  "- Panjang secukupnya (± 600-1200 kata) — padat, tidak bertele-tele.",
  "- Sertakan contoh konkret; tambahkan satu contoh soal + pembahasan bila relevan.",
  "- LANGSUNG mulai dari judul materi — TANPA sapaan atau kalimat pembuka seperti \"Baik, berikut...\".",
  "Output HANYA isi materi (markdown), tanpa penjelasan tambahan apa pun.",
].join("\n");

const FLASHCARDS_SYSTEM_PROMPT = [
  "Kamu pembuat flashcard belajar dari MATERI yang diberikan.",
  "Aturan:",
  "- Buat 8-15 kartu yang menutup konsep PENTING materi (bukan detail sepele).",
  "- Sisi depan: pertanyaan/istilah spesifik dan bermakna sendiri (bukan \"Apa itu X?\" untuk semua kartu — variasikan: definisi, sebab-akibat, perbandingan, proses, contoh).",
  "- Sisi belakang: jawaban 1-3 kalimat, padat dan lengkap, bisa berdiri sendiri.",
  "- Bahasa Indonesia. Kartu harus akurat menurut MATERI (jangan menambah fakta luar).",
  '- Output HANYA array JSON murni: [{"front":"...","back":"..."}] — TANPA penjelasan, TANPA code fence.',
].join("\n");

const QUIZ_SYSTEM_PROMPT = [
  "Kamu pembuat kuis latihan dari MATERI yang diberikan.",
  "Aturan:",
  "- Buat 8-12 soal: mayoritas pilihan ganda, boleh 2-4 soal benar/salah.",
  '- Pilihan ganda: 4 opsi "options" (jawaban benar ikut di dalamnya, urutan ACAK), "answer" = teks opsi yang benar PERSIS, plus "explanation" = pembahasan singkat 1-2 kalimat mengapa benar (merujuk materi).',
  '- Benar/salah: "options" = ["Benar","Salah"], "answer" = "Benar" atau "Salah", plus "explanation" singkat.',
  "- Soal harus jelas berdiri sendiri, menguji pemahaman (bukan hafalan kata persis), akurat menurut MATERI.",
  "- Bahasa Indonesia.",
  '- Output HANYA array JSON murni: [{"type":"mc","question":"...","options":["A","B","C","D"],"answer":"...","explanation":"..."}] — TANPA penjelasan, TANPA code fence.',
].join("\n");

const bodySchema = z.object({
  message: z.string().trim().min(1, "Pesan tidak boleh kosong").max(8000),
  task: z.enum(["chat", "material", "flashcards", "quiz"]).default("chat"),
  material: z.string().max(MATERIAL_LIMIT).optional(),
  history: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().max(8000),
      })
    )
    .max(HISTORY_LIMIT)
    .optional(),
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
  const { message, task, material, history } = parsed.data;

  // ── Config aktif: milik user → default admin (sama seperti Teman AI) ──
  const [userRow, adminRow] = await Promise.all([
    db.aiUserSetting.findUnique({ where: { userId: user.id } }),
    db.appSetting.findUnique({ where: { key: "ai.default" } }),
  ]);
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
  const userSetting: AiSettingInput | null = userRow
    ? {
        provider: userRow.provider,
        baseUrl: userRow.baseUrl,
        apiKey: decryptSecret(userRow.apiKeyEnc),
        model: userRow.model,
      }
    : null;

  const config = resolveAiConfig(userSetting, adminDefault);
  if (!config) {
    return NextResponse.json(
      {
        error:
          "Belum ada AI terpasang — buka Pengaturan untuk memasang kunci API milikmu, atau hubungi admin agar mengatur default.",
      },
      { status: 400 }
    );
  }

  // ── Susun messages sesuai task ──
  const mat = (material ?? "").trim().slice(0, MATERIAL_LIMIT);
  let system: string;
  if (task === "material") {
    system = MATERIAL_SYSTEM_PROMPT;
  } else if (task === "flashcards") {
    if (!mat)
      return NextResponse.json(
        { error: "Materi belum diisi — tempel materi dulu di kolom materi." },
        { status: 400 }
      );
    system = `${FLASHCARDS_SYSTEM_PROMPT}\n\n=== MATERI ===\n${mat}`;
  } else if (task === "quiz") {
    if (!mat)
      return NextResponse.json(
        { error: "Materi belum diisi — tempel materi dulu di kolom materi." },
        { status: 400 }
      );
    system = `${QUIZ_SYSTEM_PROMPT}\n\n=== MATERI ===\n${mat}`;
  } else {
    system = mat
      ? `${CHAT_SYSTEM_PROMPT}\n\n=== MATERI ===\n${mat}`
      : CHAT_SYSTEM_PROMPT;
  }
  const messages: { role: string; content: string }[] = [{ role: "system", content: system }];
  if (task === "chat" && history?.length) {
    for (const h of history.slice(-HISTORY_LIMIT)) {
      messages.push({ role: h.role, content: h.content });
    }
  }
  messages.push({ role: "user", content: message });
  // Task JSON (flashcards/quiz) tidak butuh history & jawabannya hanya
  // JSON — cukup satu turn, user message berisi instruksi singkat.

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
        max_tokens:
          task === "chat" ? 2048 : 4096,
      }),
    });
  } catch {
    clearTimeout(timer);
    req.signal?.removeEventListener("abort", onClientAbort);
    const msg = timedOut
      ? "Waktu tunggu habis — provider tidak merespons dalam waktu cukup. Coba lagi atau ganti model."
      : "Gagal menghubungi server AI. Periksa pengaturan (dan koneksi internet).";
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
            message: "AI tidak mengirim jawaban (respons kosong). Coba lagi atau ganti model di pengaturan.",
          });
        }
      } catch {
        if (!clientAborted && !controller.signal.aborted) {
          send({
            type: "error",
            message: timedOut
              ? "Waktu tunggu habis — provider berhenti di tengah jawaban. Coba lagi."
              : "Koneksi ke provider terputus di tengah jawaban. Coba lagi.",
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
