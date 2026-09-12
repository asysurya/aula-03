import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { canViewMount } from "@/lib/mount-access";
import { megaStat, describeMegaError } from "@/lib/mega-storage";
import { MAX_FILE_SIZE } from "@/lib/storage";
import { resolveMime } from "@/lib/file-constants";

// POST /api/cloud/mega/attach
// body: { accountId?: string, nodeId: string }
//
// "Lampirkan dari mount MEGA" — daftarkan node file di akun MEGA sebagai
// baris CloudFile PERMANEN supaya bisa dilampirkan ke pesan chat.
//
// Sifat baris referensi ini:
//  · PERMANEN (expiresAt null) — pesan yang memakainya dihapus TIDAK
//    menghapus file; file asli tetap utuh di akun MEGA.
//  · Bukan salinan — storageKey `mega:<accountId>:<nodeId>` menunjuk node
//    asli di mount; baris hanya referensi.
//  · Node dihapus dari mount (lewat file explorer Cloud) → baris ikut
//    dibersihkan oleh ops delete (megaCollectDescendantKeys).
//  · Dedupe per storageKey — node yang sama dipakai ulang oleh siapa pun
//    menghasilkan baris (dan id) yang sama.
//
// Hak akses: canViewMount (sama seperti membuka mount / pratinjau) — cukup
// READ; melampirkan tidak mengubah isi akun MEGA. Nama/ukuran dibaca dari
// sisi server (megaStat), bukan dari klien.

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const user = await requireUser().catch(() => null);
  if (!user) {
    return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
  }
  const role = (user as { role?: string }).role;
  const userId = (user as { id?: string }).id ?? null;

  const body = await req.json().catch(() => null);
  const accountId = typeof body?.accountId === "string" ? body.accountId : null;
  const nodeId = typeof body?.nodeId === "string" ? body.nodeId.trim() : "";
  if (!nodeId) {
    return NextResponse.json({ error: "NODE_ID_REQUIRED" }, { status: 400 });
  }

  // Pilih akun: eksplisit via param, atau akun aktif pertama (sama seperti
  // tree/ops — supaya konsisten dengan mount yang dilihat user).
  const select = {
    id: true,
    email: true,
    password: true,
    sessionData: true,
    mountVisibleTo: true,
    mountMode: true,
    mountUserIds: true,
    mountUserWriteIds: true,
  };
  const account = accountId
    ? await db.cloudAccount.findFirst({
        where: { id: accountId, provider: "mega", email: { not: null } },
        select,
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
          select,
        })
      ).find((a) => canViewMount(a, role, userId)) ?? null;
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

  // Baca nama/ukuran asli dari MEGA (server-side).
  let stat: { name: string; size: number; isFolder: boolean };
  try {
    stat = await megaStat(account, nodeId);
  } catch (e) {
    return NextResponse.json(
      { error: `Gagal membaca file MEGA: ${describeMegaError(e)}` },
      { status: 502 }
    );
  }
  if (stat.isFolder) {
    return NextResponse.json(
      { error: "Folder tidak bisa dilampirkan — pilih file di dalamnya." },
      { status: 400 }
    );
  }
  if (stat.size > MAX_FILE_SIZE) {
    return NextResponse.json(
      {
        error: `File terlalu besar untuk dilampirkan (maks ${Math.round(
          MAX_FILE_SIZE / 1024 / 1024
        )} MB).`,
      },
      { status: 413 }
    );
  }

  const mimetype = resolveMime(stat.name, "");

  const storageKey = `mega:${account.id}:${nodeId}`;

  // Dedupe: node yang sama = baris yang sama (id stabil → bisa dipakai ulang
  // lintas pesan/user). Baris lama yang namanya berubah di MEGA ikut
  // diperbarui supaya tampilan bubble tetap akurat.
  const existing = await db.cloudFile.findFirst({
    where: { storageKey },
    select: { id: true, name: true, size: true },
  });

  const row = existing
    ? await db.cloudFile.update({
        where: { id: existing.id },
        data:
          existing.name !== stat.name || existing.size !== stat.size
            ? { name: stat.name, size: stat.size }
            : undefined,
        select: {
          id: true,
          name: true,
          size: true,
          mimetype: true,
          storageKey: true,
          createdAt: true,
          uploader: { select: { id: true, name: true, username: true } },
        },
      })
    : await db.cloudFile.create({
        data: {
          name: stat.name,
          folderId: null, // referensi mount — bukan file folder kelas
          uploadedBy: user.id,
          storageKey,
          size: stat.size,
          mimetype,
          visibility: "ALL",
          cloudAccountId: account.id,
          // PERMANEN — bukan lampiran sementara.
          expiresAt: null,
        },
        select: {
          id: true,
          name: true,
          size: true,
          mimetype: true,
          storageKey: true,
          createdAt: true,
          uploader: { select: { id: true, name: true, username: true } },
        },
      });

  return NextResponse.json({
    file: {
      id: row.id,
      name: row.name,
      size: row.size,
      mimetype: row.mimetype,
      storageKey: row.storageKey,
      createdAt: row.createdAt,
      folderName: "Mount MEGA",
      uploader: row.uploader,
    },
    reused: !!existing,
  });
}
