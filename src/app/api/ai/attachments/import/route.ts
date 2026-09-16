import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/session";
import { db } from "@/lib/db";
import { extractText } from "@/lib/ai-extract";
import { ImportError, importFromCloud, importFromMount } from "@/lib/ai-import";

export const runtime = "nodejs";
export const maxDuration = 60;

// ─────────────────────────────────────────────────────────────────────
// POST /api/ai/attachments/import — impor LAMPIRAN MATERI dari:
//   • cloud: body JSON { "url": "https://…" } — tautan langsung maupun
//     tautan berbagi Google Drive/Dropbox/OneDrive/GitHub; diunduh
//     server-side (maks 4 MB, timeout 20 dtk).
//   • mount: body JSON { "path": "/mnt/aula-materi/…" } — berkas di
//     folder server yang di-mount, dibatasi env AI_MOUNT_ROOTS.
// Hasil masuk pipeline ekstraksi yang sama dengan upload → AiAttachment
// (source "cloud"/"mount", origin menyimpan URL/path asal).
// Response: { attachment: { id, name, kind, chars, source, origin } }.
// ─────────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const user = await requireUser().catch(() => null);
  if (!user) {
    return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  const url = typeof body?.url === "string" ? body.url.trim() : "";
  const mountPath = typeof body?.path === "string" ? body.path.trim() : "";

  if (!url && !mountPath) {
    return NextResponse.json(
      { error: "Berikan 'url' (cloud) atau 'path' (mount)" },
      { status: 400 }
    );
  }
  if (url && mountPath) {
    return NextResponse.json(
      { error: "Pilih salah satu: 'url' ATAU 'path'" },
      { status: 400 }
    );
  }

  try {
    const f = url
      ? await importFromCloud(url)
      : await importFromMount(mountPath);
    const { kind, text } = await extractText(f.name, f.mime, f.buf);

    const row = await db.aiAttachment.create({
      data: {
        userId: user.id,
        name: f.name || "berkas",
        mime: f.mime || "",
        size: f.buf.length,
        kind,
        text,
        chars: text.length,
        source: url ? "cloud" : "mount",
        origin: f.origin,
      },
    });

    return NextResponse.json({
      attachment: {
        id: row.id,
        name: row.name,
        kind: row.kind,
        chars: row.chars,
        source: row.source ?? (url ? "cloud" : "mount"),
        origin: row.origin ?? f.origin,
        note:
          row.chars === 0
            ? "teks tidak terbaca (berkas biner)"
            : undefined,
      },
    });
  } catch (e) {
    if (e instanceof ImportError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    return NextResponse.json(
      { error: "Gagal mengimpor materi" },
      { status: 500 }
    );
  }
}
