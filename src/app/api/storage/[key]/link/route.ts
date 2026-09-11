import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { checkStorageAccess, s3AccountOf } from "@/lib/storage-access";
import { s3PresignedGet } from "@/lib/s3-storage";
import { parseMegaKey } from "@/lib/mega-storage";

// ─────────────────────────────────────────────────────────────────────────
// GET /api/storage/[key]/link — strategi unduhan cepat untuk sebuah file.
//
// "Akalin Vercel": serverless function tidak cocok jadi pipa bandwidth
// (latensi + throughput terbatas). Untuk file S3-compatible (R2/B2/Wasabi/
// MinIO/AWS) route ini mengembalikan URL PRESIGNED singkat sehingga client
// mengunduh LANGSUNG dari penyimpanan — bandwidth Vercel 0, koneksi Range
// paralel penuh dari provider yang cepat.
//
// Response:
//   { ok: true, url: "https://…presigned…", size, segments: "auto",
//     expiresIn }               → unduh langsung (parallel range)
//   { ok: true, url: null, size, segments: 1, stream: true }
//                              → lewati proxy /api/storage/[key] SATU
//                                koneksi streaming (MEGA / file lokal —
//                                multi-koneksi justru membebani server)
//
// URL presigned bermasa singkat (10 menit) dan hanya untuk user yang lolos
// pemeriksaan akses yang SAMA dengan /api/storage/[key].
// ─────────────────────────────────────────────────────────────────────────

export const runtime = "nodejs";
export const maxDuration = 30;

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ key: string }> }
) {
  const session = await getServerSession(authOptions);
  const user = session?.user as { id?: string; role?: string } | undefined;
  const { key } = await params;

  const access = await checkStorageAccess(
    user?.id && user?.role ? { id: user.id, role: user.role } : null,
    key
  );
  if (!access.ok) {
    return NextResponse.json(
      { ok: false, error: access.body },
      { status: access.status }
    );
  }

  const size = access.kind === "cloud" ? access.file.size : 0;

  // ── S3: presign URL langsung ──
  const s3 = await s3AccountOf(key);
  if (s3) {
    const url = await s3PresignedGet(s3.account, s3.objectKey, {
      expiresInSec: 600,
      ...(access.kind === "cloud" ? { downloadName: access.file.name } : {}),
    });
    if (url) {
      return NextResponse.json({
        ok: true,
        url,
        size,
        // Client boleh memecah unduhan jadi banyak koneksi Range paralel.
        segments: "auto",
        expiresIn: 600,
      });
    }
    // Presign gagal (mis. konfigurasi aneh) → proxy range masih oke utk S3.
    return NextResponse.json({
      ok: true,
      url: null,
      size,
      segments: "auto",
    });
  }

  // ── MEGA / file lokal fs: streaming lewat proxy, satu koneksi ──
  // (multi-koneksi range akan memicu unduhan MEGA penuh berulang kali).
  const isMega = !!parseMegaKey(key);
  return NextResponse.json({
    ok: true,
    url: null,
    size,
    segments: 1,
    stream: true,
    via: isMega ? "mega-stream" : "local",
  });
}
