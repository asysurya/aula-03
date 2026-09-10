import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db } from "@/lib/db";
import { hardDeleteCloudFilesByIds } from "@/lib/hard-delete";
import { hydrateAssignments, type AssignmentCardDto } from "@/lib/chat-sync";
import { getClassroomRole } from "@/lib/cloud-utils";

type ConversationKind = "classroom" | "group" | "dm";

interface SenderDto {
  id: string;
  name: string;
  username: string;
  avatarUrl: string | null;
  avatarColor: string;
}

interface AttachmentFileDto {
  id: string;
  name: string;
  size: number;
  mimetype: string;
  storageKey: string;
  expiresAt: string | null;
}

interface ReactionDto {
  id: string;
  emoji: string;
  user: { id: string; name: string; username: string };
}

interface ReplyToDto {
  id: string;
  content: string;
  sender: { id: string; name: string; username: string };
}

interface MessageDto {
  id: string;
  content: string;
  createdAt: string;
  editedAt: string | null;
  senderId: string;
  sender: SenderDto;
  attachments: Array<{ id: string; file: AttachmentFileDto }>;
  reactions: ReactionDto[];
  replyTo: ReplyToDto | null;
  assignmentId: string | null;
  assignment: AssignmentCardDto | null;
  pinnedAt: string | null;
}

const senderSelect = {
  id: true,
  name: true,
  username: true,
  avatarUrl: true,
  avatarColor: true,
} as const;

const messageInclude = {
  sender: { select: senderSelect },
  attachments: {
    include: {
      file: {
        select: {
          id: true,
          name: true,
          size: true,
          mimetype: true,
          storageKey: true,
          expiresAt: true,
        },
      },
    },
  },
  reactions: {
    include: {
      user: { select: { id: true, name: true, username: true } },
    },
  },
  replyTo: {
    include: {
      sender: { select: { id: true, name: true, username: true } },
    },
  },
} as const;

async function assertMembership(
  kind: ConversationKind,
  convId: string,
  userId: string
): Promise<boolean> {
  if (kind === "classroom") {
    const m = await db.classroomMember.findUnique({
      where: { classroomId_userId: { classroomId: convId, userId } },
    });
    return !!m;
  }
  if (kind === "group") {
    const m = await db.groupMember.findUnique({
      where: { groupId_userId: { groupId: convId, userId } },
    });
    return !!m;
  }
  if (kind === "dm") {
    const dm = await db.dMConversation.findUnique({ where: { id: convId } });
    if (!dm) return false;
    return dm.user1Id === userId || dm.user2Id === userId;
  }
  return false;
}

function toDto(m: {
  id: string;
  content: string;
  createdAt: Date;
  editedAt: Date | null;
  senderId: string;
  assignmentId: string | null;
  pinnedAt: Date | null;
  sender: SenderDto;
  attachments: Array<{ id: string; file: AttachmentFileDto & { expiresAt: Date | null } }>;
  reactions: ReactionDto[];
  replyTo: ReplyToDto | null;
}): MessageDto {
  return {
    id: m.id,
    content: m.content,
    createdAt: m.createdAt.toISOString(),
    editedAt: m.editedAt ? m.editedAt.toISOString() : null,
    senderId: m.senderId,
    sender: m.sender,
    attachments: m.attachments.map((a) => ({
      id: a.id,
      file: {
        ...a.file,
        expiresAt: a.file.expiresAt
          ? new Date(a.file.expiresAt).toISOString()
          : null,
      },
    })),
    reactions: m.reactions,
    replyTo: m.replyTo,
    assignmentId: m.assignmentId ?? null,
    assignment: null,
    pinnedAt: m.pinnedAt ? new Date(m.pinnedAt).toISOString() : null,
  };
}

