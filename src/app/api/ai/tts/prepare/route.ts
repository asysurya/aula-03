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
  // Task 32: TUNGGU unduhan selesai di respons ini (bukan sekadar memicu
  // latar). Di hosting serverless proses dibekukan setelah respons terkirim
  // — unduhan "latar" tidak pernah maju & polling GET tak pernah selesai.
  // Dengan menunggu, unduhan benar-benar berjalan dalam masa hidup fungsi;
  // klien tetap mem-polling GET utk progres (self-host) sambil menunggu.
  // Status.ready TIDAK dipercaya utk early-return: ensurePiperAssets
  // memverifikasi aset di DISK (aset terhapus setelah ready → unduh ulang).
  try {
    await ensurePiperAssets();
  } catch {
    /* status memuat pesan galat yang ramah */
  }
  return NextResponse.json({ ...getPiperStatus(), started: true });
}
