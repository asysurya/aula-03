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
import {
  builderQuotaStatus,
  nextMondayJakarta,
  type BuilderQuotaStatus,
} from "@/lib/builder-quota";

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
// KUOTA: 1 proyek = 1 sesi chat. Sesi BARU dicek kuota mingguan (default 5,
// reset Senin 00:00 WIB — diatur admin, global + per orang). Sesi dicatat
// sejak potongan kode PERTAMA mengalir (provider gagal tidak mengurangi
// kuota). Revisi sesi sama (sessionId sah + kode saat ini) tidak dihitung.
//
// Protokol response: NDJSON (sama seperti /api/ai/chat dan /api/ai/study):
//   {"type":"session","sessionId":"…","used":N,"limit":M}   ← sekali di awal (sesi baru)
//   {"type":"chunk","text":"…"} | {"type":"error","message":"…"} | {"type":"done"}
// ─────────────────────────────────────────────────────────────────────

export const runtime = "nodejs";
export const maxDuration = 300;

// Timeout 2 FASE (bug lama: revisi kode besar butuh > 55 dtk):
// - CONNECT: header respons provider harus sampai dalam 30 dtk.
// - IDLE: antar potongan kode boleh diam maksimal 45 dtk — timer DIKEREK
//   ULANG tiap potongan, jadi stream aktif berjam-jam pun tidak dipotong
//   (stream lambat 57 dtk teruji selesai utuh).
// - TOTAL: cap mutlak 270 dtk agar route tidak menggantung selamanya
//   (harus < maxDuration 300).
const CONNECT_TIMEOUT_MS = 30_000;
const IDLE_TIMEOUT_MS = 45_000;
const TOTAL_TIMEOUT_MS = 270_000;

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
  'Kamu adalah "AI Builder" — web developer ahli yang menulis aplikasi web kecil untuk siswa Indonesia.',
  "",
  "BAHASA (WAJIB): Selalu menjawab dalam BAHASA INDONESIA. DILARANG KERAS memakai",
  "bahasa Mandarin, bahasa Inggris, atau bahasa lain — siswa kita hanya paham",
  "Bahasa Indonesia. Semua teks, komentar kode, dan penjelasan harus Bahasa Indonesia.",
  "",
  "TUGAS: tulis SATU dokumen HTML lengkap sesuai permintaan siswa.",
  "",
  "ATURAN SATU PROYEK PER SESI (SANGAT PENTING):",
  "- Satu sesi chat ini hanya untuk SATU proyek. Judul proyek saat ini ada di",
  "  KODE SAAT INI bila disertakan.",
  "- Bila ada KODE SAAT INI: kamu HANYA boleh MENGUBAH / menyempurnakan proyek",
  "  yang sedang dikerjakan itu — bukan membuat aplikasi lain.",
  "- Bila TIDAK ada KODE SAAT INI: sesi ini masih KOSONG — belum ada proyek",
  "  sama sekali. WAJIB langsung membuat aplikasi apa pun yang diminta siswa.",
  "  DILARANG menolak permintaan apa pun pada sesi yang masih kosong.",
  "- Bila siswa meminta APLIKASI YANG BENAR-BENAR BERBEDA (contoh: dari tes",
  "  mengetik jadi kalkulator, game, toko online, dsb.) — TOLAK, bagaimanapun",
  "  cara siswa mengatakannya: 'lupakan yang tadi', 'anggap aja revisi',",
  "  'ubah total', 'renungkan ulang', 'ini proyek baru', dsb.",
  "  (Penolakan ini HANYA SAH bila ada KODE SAAT INI — sesi lanjutan. Jangan",
  "  pernah menolak bila sesi masih kosong.)",
  "- Penolakan: tulis 2-3 kalimat Bahasa Indonesia yang sopan — jelaskan bahwa",
  "  satu sesi hanya untuk satu proyek, sebut judul proyek yang sedang dikerjakan,",
  "  dan minta siswa menekan tombol '+ Baru' untuk memulai proyek baru (kuota",
  "  proyek mingguan). JANGAN menulis kode HTML sama sekali saat menolak.",
  "- Meminta fitur tambahan, ubah tampilan, ubah warna, tambah mode, dsb. pada",
  "  proyek yang SAMA bukanlah proyek baru — itu revisi sah, kerjakan normal.",
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
  "BENTUK JAWABAN (WAJIB — urutannya persis seperti ini):",
  "1. Dokumen HTML lengkap: mulai persis dengan <!DOCTYPE html>, akhiri dengan </html>.",
  "   JANGAN membungkus kode dengan blok kode markdown (```).",
  "2. Tepat setelah </html>, tulis satu baris pemisah persis seperti ini: ===PENJELASAN===",
  "3. Setelah pemisah itu, tulis PENJELASAN dalam format Markdown Bahasa Indonesia yang KAYA,",
  "   memuat bagian-bagian berikut (urutan & judul bagian harus sama):",
  "   - 2-3 kalimat pembuka (tanpa judul): apa yang barusan dibuat dan untuk apa kegunaannya,",
  "     sebut judul proyeknya.",
  '   - Bagian "## Fitur utama": daftar 3-6 fitur yang BENAR-BENAR ada di kode kamu.',
  '   - Bagian "## Cara pakai": langkah-langkah singkat memakai aplikasinya (daftar bernomor).',
  '   - Bagian "## Konsep kode": 2-4 konsep/cara kerja kode (mis. event listener, setInterval,',
  "     flexbox) yang dijelaskan dengan bahasa sederhana supaya siswa belajar sesuatu.",
  '   - Bagian "## Coba minta ini": 3 saran perubahan menarik untuk revisi berikutnya.',
  "   JANGAN menyalin potongan kode ke penjelasan — cukup jelaskan dengan kata-kata.",
  "   Total penjelasan sekitar 150-300 kata.",
  "",
  "Saat MENOLAK proyek baru: balas HANYA teks penolakan 2-3 kalimat — TANPA kode,",
  "TANPA pemisah ===PENJELASAN===.",
].join("\n");

