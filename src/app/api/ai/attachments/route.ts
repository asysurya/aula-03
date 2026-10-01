import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/session";
import { db } from "@/lib/db";
import { extractText } from "@/lib/ai-extract";
import { MAX_FILE_SIZE } from "@/lib/storage";

export const runtime = "nodejs";
export const maxDuration = 60;

// ─────────────────────────────────────────────────────────────────────
// POST /api/ai/attachments — upload LAMPIRAN MATERI untuk fitur AI.
// multipart/form-data: field "file" (satu berkas; klien mengunggah
// satu per satu). Format APA PUN diterima; teks di-extract server-side
// (PDF/DOCX/XLSX/ZIP/EPUB/teks; biner dicatat nama+tipe) lalu disimpan
// ke AiAttachment. Response: { attachment: { id, name, kind, chars } } —
// id dikirim kembali pada request AI (attachmentIds).
// Batas 100 MB per berkas — SAMA dengan lampiran chat (MAX_FILE_SIZE di
// lib/storage). Berkas besar dipecah client lewat jalur chunked
// (uploadSmart → /api/upload/init + /chunk + /complete) supaya tetap
// lolos batas body ±4,5 MB serverless Vercel; route ini juga menerima
// POST langsung sampai 100 MB (self-hosted tanpa batas body).
// ─────────────────────────────────────────────────────────────────────

const MAX_SIZE = MAX_FILE_SIZE;

export async function POST(req: NextRequest) {
  const user = await requireUser().catch(() => null);
  if (!user) return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Data tidak valid" }, { status: 400 });
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "FILE_REQUIRED" }, { status: 400 });
  }
  if (file.size > MAX_SIZE) {
    return NextResponse.json(
      {
        error: `Berkas terlalu besar (maks ${Math.round(
          MAX_SIZE / 1024 / 1024
        )} MB): ${file.name}`,
      },
      { status: 413 }
    );
  }

  const buf = Buffer.from(await file.arrayBuffer());
  const { kind, text } = await extractText(file.name, file.type, buf);

  const row = await db.aiAttachment.create({
    data: {
      userId: user.id,
      name: file.name || "berkas",
      mime: file.type || "",
      size: file.size,
      kind,
      text,
      chars: text.length,
    },
  });

  return NextResponse.json({
    attachment: {
      id: row.id,
      name: row.name,
      kind: row.kind,
      chars: row.chars,
      note:
        row.chars === 0
          ? "teks tidak terbaca (berkas biner)"
          : undefined,
    },
  });
}
