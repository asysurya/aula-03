import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/session";
import { db } from "@/lib/db";
import { extractText } from "@/lib/ai-extract";
import {
  ImportError,
  importFromCloud,
  importFromMount,
  listMount,
  mountRootList,
} from "@/lib/ai-import";
import {
  importFromStorageFile,
  importFromMega,
} from "@/lib/ai-import-storage";

export const runtime = "nodejs";
export const maxDuration = 60;

// ─────────────────────────────────────────────────────────────────────
// POST /api/ai/attachments/import — impor LAMPIRAN MATERI dari:
//   • cloud: body JSON { "url": "https://…" } — tautan langsung maupun
//     tautan berbagi Google Drive/Dropbox/OneDrive/GitHub; diunduh
//     server-side (maks 4 MB, timeout 20 dtk).
//   • mount: body JSON { "path": "/mnt/aula-materi/…" } — berkas di
//     folder server yang di-mount, dibatasi env AI_MOUNT_ROOTS.
//   • storage: body JSON { "fileId": "…" } — berkas yang SUDAH ada di
//     cloud storage Aula (CloudFile — sumber yang sama dengan lampiran
//     chat "Cloud Kelas"); izin baca sama dengan penyajian file.
//   • mega: body JSON { "nodeId": "…", "accountId"?: "…" } — berkas di
//     dalam akun MEGA yang di-mount, MULTI-AKUN (sumber yang sama
//     dengan lampiran chat "Mount MEGA"); akun eksplisit atau akun
//     pertama yang boleh dibuka user; izin canViewMount.
// Hasil masuk pipeline ekstraksi yang sama dengan upload → AiAttachment
// (source "cloud"/"mount"/"storage"/"mega", origin menyimpan asal).
// Response: { attachment: { id, name, kind, chars, source, origin } }.
// ─────────────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const user = await requireUser().catch(() => null);
  if (!user) {
    return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
  }
  try {
    const raw = req.nextUrl.searchParams.get("path") ?? "";
    if (!raw) {
      const roots = await mountRootList();
      return NextResponse.json({ roots });
    }
    const listing = await listMount(raw);
    return NextResponse.json(listing);
  } catch (e) {
    if (e instanceof ImportError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    return NextResponse.json({ error: "Gagal membaca folder" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const user = await requireUser().catch(() => null);
  if (!user) {
    return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  const url = typeof body?.url === "string" ? body.url.trim() : "";
  const mountPath = typeof body?.path === "string" ? body.path.trim() : "";
  const fileId = typeof body?.fileId === "string" ? body.fileId.trim() : "";
  const nodeId = typeof body?.nodeId === "string" ? body.nodeId.trim() : "";
  const accountId =
    typeof body?.accountId === "string" ? body.accountId.trim() : "";

  const modes = [url, mountPath, fileId, nodeId].filter(Boolean).length;
  if (modes === 0) {
    return NextResponse.json(
      {
        error:
          "Berikan salah satu: 'url' (tautan), 'path' (folder server), 'fileId' (cloud Aula), atau 'nodeId' (MEGA)",
      },
      { status: 400 }
    );
  }
  if (modes > 1) {
    return NextResponse.json(
      { error: "Pilih salah satu sumber saja: url / path / fileId / nodeId" },
      { status: 400 }
    );
  }

  try {
    const importUser = {
      id: user.id,
      role: (user as { role?: string }).role ?? "",
    };
    const f = url
      ? await importFromCloud(url)
      : mountPath
        ? await importFromMount(mountPath)
        : fileId
          ? await importFromStorageFile(importUser, fileId)
          : await importFromMega(importUser, accountId || null, nodeId);
    const source = url
      ? "cloud"
      : mountPath
        ? "mount"
        : fileId
          ? "storage"
          : "mega";
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
        source,
        origin: f.origin,
      },
    });

    return NextResponse.json({
      attachment: {
        id: row.id,
        name: row.name,
        kind: row.kind,
        chars: row.chars,
        source: row.source ?? source,
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
