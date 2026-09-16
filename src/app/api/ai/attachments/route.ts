import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/session";
import { db } from "@/lib/db";
import { extractText } from "@/lib/ai-extract";

export const runtime = "nodejs";
export const maxDuration = 60;

// ─────────────────────────────────────────────────────────────────────
// POST /api/ai/attachments — upload LAMPIRAN MATERI untuk fitur AI.
// multipart/form-data: field "file" (satu berkas; klien mengunggah
// satu per satu). Format APA PUN diterima; teks di-extract server-side
// (PDF/DOCX/XLSX/ZIP/EPUB/teks; biner dicatat nama+tipe) lalu disimpan
// ke AiAttachment. Response: { attachment: { id, name, kind, chars } } —
// id dikirim kembali pada request AI (attachmentIds).
// Batas 4 MB per berkas (di bawah batas body serverless).
// ─────────────────────────────────────────────────────────────────────

const MAX_SIZE = 4 * 1024 * 1024;

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
      { error: `Berkas terlalu besar (maks 4 MB): ${file.name}` },
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
