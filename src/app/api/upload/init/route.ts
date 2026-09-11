import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { MAX_FILE_SIZE } from "@/lib/storage";
import { resolveMime } from "@/lib/file-constants";

// POST /api/upload/init — mulai sesi upload berchunk untuk file besar.
//
// Kenapa perlu: serverless Vercel membatasi request body ± 4.5 MB. File
// lebih besar dari itu (mis. PDF modul ajar 10 MB) akan ditolak (413).
// Solusi: client memecah file jadi chunk ± 4 MB, tiap chunk dikirim
// terpisah ke /api/upload/chunk, lalu /api/upload/complete merakitnya
// dan menjalankan logika upload yang sama seperti endpoint biasa
// (MEGA/S3 + baris CloudFile/Submission/dst).
//
// Chunk disimpan sementara di MongoDB (UploadSession + UploadChunk),
// otomatis dibersihkan saat kadaluarsa (6 jam) / setelah complete.

export const runtime = "nodejs";
export const maxDuration = 60;

// Sedikit di bawah batas body serverless Vercel (±4.5 MB) supaya aman
// termasuk overhead multipart + field tambahan.
const CHUNK_SIZE = 4 * 1024 * 1024 - 64 * 1024; // ~3.94 MB

const SESSION_TTL_MS = 6 * 60 * 60 * 1000; // 6 jam

const initSchema = z.object({
  name: z.string().min(1).max(255),
  size: z.number().int().positive(),
  mimetype: z.string().min(1).max(200),
});

// Bersihkan sesi kadaluarsa (lazy — tanpa cron/TTL index terpisah).
async function cleanupExpired(): Promise<void> {
  try {
    const expired = await db.uploadSession.findMany({
      where: { expiresAt: { lt: new Date() } },
      select: { id: true },
    });
    if (expired.length > 0) {
      // Chunk terhapus otomatis lewat onDelete: Cascade.
      await db.uploadSession.deleteMany({
        where: { id: { in: expired.map((e) => e.id) } },
      });
    }
  } catch {
    /* best-effort */
  }
}

export async function POST(req: NextRequest) {
  const user = await requireUser().catch(() => null);
  if (!user) {
    return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "INVALID_JSON" }, { status: 400 });
  }
  const parsed = initSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Data tidak valid" },
      { status: 400 }
    );
  }
  const { name, size, mimetype } = parsed.data;

  if (size > MAX_FILE_SIZE) {
    return NextResponse.json(
      {
        error: `FILE_TOO_LARGE (maks ${Math.round(MAX_FILE_SIZE / 1024 / 1024)} MB)`,
        maxBytes: MAX_FILE_SIZE,
      },
      { status: 413 }
    );
  }

  // Semua tipe file diterima — mimetype hanya dinormalisasi (OS mime →
  // ekstensi → octet-stream); tipe asli dikoreksi lagi saat serving.
  const finalMime = resolveMime(name, mimetype);

  await cleanupExpired();

  const chunkCount = Math.ceil(size / CHUNK_SIZE);
  const session = await db.uploadSession.create({
    data: {
      name,
      mimetype: finalMime,
      size,
      chunkSize: CHUNK_SIZE,
      chunkCount,
      uploadedBy: user.id,
      expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    },
  });

  return NextResponse.json({
    uploadId: session.id,
    chunkSize: CHUNK_SIZE,
    chunkCount,
  });
}
