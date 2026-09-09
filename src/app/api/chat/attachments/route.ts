import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { ALLOWED_MIMES, MAX_FILE_SIZE, saveFile } from "@/lib/storage";

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

// 24h in milliseconds.
const TTL_MS = 24 * 60 * 60 * 1000;

// POST /api/chat/attachments
// multipart/form-data: file (File), kind (classroom|group|dm), id (conversation id).
// Creates a temporary CloudFile (expiresAt = now + 24h, folderId = null, visibility = ALL).
// Returns { fileId, name, size, mimetype, storageKey }.
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

  const mimetype = file.type || "application/octet-stream";
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
    const msg = e instanceof Error ? e.message : "SAVE_FAILED";
    if (msg === "MEGA_NOT_CONFIGURED") {
      return Response.json({ error: "MEGA belum dikonfigurasi. Admin harus menambahkan akun MEGA." }, { status: 400 });
    }
    if (msg === "MEGA_TIMEOUT") {
      return Response.json({ error: "Upload timeout. File terlalu besar atau koneksi lambat." }, { status: 504 });
    }
    if (msg.includes("EBLOCKED") || msg.includes("User blocked")) {
      return Response.json({ error: "Akun MEGA diblokir sementara. Tunggu 5-10 menit." }, { status: 429 });
    }
    return Response.json({ error: "Gagal upload: " + msg }, { status: 500 });
  }

  // Create the CloudFile row with expiresAt set (temp chat attachment).
  const row = await db.cloudFile.create({
    data: {
      name: file.name,
      folderId: null, // temp chat files live outside the cloud folder tree
      uploadedBy: user.id,
      storageKey: stored.storageKey,
      size: stored.size,
      mimetype,
      visibility: "ALL", // conversation members can see
      cloudAccountId: stored.cloudAccountId,
      expiresAt: new Date(Date.now() + TTL_MS),
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
