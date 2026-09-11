import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";

// POST /api/upload/chunk — kirim satu chunk (multipart: uploadId, idx, file).
// Chunk disimpan di MongoDB dengan indeks urut; dirakit ulang saat complete.

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const user = await requireUser().catch(() => null);
  if (!user) {
    return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "INVALID_FORMDATA" }, { status: 400 });
  }

  const uploadId = (form.get("uploadId") as string | null) ?? "";
  const idxRaw = form.get("idx");
  const blob = form.get("chunk");

  if (!uploadId) {
    return NextResponse.json({ error: "UPLOAD_ID_REQUIRED" }, { status: 400 });
  }
  const idx = Number(idxRaw);
  if (!Number.isInteger(idx) || idx < 0) {
    return NextResponse.json({ error: "IDX_INVALID" }, { status: 400 });
  }
  if (!(blob instanceof File)) {
    return NextResponse.json({ error: "CHUNK_REQUIRED" }, { status: 400 });
  }

  const session = await db.uploadSession.findUnique({
    where: { id: uploadId },
    select: {
      id: true,
      uploadedBy: true,
      chunkCount: true,
      chunkSize: true,
      size: true,
      expiresAt: true,
    },
  });
  if (!session) {
    return NextResponse.json({ error: "SESSION_NOT_FOUND" }, { status: 404 });
  }
  if (session.uploadedBy !== user.id) {
    return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });
  }
  if (session.expiresAt.getTime() < Date.now()) {
    return NextResponse.json({ error: "SESSION_EXPIRED" }, { status: 410 });
  }
  if (idx >= session.chunkCount) {
    return NextResponse.json({ error: "IDX_OUT_OF_RANGE" }, { status: 400 });
  }

  // Ukuran chunk harus pas: semua chunk = chunkSize kecuali terakhir
  // (= sisa bytes). Tolak chunk yang salah ukuran supaya file tidak rusak.
  const expectedSize =
    idx === session.chunkCount - 1
      ? session.size - session.chunkSize * (session.chunkCount - 1)
      : session.chunkSize;
  if (blob.size !== expectedSize) {
    return NextResponse.json(
      {
        error: "CHUNK_SIZE_MISMATCH",
        expected: expectedSize,
        received: blob.size,
      },
      { status: 400 }
    );
  }

  const bytes = Buffer.from(await blob.arrayBuffer());
  // Upsert: kirim ulang chunk yang sama (retry jaringan) tidak menduplikat.
  await db.uploadChunk.upsert({
    where: { sessionId_idx: { sessionId: session.id, idx } },
    update: { data: bytes },
    create: { sessionId: session.id, idx, data: bytes },
  });

  // Catatan: TIDAK ada query COUNT di sini — chunk dikirim PARALEL dari
  // client (3 XHR bersamaan) dan hitungan per-chunk hanya membebani MongoDB
  // tanpa dipakai client. Kelengkapan chunk diverifikasi sekali saja di
  // /api/upload/complete.
  return NextResponse.json({ ok: true, idx });
}