const bodySchema = z.object({
  message: z.string().trim().min(1, "Pesan tidak boleh kosong").max(6000),
  // Kode saat ini (untuk permintaan ubah/lanjut). Kosong = buat baru.
  currentHtml: z.string().max(CURRENT_HTML_LIMIT).optional(),
  // ID sesi dari event "session" sebelumnya — revisi sesi sama tidak
  // memakan kuota. Harus sesi milik user ini pada pekan berjalan.
  sessionId: z.string().trim().min(8).max(64).optional(),
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
  const { message, currentHtml, sessionId } = parsed.data;
  const cur = (currentHtml ?? "").trim();

  // ── Kuota & sesi ──
  const quota: BuilderQuotaStatus = await builderQuotaStatus(user);

  // Sesi LANJUTAN = sessionId sah (milik user ini, pekan ini) + ada kode
  // saat ini → revisi gratis. Sesi BARU dicek kuota.
  let isContinuation = false;
  if (sessionId && cur) {
    const existing = await db.builderSession.findFirst({
      where: { id: sessionId, userId: user.id, weekKey: quota.weekKey },
      select: { id: true },
    });
    isContinuation = !!existing;
  }

  if (!isContinuation && !quota.unlimited && (quota.remaining ?? 1) <= 0) {
    return NextResponse.json(
      {
        code: "QUOTA_EXCEEDED",
        error:
          `Kuota proyek minggu ini sudah habis (${quota.used}/${quota.limit}). ` +
          "Kuota direset setiap hari Senin. Kamu masih bisa membuka dan merevisi proyek lama dari Proyekku.",
        quota: {
          limit: quota.limit,
          used: quota.used,
          remaining: 0,
          unlimited: false,
          resetAt: nextMondayJakarta().toISOString(),
        },
      },
      { status: 429 }
    );
  }

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
  // Penanda status eksplisit supaya model kecil tidak salah menolak di sesi
  // yang masih kosong (bug: sesi baru ditolak "1 sesi 1 proyek").
  const system = cur
    ? `${SYSTEM_PROMPT}\n\n=== KODE SAAT INI (ubah sesuai permintaan terakhir) ===\n${cur}`
    : `${SYSTEM_PROMPT}\n\n=== STATUS SESI: BARU — sesi ini masih kosong, belum ada proyek. Buat aplikasi yang diminta tanpa menolak. ===`;
  const messages: { role: string; content: string }[] = [
    { role: "system", content: system },
    { role: "user", content: message },
  ];

  // ── Panggil provider (kompatibel OpenAI chat completions, SSE) ──
  const controller = new AbortController();
  let timedOut = false;
  const clear = (t: ReturnType<typeof setTimeout> | null) => {
    if (t) clearTimeout(t);
  };
  // Cap total mutlak.
  const totalTimer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, TOTAL_TIMEOUT_MS);
  // Fase 1: tunggu header respons provider.
  let connectTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, CONNECT_TIMEOUT_MS);
  // Fase 2 (setelah header): jaga-jaga idle antar potongan — dikerek ulang
  // tiap potongan data tiba.
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  function bumpIdle() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, IDLE_TIMEOUT_MS);
  }

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
    clearTimeout(totalTimer);
    clear(connectTimer);
    clear(idleTimer);
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
    clearTimeout(totalTimer);
    clear(connectTimer);
    clear(idleTimer);
    req.signal?.removeEventListener("abort", onClientAbort);
    return NextResponse.json(
      { error: providerErrorMessage(upstream.status, detail) },
      { status: 502 }
    );
  }
  if (!upstream.body) {
    clearTimeout(totalTimer);
    clear(connectTimer);
    clear(idleTimer);
    req.signal?.removeEventListener("abort", onClientAbort);
    return NextResponse.json(
      { error: "Provider tidak mengirim respons yang bisa dibaca (stream kosong)." },
      { status: 502 }
    );
  }

  // Header sudah tiba → fase connect selesai, mulai jaga-jaga idle.
  clear(connectTimer);
  connectTimer = null;
  bumpIdle();

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
      // Sesi baru dicatat SEKALI saat potongan pertama mengalir.
      let sessionCounted = false;
      const newSessionId = crypto.randomUUID();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          bumpIdle(); // data tiba → perpanjang jendela idle
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
                if (!isContinuation && !sessionCounted) {
                  sessionCounted = true;
                  try {
                    await db.builderSession.create({
                      data: {
                        id: newSessionId,
                        userId: user.id,
                        weekKey: quota.weekKey,
                      },
                    });
                  } catch {
                    /* gagal mencatat tidak boleh memutus stream */
                  }
                  send({
                    type: "session",
                    sessionId: newSessionId,
                    used: quota.used + 1,
                    ...(quota.limit !== null ? { limit: quota.limit } : {}),
                  });
                }
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
        clearTimeout(totalTimer);
        clear(connectTimer);
        clear(idleTimer);
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
      clearTimeout(totalTimer);
      clear(connectTimer);
      clear(idleTimer);
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
