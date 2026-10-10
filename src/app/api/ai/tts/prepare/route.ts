import { NextResponse } from "next/server";
import { requireUser } from "@/lib/session";
import { ensurePiperAssets, getPiperStatus, ttsProviderConfigured } from "@/lib/ai-tts";

export const runtime = "nodejs";
export const maxDuration = 300;

// ─────────────────────────────────────────────────────────────────────
// /api/ai/tts/prepare — status & pemicu unduhan suara AI LOKAL (Piper).
//   GET  → { downloading, pct, ready, error, stage, voice, providerConfigured }
//   POST → mulai unduhan di latar belakang (idempoten, single-flight);
//          segera balas status (klien melakukan polling GET).
// ─────────────────────────────────────────────────────────────────────

export async function GET() {
  const user = await requireUser().catch(() => null);
  if (!user) return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
  const status = getPiperStatus();
  const providerConfigured = await ttsProviderConfigured(user.id);
  return NextResponse.json({ ...status, providerConfigured });
}

export async function POST() {
  const user = await requireUser().catch(() => null);
  if (!user) return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });

  const status = getPiperStatus();
  if (status.disabled) {
    return NextResponse.json(
      { error: "Suara AI lokal dimatikan lewat env (AI_TTS_PIPER_DISABLE=1)." },
      { status: 503 }
    );
  }
  if (status.ready) {
    return NextResponse.json({ ...getPiperStatus(), started: false });
  }
  // Jalankan unduhan di latar — jangan ditunggu di respons ini.
  void ensurePiperAssets().catch(() => undefined);
  return NextResponse.json({ ...getPiperStatus(), started: true });
}