// PATCH /api/chat/messages/[id]
// Dua mode:
//  a) { content: string }  → edit pesan (hanya pengirim).
//  b) { pinned: boolean }  → sematkan/lepas sematan (pengirim, ADMIN, atau
//     guru kelas tempat pesan berada).
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = (session.user as any).id as string;
  const role = (session.user as any).role as string;
  const { id } = await params;

  const body = await req.json().catch(() => null);
  if (!body) {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  const isPinRequest =
    typeof body.pinned === "boolean" && body.content === undefined;

  const existing = await db.message.findUnique({
    where: { id },
    select: {
      id: true,
      senderId: true,
      classroomId: true,
      groupId: true,
      dmId: true,
      pinnedAt: true,
    },
  });
  if (!existing) {
    return NextResponse.json({ error: "Pesan tidak ditemukan" }, { status: 404 });
  }

  // Verify the caller is still a member of the conversation (defensive).
  const convId =
    existing.classroomId ?? existing.groupId ?? existing.dmId ?? null;
  if (convId) {
    const kind: ConversationKind | null = existing.classroomId
      ? "classroom"
      : existing.groupId
        ? "group"
        : existing.dmId
          ? "dm"
          : null;
    if (kind) {
      const ok = await assertMembership(kind, convId, userId);
      if (!ok) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
    }
  }

  // ── Mode PIN ────────────────────────────────────────────────────
  if (isPinRequest) {
    const wantPin = body.pinned as boolean;
    // Hak pin: pengirim pesan, ADMIN, atau guru kelas.
    let canPin = existing.senderId === userId || role === "ADMIN";
    if (!canPin && existing.classroomId && role === "GURU") {
      const cr = await getClassroomRole(existing.classroomId, userId);
      canPin = cr === "TEACHER";
    }
    if (!canPin) {
      return NextResponse.json(
        { error: "Hanya pengirim, guru kelas, atau admin yang bisa menyematkan" },
        { status: 403 }
      );
    }
    const updated = await db.message.update({
      where: { id },
      // Pin: set waktu (sync realtime menangkap via pinnedAt > since).
      // Unpin: null (badge di klien lain segar saat reload / dialog sematan
      // selalu mengambil data baru dari server).
      data: { pinnedAt: wantPin ? new Date() : null },
      include: messageInclude,
    });
    const [dto] = await hydrateAssignments([toDto(updated)]);
    return NextResponse.json({ message: dto });
  }

  // ── Mode EDIT konten ────────────────────────────────────────────
  const content =
    typeof body.content === "string" ? body.content.trim() : "";
  if (!content) {
    return NextResponse.json(
      { error: "Pesan tidak boleh kosong" },
      { status: 400 }
    );
  }
  if (content.length > 4000) {
    return NextResponse.json(
      { error: "Pesan terlalu panjang" },
      { status: 400 }
    );
  }

  if (existing.senderId !== userId) {
    return NextResponse.json(
      { error: "Hanya dapat mengedit pesan sendiri" },
      { status: 403 }
    );
  }

  const updated = await db.message.update({
    where: { id },
    data: { content, editedAt: new Date() },
    include: messageInclude,
  });

  const [dto] = await hydrateAssignments([toDto(updated)]);
  return NextResponse.json({ message: dto });
}

// DELETE /api/chat/messages/[id]
// Sender or ADMIN can delete.
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = (session.user as any).id as string;
  const role = (session.user as any).role as string;
  const { id } = await params;

  const existing = await db.message.findUnique({
    where: { id },
    select: { id: true, senderId: true },
  });
  if (!existing) {
    return NextResponse.json({ error: "Pesan tidak ditemukan" }, { status: 404 });
  }

  if (existing.senderId !== userId && role !== "ADMIN") {
    return NextResponse.json(
      { error: "Anda tidak berhak menghapus pesan ini" },
      { status: 403 }
    );
  }

  // HARD DELETE: pesan + relasinya + file lampiran sementara (baris
  // CloudFile DAN blob di MEGA/lokal) — tidak menyisakan file tersembunyi.
  // FIX: file PERMANEN cloud (dilampirkan lewat Cloud Picker, expiresAt
  // null) TIDAK ikut dihapus — itu file asli di cloud pemiliknya.
  const attachments = await db.messageAttachment.findMany({
    where: { messageId: id },
    select: { fileId: true },
  });
  const allFileIds = attachments.map((a) => a.fileId);
  const permFiles = allFileIds.length
    ? await db.cloudFile.findMany({
        where: { id: { in: allFileIds }, expiresAt: null },
        select: { id: true },
      })
    : [];
  const tempFileIds = allFileIds.filter(
    (fid) => !permFiles.some((p) => p.id === fid)
  );

  await db.messageAttachment.deleteMany({ where: { messageId: id } });
  // Reaksi & tanda baca harus dibersihkan dulu — kalau tidak, Prisma
  // menolak menghapus pesan (relasi wajib) → error 500 "gagal hapus".
  await db.messageReaction.deleteMany({ where: { messageId: id } });
  await db.readReceipt.deleteMany({ where: { messageId: id } });
  // Pesan lain yang membalas pesan ini → lepas tautan balasan
  // (tetap tampil, tanpa indikator balasan).
  await db.message.updateMany({
    where: { replyToId: id },
    data: { replyToId: null },
  });
  await db.message.delete({ where: { id } });
  await hardDeleteCloudFilesByIds(tempFileIds);

  return NextResponse.json({ ok: true });
}
