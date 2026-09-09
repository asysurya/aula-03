import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/session";
import { db } from "@/lib/db";
import { saveFile } from "@/lib/storage";
import { hardDeleteCloudFilesByIds } from "@/lib/hard-delete";

// POST /api/profile/avatar — multipart `file` (gambar, maks 5 MB).
// Upload foto profil ke cloud (MEGA/S3), lalu set user.avatarUrl ke
// /api/storage/<key>. Foto lama (juga file cloud-nya) otomatis dihapus.
//
// DELETE /api/profile/avatar — hapus foto profil (file cloud ikut dihapus,
// hard delete).

const MAX_AVATAR_BYTES = 5 * 1024 * 1024; // 5 MB

function avatarStorageKeyFromUrl(url: string | null): string | null {
  if (!url || !url.startsWith("/api/storage/")) return null;
  try {
    return decodeURIComponent(url.slice("/api/storage/".length));
  } catch {
    return null;
  }
}

async function cleanupOldAvatar(userId: string): Promise<void> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { avatarUrl: true },
  });
  const oldKey = avatarStorageKeyFromUrl(user?.avatarUrl ?? null);
  if (!oldKey) return;
  const rows = await db.cloudFile.findMany({
    where: { storageKey: oldKey },
    select: { id: true },
  });
  if (rows.length > 0) {
    await hardDeleteCloudFilesByIds(rows.map((r) => r.id));
  }
}

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

  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "FILE_REQUIRED" }, { status: 400 });
  }
  if (file.size === 0) {
    return NextResponse.json({ error: "FILE_EMPTY" }, { status: 400 });
  }
  if (file.size > MAX_AVATAR_BYTES) {
    return NextResponse.json(
      { error: "Foto maksimal 5 MB" },
      { status: 413 }
    );
  }
  const mimetype = file.type || "";
  if (!mimetype.startsWith("image/")) {
    return NextResponse.json(
      { error: "File harus berupa gambar (jpg/png/webp/gif)" },
      { status: 415 }
    );
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  const name = file.name || "avatar.png";
  let stored: { storageKey: string; size: number; cloudAccountId: string | null };
  try {
    stored = await saveFile(name, mimetype, bytes);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "SAVE_FAILED";
    return NextResponse.json({ error: msg }, { status: 502 });
  }

  // Baris CloudFile tanpa folder + tanpa expiresAt → dapat dilihat semua
  // user yang login (avatar muncul di chat, anggota, dsb.).
  await db.cloudFile.create({
    data: {
      name,
      folderId: null,
      uploadedBy: user.id,
      storageKey: stored.storageKey,
      size: stored.size,
      mimetype,
      cloudAccountId: stored.cloudAccountId,
      visibility: "ALL",
    },
  });

  // Hapus foto lama (file cloud + baris DB) — hard delete.
  await cleanupOldAvatar(user.id);

  const avatarUrl = `/api/storage/${stored.storageKey}`;
  await db.user.update({
    where: { id: user.id },
    data: { avatarUrl },
  });

  return NextResponse.json({ ok: true, avatarUrl }, { status: 201 });
}

export async function DELETE() {
  const user = await requireUser().catch(() => null);
  if (!user) {
    return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
  }
  await cleanupOldAvatar(user.id);
  await db.user.update({
    where: { id: user.id },
    data: { avatarUrl: null },
  });
  return NextResponse.json({ ok: true });
}
