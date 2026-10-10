import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/session";
import { synthesizeSpeech, MAX_TTS_TEXT, DEFAULT_TTS_VOICE } from "@/lib/ai-tts";

export const runtime = "nodejs";
export const maxDuration = 120;

// ─────────────────────────────────────────────────────────────────────
// POST /api/ai/tts — sintesis suara AI (mode "Suara AI" Aula Reader).
// Body: { text, voice?, waitDownload? }
// Respons: audio (audio/mpeg dari provider / audio/wav dari Piper lokal)
// + header X-Ai-Tts-Source / X-Ai-Tts-Model.
// 423 bila aset Piper lokal belum terunduh (klien memanggil /prepare).
// ─────────────────────────────────────────────────────────────────────

const bodySchema = z.object({
  text: z.string().min(1).max(MAX_TTS_TEXT),
  voice: z.string().trim().max(40).optional(),
  waitDownload: z.boolean().optional(),
});

// Batas laju ringan per user: satu halaman ≈ 10-15 potongan kalimat.
const RATE_LIMIT = 120;
const RATE_WINDOW_MS = 60_000;
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

if (typeof setInterval === "function") {
  const t = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of rateHits) if (v.reset < now) rateHits.delete(k);
  }, RATE_WINDOW_MS);
  (t as unknown as { unref?: () => void }).unref?.();
}

export async function POST(req: NextRequest) {
  const user = await requireUser().catch(() => null);
  if (!user) return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });

  if (rateLimited(user.id)) {
    return NextResponse.json(
      { error: "Terlalu banyak permintaan suara — tunggu sebentar." },
      { status: 429 }
    );
  }

  let parsed: z.infer<typeof bodySchema>;
  try {
    const body = await req.json().catch(() => ({}));
    parsed = bodySchema.parse(body);
  } catch {
    return NextResponse.json(
      { error: `Teks tidak valid (1-${MAX_TTS_TEXT} karakter).` },
      { status: 400 }
    );
  }

  try {
    const out = await synthesizeSpeech(parsed.text, {
      voice: parsed.voice || DEFAULT_TTS_VOICE,
      waitDownload: parsed.waitDownload === true,
      userId: user.id,
    });
    return new NextResponse(new Uint8Array(out.buffer), {
      status: 200,
      headers: {
        "Content-Type": out.mime,
        "Content-Length": String(out.buffer.length),
        "X-Ai-Tts-Source": out.source,
        "X-Ai-Tts-Model": out.model,
        "X-Ai-Tts-Voice": out.voice,
        "Cache-Control": "private, max-age=86400, immutable",
      },
    });
  } catch (e) {
    const err = e as Error & { needDownload?: boolean };
    if (err.needDownload) {
      return NextResponse.json(
        { error: err.message, needDownload: true },
        { status: 423 }
      );
    }
    return NextResponse.json(
      { error: err.message || "Sintesis suara AI gagal." },
      { status: 502 }
    );
  }
}
