import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { canViewMount, canWriteMount } from "@/lib/mount-access";
import {
  megaStat,
  megaList,
  megaDownload,
  megaMkdir,
  megaUploadTo,
  describeMegaError,
  type MegaAccountLike,
} from "@/lib/mega-storage";
import { fileCacheGetOrLoad } from "@/lib/file-cache";
import { resolveMime } from "@/lib/file-constants";
import { mimetypeFromName } from "@/lib/cloud-format";
import {
  openArchive,
  listArchive,
  planExtraction,
  ArchiveError,
  MAX_ARCHIVE_BYTES,
} from "@/lib/archive";
import { isSupportedArchiveName } from "@/lib/archive-names";

// ─────────────────────────────────────────────────────────────────────────
// /api/cloud/mega/archive — arsip di mount MEGA Cloud.
//
//   GET  ?accountId&nodeId                → daftar isi arsip (METADATA saja,
//                                           tanpa dekompresi apa pun untuk zip)
//   GET  ?accountId&nodeId&entry=<path>   → SAJIKAN SATU berkas di dalam
//                                           arsip — "buka tanpa ekstrak"
//                                           (bisa dipratinjau/diunduh)
//   POST { accountId?, nodeId, targetParentId?, folderName? }
//                                        → EKSTRAK seluruh arsip menjadi
//                                           folder + berkas asli di MEGA.
//
// Hak akses:
//   · listing + buka entri  → canViewMount (READ cukup — tidak mengubah
//     isi akun MEGA).
//   · ekstraksi             → canWriteMount (menulis folder/berkas baru).
//
// Batas: arsip maks 100 MB (selaras lampiran); entri dibuka maks 100 MB;
// ekstraksi maks 300 entri / 1 GB total / 100 MB per berkas (anti
// zip-bomb, pesan galat ramah). Semua dekompresi di-cap streaming.
// ─────────────────────────────────────────────────────────────────────────

export const runtime = "nodejs";
export const maxDuration = 300;

function selectAccount() {
  return {
    id: true,
    email: true,
    password: true,
    sessionData: true,
    name: true,
    lastStatus: true,
    mountVisibleTo: true,
    mountMode: true,
    mountUserIds: true,
    mountUserWriteIds: true,
  };
}

async function pickAccount(
  accountId: string | null,
  role?: string | null,
  userId?: string | null
) {
  return accountId
    ? db.cloudAccount.findFirst({
        where: { id: accountId, provider: "mega", email: { not: null } },
        select: selectAccount(),
      })
    : (
        await db.cloudAccount.findMany({
          where: {
            provider: "mega",
            active: true,
            email: { not: null },
            lastStatus: { not: "error" },
          },
          orderBy: { fileCount: "asc" },
          select: selectAccount(),
        })
      ).find((a) => canViewMount(a, role, userId)) ?? null;
}

function archiveErrorStatus(e: unknown): { status: number; message: string } {
  if (e instanceof ArchiveError) {
    switch (e.code) {
      case "ARCHIVE_TOO_LARGE":
      case "ENTRY_TOO_LARGE":
      case "EXTRACT_TOO_LARGE":
      case "EXTRACT_TOO_MANY":
        return { status: 413, message: e.message };
      case "ENTRY_NOT_FOUND":
        return { status: 404, message: e.message };
      case "ARCHIVE_UNSUPPORTED":
        return { status: 415, message: e.message };
      default:
        return { status: 422, message: e.message };
    }
  }
  return {
    status: 422,
    message:
      e instanceof Error
        ? `Arsip tidak bisa dibaca: ${e.message}`
        : "Arsip tidak bisa dibaca.",
  };
}

/** Unduh arsip (≤100 MB) sekali per proses via LRU cache blob. */
async function getArchiveBytes(
  account: MegaAccountLike,
  nodeId: string
): Promise<Buffer | null> {
  return fileCacheGetOrLoad(`mega:${account.id}:${nodeId}`, () =>
    megaDownload(account, nodeId)
  );
}

// ── GET: listing + sajian entri ──────────────────────────────────────────

