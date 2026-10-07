import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/session";
import { resolveChain } from "@/lib/ai-config-chain";
import {
  visionExtractImage,
  VisionUnavailableError,
} from "@/lib/ai-vision";

export const runtime = "nodejs";
export const maxDuration = 120;

// ─────────────────────────────────────────────────────────────────────
// POST /api/ai/vision/page — ekstraksi teks SATU gambar/halaman dengan
// model vision (kategori "vision", fallback berurutan).
// Dipakai Aula Reader "Bacakan": halaman PDF (dirender client menjadi
// JPEG) atau gambar asli dikirim SATU PER SATU — per halaman, bukan
// seluruh dokumen sekaligus (permintaan Task 29).
//
// Body: { image: string (data URL atau base64), mode?: "page" | "image" }
// Response: { text, model?, provider? } — text sudah dirapikan model
// (tabel markdown, catatan kaki di bawah, header/footer/nomor halaman
// difilter, rumus LaTeX).
// ─────────────────────────────────────────────────────────────────────

const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // 8 MB per gambar (cukup utk halaman HD)

const bodySchema = z.object({
  image: z.string().min(8, "Gambar kosong"),
  mode: z.enum(["page", "image"]).optional(),
});

export async function POST(req: NextRequest) {
  const user = await requireUser().catch(() => null);
  if (!user) return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Data tidak valid" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Data tidak valid" },
      { status: 400 }
    );
  }

  // Terima data URL "data:image/jpeg;base64,…" atau base64 polos.
  let mime = "image/jpeg";
  let b64 = parsed.data.image;
  const m = /^data:([^;,]+);base64,([\s\S]+)$/.exec(b64);
  if (m) {
    mime = m[1];
    b64 = m[2];
  }
  const data = Buffer.from(b64, "base64");
  if (!data.length || data.length > MAX_IMAGE_BYTES) {
    return NextResponse.json(
      { error: "Gambar tidak valid atau melebihi 8 MB" },
      { status: 413 }
    );
  }

  const chain = await resolveChain(user.id, "vision");
  if (!chain.length) {
    return NextResponse.json(
      {
        error:
          "Belum ada model vision terpasang — buka Pengaturan AI (kategori Vision) dan pilih model yang bisa melihat gambar, mis. gpt-4o-mini atau gemini-2.0-flash.",
      },
      { status: 400 }
    );
  }

  try {
    const r = await visionExtractImage(
      chain,
      { data, mime },
      parsed.data.mode ?? "page"
    );
    // Laporkan entri yang BENAR-BENAR sukses (bukan entri #1) —
    // fallback chain bisa memakai entri ke-2 dst.
    return NextResponse.json({
      text: r.text,
      provider: r.used?.provider ?? chain[0]?.provider ?? "",
      model: r.used?.model ?? chain[0]?.model ?? "",
    });
  } catch (e) {
    if (e instanceof VisionUnavailableError) {
      return NextResponse.json({ error: e.message }, { status: 502 });
    }
    return NextResponse.json(
      { error: "Ekstraksi vision gagal — coba lagi." },
      { status: 502 }
    );
  }
}
