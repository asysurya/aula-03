import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/session";
import { db } from "@/lib/db";

// ─────────────────────────────────────────────────────────────────────────
// Aula Reader — dokumen per user per file: anotasi (stabilo, pena/draw)
// + posisi baca terakhir. Tersimpan di MongoDB → ikut user di semua
// perangkat. File PDF/EPUB sendiri TIDAK disimpan di sini (hanya cache
// sementara browser yang otomatis terhapus).
//
//   GET  /api/reader/doc?storageKey=…   → { annotations, page }
//   PUT  /api/reader/doc { storageKey, annotations, page }  → replace
// ─────────────────────────────────────────────────────────────────────────

export const runtime = "nodejs";

const MAX_ANNOTATIONS = 2000;

const annoSchema = z
  .object({
    id: z.string().min(1).max(64),
    page: z.number().int().min(1).max(100000),
    // thl = stabilo TEKS (offset karakter start..end — dipakai
    // TextReader & EPUB); hl = kotak; pen = goresan.
    tool: z.enum(["hl", "pen", "thl"]),
    color: z.string().min(1).max(32),
    w: z.number().min(0).max(4).optional(),
    pts: z
      .array(z.tuple([z.number().min(-1).max(2), z.number().min(-1).max(2)]))
      .max(6000)
      .optional(),
    rect: z
      .array(z.number().min(-1).max(2))
      .length(4)
      .optional(),
    start: z.number().int().min(0).max(2_000_000).optional(),
    end: z.number().int().min(0).max(2_000_000).optional(),
    created: z.number(),
  })
  .refine(
    (a) => a.tool !== "thl" || (a.start !== undefined && a.end !== undefined && a.end > a.start),
    { message: "stabilo teks (thl) butuh start < end" }
  );

const putSchema = z.object({
  storageKey: z.string().trim().min(1).max(300),
  page: z.number().int().min(1).max(100000),
  // optional: tanpa annotations → update POSISI HALAMAN saja (ringan,
  // dipakai setiap pindah halaman — tidak mengirim ulang semua anotasi).
  annotations: z.array(annoSchema).max(MAX_ANNOTATIONS).optional(),
});

export async function GET(req: NextRequest) {
  const user = await requireUser().catch(() => null);
  if (!user) return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });

  const storageKey = req.nextUrl.searchParams.get("storageKey")?.trim();
  if (!storageKey || storageKey.length > 300) {
    return NextResponse.json({ error: "storageKey tidak valid" }, { status: 400 });
  }

  const doc = await db.readerDoc.findUnique({
    where: { userId_storageKey: { userId: user.id, storageKey } },
    select: { annotations: true, page: true },
  });

  const annotations = Array.isArray(doc?.annotations)
    ? (doc!.annotations as unknown[])
    : [];
  return NextResponse.json({
    storageKey,
    annotations,
    page: doc?.page ?? 1,
    // exists=false → dokumen belum pernah ada (klien boleh migrasi cache
    // lama). exists=true + annotations kosong → user memang sudah menghapus
    // semua anotasi (jangan migrasi ulang!).
    exists: !!doc,
  });
}

export async function PUT(req: NextRequest) {
  const user = await requireUser().catch(() => null);
  if (!user) return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Data tidak valid" }, { status: 400 });
  }
  const parsed = putSchema.safeParse(body);
  if (!parsed.success) {
    const first = parsed.error.issues[0]?.message ?? "Data tidak valid";
    return NextResponse.json({ error: first }, { status: 400 });
  }
  const { storageKey, annotations, page } = parsed.data;

  // Tanpa `annotations` → simpan posisi halaman saja (jangan menimpa
  // anotasi yang tersimpan).
  await db.readerDoc.upsert({
    where: { userId_storageKey: { userId: user.id, storageKey } },
    update: annotations ? { annotations, page } : { page },
    create: {
      userId: user.id,
      storageKey,
      annotations: annotations ?? [],
      page,
    },
  });

  return NextResponse.json({ ok: true, count: annotations?.length ?? null });
}