export async function GET(req: NextRequest) {
  const user = await requireUser().catch(() => null);
  if (!user) {
    return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
  }
  const role = (user as { role?: string }).role;
  const userId = (user as { id?: string }).id ?? null;

  const url = new URL(req.url);
  const accountId = url.searchParams.get("accountId");
  const nodeId = url.searchParams.get("nodeId");
  const entryPath = url.searchParams.get("entry");
  const download = url.searchParams.get("download") === "1";

  if (!nodeId) {
    return NextResponse.json(
      { error: "nodeId wajib diisi." },
      { status: 400 }
    );
  }

  const account = await pickAccount(accountId, role, userId);
  if (!account || !account.email) {
    return NextResponse.json(
      { error: "Belum ada akun MEGA aktif." },
      { status: 404 }
    );
  }
  if (!canViewMount(account, role, userId)) {
    return NextResponse.json(
      {
        error:
          "FORBIDDEN — kamu tidak punya izin membuka mount akun cloud ini. Minta admin mengatur hak aksesnya.",
      },
      { status: 403 }
    );
  }
  const accountLike: MegaAccountLike = {
    id: account.id,
    email: account.email,
    password: account.password,
    sessionData: account.sessionData,
  };

  // Stat node: harus BERKAS (bukan folder).
  let stat: { name: string; size: number; isFolder: boolean };
  try {
    stat = await megaStat(accountLike, nodeId);
  } catch (e) {
    return NextResponse.json(
      { error: `Gagal membaca file MEGA: ${describeMegaError(e)}` },
      { status: 502 }
    );
  }
  if (stat.isFolder) {
    return NextResponse.json(
      { error: "Node itu folder — pilih berkas arsipnya." },
      { status: 400 }
    );
  }
  if (stat.size > MAX_ARCHIVE_BYTES) {
    return NextResponse.json(
      {
        error: `Arsip ${Math.round(stat.size / 1048576)} MB — melebihi batas ${Math.round(
          MAX_ARCHIVE_BYTES / 1048576
        )} MB untuk dibuka langsung. Unduh lalu ekstrak di perangkat.`,
      },
      { status: 413 }
    );
  }
  if (!isSupportedArchiveName(stat.name)) {
    return NextResponse.json(
      {
        error: `Format "${stat.name.split(".").pop() ?? "?"}" tidak bisa dibuka langsung — didukung: ZIP, EPUB, TAR, TAR.GZ, GZ. Unduh arsipnya untuk mengekstrak di perangkat.`,
      },
      { status: 415 }
    );
  }

  const buf = await getArchiveBytes(accountLike, nodeId);
  if (!buf) {
    return NextResponse.json(
      {
        error: "Gagal mengunduh arsip dari MEGA — coba lagi atau unduh langsung.",
      },
      { status: 502 }
    );
  }

  // ── Mode 1: listing metadata ──
  if (entryPath === null) {
    try {
      const listing = listArchive(stat.name, buf);
      return NextResponse.json({
        ok: true,
        name: stat.name,
        size: stat.size,
        format: listing.format,
        entryCount: listing.entryCount,
        truncated: listing.truncated,
        totalBytes: listing.totalBytes,
        canWrite: canWriteMount(account, role, userId),
        entries: listing.entries,
      });
    } catch (e) {
      const { status, message } = archiveErrorStatus(e);
      return NextResponse.json({ error: message }, { status });
    }
  }

  // ── Mode 2: sajikan SATU berkas di dalam arsip (tanpa ekstrak) ──
  let data: Buffer;
  try {
    const opened = openArchive(stat.name, buf);
    data = await opened.read(entryPath);
  } catch (e) {
    const { status, message } = archiveErrorStatus(e);
    return NextResponse.json({ error: message }, { status });
  }

  const baseName = entryPath.split(/[\\/]/).pop() || "berkas";
  const mime = resolveMime(baseName, "");
  const asciiName =
    baseName.replace(/[\r\n"\\]/g, "_").replace(/[^\x20-\x7e]/g, "_") ||
    "berkas";
  const headers = new Headers({
    "Content-Type": mime,
    "Content-Length": String(data.length),
    "Content-Disposition": `${download ? "attachment" : "inline"}; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(baseName)}`,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, max-age=0, must-revalidate",
    ETag: `"arch-${nodeId}-${entryPath.length}-${data.length}"`,
  });

  // Dukungan Range tunggal (video/audio dalam arsip bisa seek).
  const range = req.headers.get("range");
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (m) {
      const start = m[1] ? parseInt(m[1], 10) : 0;
      const end = m[2]
        ? Math.min(parseInt(m[2], 10), data.length - 1)
        : data.length - 1;
      if (
        Number.isFinite(start) &&
        Number.isFinite(end) &&
        start <= end &&
        start < data.length
      ) {
        const chunk = data.subarray(start, end + 1);
        return new NextResponse(
          new Uint8Array(chunk) as unknown as BodyInit,
          {
            status: 206,
            headers: new Headers({
              ...Object.fromEntries(headers.entries()),
              "Content-Range": `bytes ${start}-${end}/${data.length}`,
              "Content-Length": String(chunk.length),
            }),
          }
        );
      }
    }
  }

  return new NextResponse(new Uint8Array(data) as unknown as BodyInit, {
    status: 200,
    headers,
  });
}

// ── POST: ekstraksi arsip ke folder di mount ─────────────────────────────

const extractSchema = z.object({
  accountId: z.string().optional(),
  nodeId: z.string().min(1),
  targetParentId: z.string().nullable().optional(),
  folderName: z
    .string()
    .trim()
    .min(1, "Nama folder tidak boleh kosong")
    .max(120, "Nama folder maksimal 120 karakter")
    .refine(
      (v) => !/[\\/\r\n\0]/.test(v),
      "Nama folder mengandung karakter terlarang"
    )
    .optional(),
});

/** Nama folder unik di target (akhiran " (2)", " (3)", …). */
async function uniqueFolderName(
  account: MegaAccountLike,
  targetParentId: string | null,
  want: string
): Promise<string> {
  try {
    const listing = await megaList(account, targetParentId);
    const existing = new Set(listing.entries.map((e) => e.name.toLowerCase()));
    if (!existing.has(want.toLowerCase())) return want;
    for (let i = 2; i < 100; i++) {
      const candidate = `${want} (${i})`;
      if (!existing.has(candidate.toLowerCase())) return candidate;
    }
  } catch {
    // listing gagal → pakai nama apa adanya.
  }
  return `${want}-${Date.now() % 10000}`;
}

export async function POST(req: NextRequest) {
  const user = await requireUser().catch(() => null);
  if (!user) {
    return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
  }
  const role = (user as { role?: string }).role;
  const userId = (user as { id?: string }).id ?? null;

  const body = await req.json().catch(() => null);
  const parsed = extractSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Data tidak valid" },
      { status: 400 }
    );
  }
  const op = parsed.data;

  const account = await pickAccount(op.accountId ?? null, role, userId);
  if (!account || !account.email) {
    return NextResponse.json(
      { error: "Belum ada akun MEGA aktif." },
      { status: 404 }
    );
  }
  if (!canViewMount(account, role, userId)) {
    return NextResponse.json(
      {
        error:
          "FORBIDDEN — kamu tidak punya izin membuka mount akun cloud ini.",
      },
      { status: 403 }
    );
  }
  // Ekstraksi MENULIS ke akun MEGA → wajib hak tulis.
  if (!canWriteMount(account, role, userId)) {
    return NextResponse.json(
      {
        error:
          "Mount ini baca-saja untukmu — ekstraksi butuh hak tulis (atur di Admin Panel → Data & Cloud).",
      },
      { status: 403 }
    );
  }
  const accountLike: MegaAccountLike = {
    id: account.id,
    email: account.email,
    password: account.password,
    sessionData: account.sessionData,
  };

  let stat: { name: string; size: number; isFolder: boolean };
  try {
    stat = await megaStat(accountLike, op.nodeId);
  } catch (e) {
    return NextResponse.json(
      { error: `Gagal membaca file MEGA: ${describeMegaError(e)}` },
      { status: 502 }
    );
  }
  if (stat.isFolder) {
    return NextResponse.json(
      { error: "Node itu folder — pilih berkas arsipnya." },
      { status: 400 }
    );
  }
  if (stat.size > MAX_ARCHIVE_BYTES) {
    return NextResponse.json(
      {
        error: `Arsip ${Math.round(stat.size / 1048576)} MB — melebihi batas ekstraksi ${Math.round(
          MAX_ARCHIVE_BYTES / 1048576
        )} MB.`,
      },
      { status: 413 }
    );
  }
  if (!isSupportedArchiveName(stat.name)) {
    return NextResponse.json(
      {
        error: `Format "${stat.name.split(".").pop() ?? "?"}" tidak didukung — didukung: ZIP, EPUB, TAR, TAR.GZ, GZ.`,
      },
      { status: 415 }
    );
  }

  const buf = await getArchiveBytes(accountLike, op.nodeId);
  if (!buf) {
    return NextResponse.json(
      { error: "Gagal mengunduh arsip dari MEGA — coba lagi." },
      { status: 502 }
    );
  }

  // Buka + rencanakan (sanitasi path + batas jumlah/total/per-entri).
  let opened: ReturnType<typeof openArchive>;
  let plan: ReturnType<typeof planExtraction>;
  try {
    opened = openArchive(stat.name, buf);
    plan = planExtraction(opened.entries);
  } catch (e) {
    const { status, message } = archiveErrorStatus(e);
    return NextResponse.json({ error: message }, { status });
  }
  if (plan.items.length === 0) {
    return NextResponse.json(
      { error: "Arsip kosong / tidak ada entri yang bisa diekstrak." },
      { status: 422 }
    );
  }

  // Nama folder hasil ekstraksi: dari user atau nama arsip tanpa ekstensi.
  const defaultName =
    stat.name
      .split(/[\\/]/)
      .pop()!
      .replace(/\.(tar\.gz|tgz|zip|epub|tar|gz)$/i, "")
      .replace(/[\x00-\x1f\\/]/g, "")
      .trim() || "ekstrak";
  const wantName = op.folderName ?? defaultName;
  const folderName = await uniqueFolderName(
    accountLike,
    op.targetParentId ?? null,
    wantName
  );

  // Buat folder induk hasil ekstraksi.
  let rootId: string;
  try {
    const made = await megaMkdir(
      accountLike,
      op.targetParentId ?? null,
      folderName
    );
    rootId = made.nodeId;
  } catch (e) {
    return NextResponse.json(
      { error: `Gagal membuat folder ekstraksi: ${describeMegaError(e)}` },
      { status: 502 }
    );
  }

  // Buat subfolder (urut dangkal→dalam), lalu unggah berkas.
  const dirIds = new Map<string, string>([["", rootId]]);
  let folderCount = 0;
  let fileCount = 0;
  let failed = 0;
  const dirPaths = Array.from(
    new Set(
      plan.items.map((i) => {
        const idx = i.path.lastIndexOf("/");
        return idx > 0 ? i.path.slice(0, idx) : "";
      })
    )
  ).sort((a, b) => a.split("/").length - b.split("/").length);

  try {
    for (const dirPath of dirPaths) {
      if (!dirPath) continue;
      const segs = dirPath.split("/");
      let parentKey = "";
      let parentId = rootId;
      for (const seg of segs) {
        parentKey = parentKey ? `${parentKey}/${seg}` : seg;
        if (dirIds.has(parentKey)) {
          parentId = dirIds.get(parentKey)!;
          continue;
        }
        const made = await megaMkdir(
          accountLike,
          parentId,
          seg.slice(0, 120) || "folder"
        );
        dirIds.set(parentKey, made.nodeId);
        parentId = made.nodeId;
        folderCount++;
      }
    }

    for (const item of plan.items) {
      if (!item.isFile) continue;
      const idx = item.path.lastIndexOf("/");
      const dirPath = idx > 0 ? item.path.slice(0, idx) : "";
      const parentId = dirIds.get(dirPath) ?? rootId;
      const baseName = item.path.slice(idx + 1).slice(0, 120) || "berkas";
      try {
        // Baca lewat path ASLI arsip (rawPath) — hasil sanitasi hanya
        // dipakai untuk penamaan tujuan.
        const data = await opened.read(item.rawPath);
        await megaUploadTo(
          accountLike,
          parentId,
          baseName,
          data,
          mimetypeFromName(baseName)
        );
        fileCount++;
      } catch {
        failed++;
      }
    }
  } catch (e) {
    return NextResponse.json(
      {
        error: `Ekstraksi terputus di tengah: ${describeMegaError(e)} — ${fileCount} berkas sudah terunggah ke folder "${folderName}".`,
        folderName,
        fileCount,
      },
      { status: 502 }
    );
  }

  return NextResponse.json({
    ok: true,
    folderName,
    fileCount,
    folderCount,
    failed,
    skippedUnsafe: plan.skippedUnsafe,
    skippedOversize: plan.skippedOversize,
  });
}
