import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/session";
import { db } from "@/lib/db";
import { decryptSecret } from "@/lib/crypto";
import { chatEndpoint, cleanUpstreamDetail, resolveAiConfig, type AiSettingInput } from "@/lib/ai-providers";

export const runtime = "nodejs";
export const maxDuration = 60;

// ─────────────────────────────────────────────────────────────────────
// POST /api/ai/chat — chat streaming Teman AI (BYOK / default admin).
//
// Protokol response: NDJSON (satu event JSON per baris):
//   {"type":"chunk","text":"..."}  → potongan jawaban
//   {"type":"error","message":"..."} → error saat streaming
//   {"type":"done"}                 → selesai sukses
// Error sebelum stream mulai dikirim sebagai status HTTP + JSON biasa.
// ─────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT =
  "Kamu adalah Teman AI Aula — teman belajar yang ramah untuk siswa Indonesia. " +
  "Jawab ringkas dan jelas. Gunakan Bahasa Indonesia, kecuali pengguna memakai bahasa lain. " +
  "Bantu mengerjakan dan menjelaskan materi sekolah dengan sabar (jangan hanya memberi jawaban akhir, " +
  "jelaskan langkahnya). Format jawaban dengan markdown bila membantu (daftar, tebal, blok kode).";

const TIMEOUT_MS = 55_000; // abort upstream — HARUS < maxDuration (60 dtk);
                       // dulu 90 dtk: platform memotong duluan di 60 dtk →
                       // stream terputus tanpa event error/done & jawaban
                       // parsial tak pernah tersimpan.
const HISTORY_LIMIT = 20;

// Rate limit sederhana per user (in-memory; best-effort lintas instance
// serverless) — tanpa ini siswa bisa spam loop dan membakar kredit
// kunci default admin.
const RATE_LIMIT = 20; // pesan
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

const bodySchema = z.object({
  message: z.string().trim().min(1, "Pesan tidak boleh kosong").max(8000),
});

function providerErrorMessage(status: number, detailRaw: string | null): string {
  const detail = cleanUpstreamDetail(detailRaw);
  if (status === 401 || status === 403) {
    return "API key tidak valid/ditolak provider. Periksa kunci API di pengaturan Teman AI" +
      (detail ? ` (${detail.slice(0, 160)})` : "") +
      ".";
  }
  if (status === 429) {
    return (
      "Model sedang kena limit (429) — API key kamu tidak bermasalah. " +
      "Model berakhiran ‘:free’ berbagi kuota publik yang sering penuh; " +
      "tunggu beberapa menit, atau ganti ke model lain di pengaturan (mis. tanpa ‘:free’)." +
      (detail ? ` (${detail.slice(0, 160)})` : "")
    );
  }
  if (status === 402) {
    return "Kredit provider tidak cukup (402). Tambah kredit akun provider, atau pilih model gratis (:free) di pengaturan.";
  }
  if (status === 404) {
    return "Endpoint/model tidak ditemukan di provider (404). Periksa Base URL dan nama model di pengaturan.";
  }
  if (detail && /location is not supported|blokir wilayah/i.test(detail)) {
    return "Model ini menolak permintaan dari lokasi server (pembatasan wilayah provider). Ganti ke model lain di pengaturan — API key kamu tidak bermasalah.";
  }
  return `Provider AI menjawab error (HTTP ${status})${detail ? `: ${detail.slice(0, 160)}` : ""}.`;
}

export async function POST(req: NextRequest) {
  const user = await requireUser().catch(() => null);
  if (!user) return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });

  if (rateLimited(user.id)) {
    return NextResponse.json(
      { error: "Terlalu banyak pesan beruntun — tunggu sebentar lalu coba lagi." },
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
  const message = parsed.data.message;

  // ── Config aktif: milik user → default admin ──
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
          "Belum ada AI terpasang — buka Pengaturan Teman AI untuk memasang kunci API milikmu, atau hubungi admin agar mengatur default.",
      },
      { status: 400 }
    );
  }

  // ── Riwayat (20 terakhir) + simpan pesan user baru ──
  const older = await db.aiMessage.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: "desc" },
    take: HISTORY_LIMIT,
    select: { role: true, content: true },
  });
  const history = older
    .reverse()
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

  const saved = await db.aiMessage.create({
    data: { userId: user.id, role: "user", content: message },
  });

  // ── Panggil provider (kompatibel OpenAI chat completions, SSE) ──
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, TIMEOUT_MS);

  // User menekan Stop / menutup halaman → hentikan upstream.
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
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          ...history,
          { role: "user", content: message },
        ],
        stream: true,
        max_tokens: 2048,
      }),
    });
  } catch (err) {
    clearTimeout(timer);
    req.signal?.removeEventListener("abort", onClientAbort);
    const msg = timedOut
      ? "Waktu tunggu habis — provider tidak merespons dalam waktu cukup. Coba lagi atau ganti model."
      : "Gagal menghubungi server AI. Periksa Base URL di pengaturan (dan koneksi internet).";
    return NextResponse.json({ error: msg, detail: String((err as Error)?.name ?? "") }, { status: 502 });
  }

  // Error sebelum stream mulai → balas sebagai status HTTP (bukan stream).
  // Timer TIDAK di-clear sebelum body error terbaca — dulu: upstream.json()
  // tanpa batas waktu bisa menggantung sampai platform memotong (60 dtk).
  if (!upstream.ok) {
    let detail: string | null = null;
    try {
      const errJson = await upstream.json().catch(() => null);
      // OpenRouter menyimpan alasan asli di error.metadata.raw — pakai itu dulu.
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
  let full = "";
  let assistantSaved = false;
  const saveAssistant = async (text: string) => {
    if (assistantSaved || !text.trim()) return;
    assistantSaved = true;
    try {
      await db.aiMessage.create({ data: { userId: user.id, role: "assistant", content: text } });
    } catch {
      /* best-effort */
    }
  };

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
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop() ?? ""; // sisa baris belum lengkap
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) continue;
            const data = trimmed.slice(5).trim();
            if (!data || data === "[DONE]") continue;
            try {
              const json = JSON.parse(data);
              const delta: unknown = json?.choices?.[0]?.delta?.content;
              if (typeof delta === "string" && delta.length > 0) {
                full += delta;
                send({ type: "chunk", text: delta });
              }
            } catch {
              /* baris SSE rusak — abaikan */
            }
          }
        }

        if (full.trim()) {
          await saveAssistant(full);
          send({ type: "done" });
        } else {
          send({
            type: "error",
            message:
              "Teman AI tidak mengirim jawaban (respons kosong). Coba lagi atau ganti model di pengaturan.",
          });
        }
      } catch (err) {
        if (clientAborted || controller.signal.aborted) {
          // Stop dari user / koneksi terputus → simpan potongan yang sudah ada.
          await saveAssistant(full);
        } else {
          send({
            type: "error",
            message: timedOut
              ? "Waktu tunggu habis — provider berhenti di tengah jawaban. Potongan yang sudah masuk tetap disimpan."
              : "Koneksi ke provider terputus di tengah jawaban. Coba lagi.",
          });
          await saveAssistant(full);
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
      // Simpan potongan jawaban yang sudah diterima (opsional tapi berguna).
      void saveAssistant(full);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
      "X-Ai-Message-Id": saved.id,
    },
  });
}
