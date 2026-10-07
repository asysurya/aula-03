import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/session";
import { db } from "@/lib/db";
import { providerErrorMessage } from "@/lib/ai-providers";
import { resolveAttachmentContext } from "@/lib/ai-attachments";
import {
  resolveChain,
  tryChatCompletion,
  summarizeFailures,
} from "@/lib/ai-config-chain";
import { webSearchForContext, MAX_QUERY_LEN } from "@/lib/ddg-search";

export const runtime = "nodejs";
export const maxDuration = 120;

// ─────────────────────────────────────────────────────────────────────
// POST /api/ai/chat — chat streaming Teman AI.
//
// Protokol response: NDJSON (satu event JSON per baris):
//   {"type":"chunk","text":"..."}  → potongan jawaban
//   {"type":"error","message":"..."} → error saat streaming
//   {"type":"done"}                 → selesai sukses
// Error sebelum stream mulai dikirim sebagai status HTTP + JSON biasa.
//
// Task 29:
//   • Config kategori "chat" dengan RANTAI FALLBACK berurutan —
//     entri #1 gagal (jaringan/HTTP) → otomatis coba entri #2, dst.
//   • Lampiran materi & hasil pencarian web disisipkan sebagai PESAN
//     USER (pola user→assistant ack) — jauh lebih andal dibaca model
//     daripada ditempel di system prompt (bug "aku suruh kerjain
//     nomor 16 dia gak tau apa-apa soalnya").
//   • Pencarian web DuckDuckGo: perintah "/cari …" "/search …" "/web …"
//     atau deteksi otomatis (berita terbaru, googling, dsb.).
//   • Prompt sistem menyuruh model menulis rumus dalam LaTeX.
// ─────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT =
  "Kamu adalah Teman AI Aula — teman belajar yang ramah untuk siswa Indonesia. " +
  "Jawab ringkas dan jelas. Gunakan Bahasa Indonesia, kecuali pengguna memakai bahasa lain. " +
  "Bantu mengerjakan dan menjelaskan materi sekolah dengan sabar (jangan hanya memberi jawaban akhir, " +
  "jelaskan langkahnya). Format jawaban dengan markdown bila membantu (daftar, tebal, tabel, blok kode).\n\n" +
  "RUMUS: tulis setiap rumus matematika/fisika/kimia dalam LaTeX — inline dengan $...$ " +
  "(mis. $V_p I_p = V_s I_s$, $x^2 + 2x + 1$, $\\frac{1}{2}gt^2$, $H_2O$, $\\sqrt{a^2+b^2}$) " +
  "dan rumus besar/tampil dengan $$...$$. JANGAN menulis rumus sebagai teks polos seperti V_p I_p tanpa tanda $.\n\n" +
  "MATERI LAMPIRAN: pesan yang memuat blok === MATERI LAMPIRAN === adalah materi/soal yang dilampirkan " +
  "pengguna (bisa soal ujian bernomor). BACA dan GUNAKAN isinya untuk menjawab — kalau pengguna minta " +
  "'kerjakan nomor 16', cari soal bernomor 16 di materi itu lalu kerjakan; JANGAN bilang tidak tahu " +
  "sebelum mencari di materi lampiran.\n\n" +
  "PENCARIAN WEB: pesan yang memuat blok === HASIL PENCARIAN WEB === adalah hasil pencarian terkini. " +
  "Gunakan sebagai rujukan utama untuk hal terkini dan sebut sumbernya dengan [1], [2], dsb.";

const TIMEOUT_MS = 50_000; // per entri fallback
const OVERALL_TIMEOUT_MS = 110_000; // total — HARUS < maxDuration (120 dtk)
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
  // Lampiran materi: id AiAttachment (upload /api/ai/attachments) +
  // materi teks manual — digabung server sebagai konteks tambahan.
  attachmentIds: z.array(z.string()).max(8).optional(),
  materialText: z.string().max(20_000).optional(),
});

// ── Deteksi maksud pencarian web (DDG) ────────────────────────────────

/** Perintah eksplisit: "/cari …", "/search …", "/web …", "/google …". */
const SEARCH_CMD = /^\/(?:cari|search|web|google|googling)\s+([\s\S]+)/i;

/** Sinyal otomatis (berita terkini, suruh googling, dsb.). */
const SEARCH_AUTO =
  /\b(?:cari(?:kan)?\s+(?:di\s+)?(?:google|internet|web|online|net)|googling(?:kan)?|search\s+(?:di\s+)?(?:web|internet|online)|berita\s+(?:terbaru|terkini|hari\s+ini)|hari\s+ini\s+(?:apa|siapa|berapa)|tren\s+(?:sekarang|terbaru)|sedang\s+tren|kapan\s+(?:sekarang|tahun\s+ini)\b.*\?)/i;

interface SearchIntent {
  active: boolean;
  query: string;
}

