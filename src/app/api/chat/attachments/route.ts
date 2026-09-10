import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { ALLOWED_MIMES, MAX_FILE_SIZE, saveFile } from "@/lib/storage";
import { resolveMime } from "@/lib/file-constants";

// Upload lampiran chat bisa menyentuh MEGA (login + upload) — beri waktu
// cukup supaya tidak dibunuh limit default Vercel (penyebab "lampiran gagal").
export const runtime = "nodejs";
export const maxDuration = 60;

// Conversation membership validation shared with /api/chat/messages.
type ConversationKind = "classroom" | "group" | "dm";

async function assertMembership(
  kind: ConversationKind,
  id: string,
  userId: string
): Promise<boolean> {
  if (kind === "classroom") {
    const m = await db.classroomMember.findUnique({
      where: { classroomId_userId: { classroomId: id, userId } },
    });
    return !!m;
  }
  if (kind === "group") {
    const m = await db.groupMember.findUnique({
      where: { groupId_userId: { groupId: id, userId } },
    });
    return !!m;
  }
  if (kind === "dm") {
    const dm = await db.dMConversation.findUnique({ where: { id } });
    if (!dm) return false;
    return dm.user1Id === userId || dm.user2Id === userId;
  }
  return false;
}

// POST /api/chat/attachments
// multipart/form-data: file (File), kind (classroom|group|dm), id (conversation id).
// Creates a PERMANENT CloudFile (expiresAt = null, folderId = null, visibility = ALL)
// — file tersimpan di cloud, TIDAK ikut terhapus saat pesan dihapus, dan bisa
// dipakai ulang di pesan lain. Returns { fileId, name, size, mimetype, storageKey }.
export async function POST(req: NextRequest) {
  const user = await requireUser().catch(() => null);
  if (!user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return Response.json({ error: "INVALID_FORMDATA" }, { status: 400 });
  }

  const file = form.get("file");
  const kind = (form.get("kind") as string | null) as ConversationKind | null;
  const id = form.get("id") as string | null;

  if (!(file instanceof File)) {
    return Response.json({ error: "FILE_REQUIRED" }, { status: 400 });
  }
  if (!kind || !id) {
    return Response.json(
      { error: "kind and id are required" },
      { status: 400 }
    );
  }
  if (!["classroom", "group", "dm"].includes(kind)) {
    return Response.json({ error: "Invalid kind" }, { status: 400 });
  }
  if (file.size === 0) {
    return Response.json({ error: "FILE_EMPTY" }, { status: 400 });
  }
  if (file.size > MAX_FILE_SIZE) {
    return Response.json(
      { error: "FILE_TOO_LARGE", maxBytes: MAX_FILE_SIZE },
      { status: 413 }
    );
  }

  // Mimetype final: pakai mimetype OS kalau valid, kalau tidak → infer dari
  // ekstensi (file Android/OS lama sering kosong atau salah).
  const mimetype = resolveMime(file.name, file.type);
  if (!ALLOWED_MIMES.has(mimetype)) {
    return Response.json(
      { error: "MIME_NOT_ALLOWED", mimetype },
      { status: 415 }
    );
  }

  // Verify the user is a member of the conversation.
  const ok = await assertMembership(kind, id, user.id);
  if (!ok) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  let stored: { storageKey: string; size: number; cloudAccountId: string | null };
  try {
    stored = await saveFile(file.name, mimetype, bytes);
  } catch (e) {
    // Pesan error dari saveFile sudah ramah-user (deskripsi MEGA/S3 lengkap
    // dalam bahasa Indonesia) — tampilkan langsung.
    const msg = e instanceof Error ? e.message : "SAVE_FAILED";
    return Response.json({ error: msg }, { status: 502 });
  }

  // Create the CloudFile row — PERMANEN (expiresAt null).
  const row = await db.cloudFile.create({
    data: {
      name: file.name,
      folderId: null, // chat attachments live outside the cloud folder tree
      uploadedBy: user.id,
      storageKey: stored.storageKey,
      size: stored.size,
      mimetype,
      visibility: "ALL", // conversation members can see
      cloudAccountId: stored.cloudAccountId,
      expiresAt: null,
    },
    select: {
      id: true,
      name: true,
      size: true,
      mimetype: true,
      storageKey: true,
    },
  });

  return Response.json(
    {
      fileId: row.id,
      name: row.name,
      size: row.size,
      mimetype: row.mimetype,
      storageKey: row.storageKey,
    },
    { status: 201 }
  );
}