function detectSearchIntent(message: string): SearchIntent {
  const cmd = SEARCH_CMD.exec(message);
  if (cmd) {
    return { active: true, query: cmd[1].trim().slice(0, MAX_QUERY_LEN) };
  }
  if (SEARCH_AUTO.test(message)) {
    return { active: true, query: message.trim().slice(0, MAX_QUERY_LEN) };
  }
  return { active: false, query: "" };
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

  // ── Lampiran materi (teks & file format apa pun) ──
  const attachCtx = await resolveAttachmentContext(
    user.id,
    parsed.data.attachmentIds ?? [],
    parsed.data.materialText
  ).catch(() => null);

  // ── Pencarian web DuckDuckGo (perintah /cari + deteksi otomatis) ──
  const intent = detectSearchIntent(message);
  const search = intent.active
    ? await webSearchForContext(intent.query).catch(() => null)
    : null;

  // ── Config chain kategori chat (user → admin; fallback berurutan) ──
  const chain = await resolveChain(user.id, "chat");
  if (!chain.length) {
    return NextResponse.json(
      {
        error:
          "Belum ada AI terpasang — buka Pengaturan AI untuk memasang kunci API milikmu (kategori Chat), atau hubungi admin agar mengatur default.",
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

  // ── Susun pesan: pola user→assistant ack untuk lampiran & pencarian ──
  // (dulu konteks lampiran ditempel di system prompt — model lemah kerap
  // mengabaikannya; pola pesan eksplisit terbaca jauh lebih konsisten)
  type Msg = { role: "system" | "user" | "assistant"; content: string };
  const msgs: Msg[] = [{ role: "system", content: SYSTEM_PROMPT }, ...history];
  if (attachCtx) {
    msgs.push({
      role: "user",
      content: `Aku melampirkan materi berikut:\n\n${attachCtx}`,
    });
    msgs.push({
      role: "assistant",
      content:
        "Materi lampiran diterima. Aku akan membaca isinya dulu sebelum menjawab.",
    });
  }
  if (search) {
    msgs.push({
      role: "user",
      content: `Cari info terbaru di web. Ini hasil pencariannya:\n\n${search.block}`,
    });
    msgs.push({
      role: "assistant",
      content: "Hasil pencarian diterima. Aku akan merujuk sumbernya bila relevan.",
    });
  }
  msgs.push({ role: "user", content: message });

  // ── Panggil provider (fallback berurutan, SSE) ──
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, OVERALL_TIMEOUT_MS);

  // User menekan Stop / menutup halaman → hentikan upstream.
  let clientAborted = false;
  const onClientAbort = () => {
    clientAborted = true;
    controller.abort();
  };
  req.signal?.addEventListener("abort", onClientAbort);

  const attempt = await tryChatCompletion(
    chain,
    { messages: msgs, stream: true, max_tokens: 3000 },
    { signal: controller.signal, timeoutMs: TIMEOUT_MS }
  );
  const upstream = attempt.response;

  if (!upstream || !upstream.body) {
    clearTimeout(timer);
    req.signal?.removeEventListener("abort", onClientAbort);
    if (clientAborted) {
      return new Response(null, { status: 499 });
    }
    const fails = summarizeFailures(attempt.failures);
    const last = attempt.failures[attempt.failures.length - 1];
    const friendly = last?.status
      ? providerErrorMessage(last.status, last.detail)
      : "Gagal menghubungi server AI. Periksa Base URL di pengaturan (dan koneksi internet).";
    return NextResponse.json(
      {
        error:
          `Semua config AI (kategori Chat) gagal — ${fails}. ` +
          `${friendly} ${timedOut ? "(waktu tunggu habis)" : ""}`.trim(),
      },
      { status: 502 }
    );
  }

  const config = attempt.config!;

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let full = "";
  let assistantSaved = false;
  const saveAssistant = async (text: string) => {
    if (assistantSaved || !text.trim()) return;
    assistantSaved = true;
    try {
      const created = await db.aiMessage.create({
        data: { userId: user.id, role: "assistant", content: text },
      });
      // Pengaman "ingatan hidup lagi": user bisa mengosongkan riwayat lewat
      // ikon sampah saat jawaban ini masih mengalir. Simpan-cek-hapus: jika
      // pesan user PEMICU jawaban ini sudah tidak ada di DB (terhapus oleh
      // DELETE /api/ai/history), buang juga potongan jawaban ini — urutan
      // apa pun antara create dan deleteMany tetap konsisten.
      const trigger = await db.aiMessage.findUnique({
        where: { id: saved.id },
        select: { id: true },
      });
      if (!trigger) {
        await db.aiMessage.delete({ where: { id: created.id } }).catch(() => {});
      }
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
      // Entri chain mana yang menjawab (transparansi fallback).
      "X-Ai-Provider": config.provider,
      "X-Ai-Model": config.model,
    },
  });
}
