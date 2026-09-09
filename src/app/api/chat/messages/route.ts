import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db } from "@/lib/db";
import type { Prisma } from "@prisma/client";

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
}

interface AttachmentDto {
  id: string;
  file: AttachmentFileDto;
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
  attachments: AttachmentDto[];
  reactions: ReactionDto[];
  replyTo: ReplyToDto | null;
}

const senderSelect = {
  id: true,
  name: true,
  username: true,
  avatarUrl: true,
  avatarColor: true,
} as const;

const reactionUserSelect = {
  id: true,
  name: true,
  username: true,
} as const;

const replyToSenderSelect = {
  id: true,
  name: true,
  username: true,
} as const;

const attachmentInclude = {
  file: {
    select: {
      id: true,
      name: true,
      size: true,
      mimetype: true,
      storageKey: true,
    },
  },
} as const;

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

type MessageWithRelations = {
  id: string;
  content: string;
  createdAt: Date;
  editedAt: Date | null;
  senderId: string;
  sender: SenderDto;
  attachments: Array<{ id: string; file: AttachmentFileDto }>;
  reactions: Array<{
    id: string;
    emoji: string;
    user: { id: string; name: string; username: string };
  }>;
  replyTo: {
    id: string;
    content: string;
    sender: { id: string; name: string; username: string };
  } | null;
};

function toDto(m: MessageWithRelations): MessageDto {
  return {
    id: m.id,
    content: m.content,
    createdAt: m.createdAt.toISOString(),
    editedAt: m.editedAt ? m.editedAt.toISOString() : null,
    senderId: m.senderId,
    sender: m.sender,
    attachments: m.attachments,
    reactions: m.reactions,
    replyTo: m.replyTo,
  };
}

const messageInclude = {
  sender: { select: senderSelect },
  attachments: { include: attachmentInclude },
  reactions: { include: { user: { select: reactionUserSelect } } },
  replyTo: { include: { sender: { select: replyToSenderSelect } } },
} as const;

// GET /api/chat/messages?kind=group&id=abc&since=ISO
export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = (session.user as any).id as string;

  const url = new URL(req.url);
  const kind = url.searchParams.get("kind") as ConversationKind | null;
  const id = url.searchParams.get("id");
  const since = url.searchParams.get("since");

  if (!kind || !id) {
    return NextResponse.json(
      { error: "kind and id are required" },
      { status: 400 }
    );
  }
  if (!["classroom", "group", "dm"].includes(kind)) {
    return NextResponse.json({ error: "Invalid kind" }, { status: 400 });
  }

  const ok = await assertMembership(kind, id, userId);
  if (!ok) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const where: Record<string, unknown> = {};
  if (kind === "classroom") where.classroomId = id;
  else if (kind === "group") where.groupId = id;
  else where.dmId = id;

  if (since) {
    const sinceDate = new Date(since);
    if (!Number.isNaN(sinceDate.getTime())) {
      where.createdAt = { gt: sinceDate };
    }
  }

  const messages = (await db.message.findMany({
    where,
    orderBy: { createdAt: "asc" },
    take: 200,
    include: messageInclude,
  })) as unknown as MessageWithRelations[];

  return NextResponse.json({ messages: messages.map(toDto) });
}

// POST /api/chat/messages  body: { kind, id, content, attachmentFileIds?, replyToId? }
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = (session.user as any).id as string;

  const body = await req.json().catch(() => null);
  if (!body) {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }
  const kind = body.kind as ConversationKind;
  const id = body.id as string;
  const content = typeof body.content === "string" ? body.content.trim() : "";
  const attachmentFileIdsRaw = Array.isArray(body.attachmentFileIds)
    ? body.attachmentFileIds
    : [];
  const attachmentFileIds = attachmentFileIdsRaw
    .filter((x: unknown): x is string => typeof x === "string" && x.length > 0)
    .slice(0, 5); // cap at 5 per message
  const replyToIdRaw = body.replyToId;
  const replyToId =
    typeof replyToIdRaw === "string" && replyToIdRaw.length > 0
      ? replyToIdRaw
      : null;

  if (!kind || !id) {
    return NextResponse.json(
      { error: "kind and id are required" },
      { status: 400 }
    );
  }
  if (!["classroom", "group", "dm"].includes(kind)) {
    return NextResponse.json({ error: "Invalid kind" }, { status: 400 });
  }
  // Content may be empty if there are attachments.
  if (!content && attachmentFileIds.length === 0) {
    return NextResponse.json(
      { error: "Pesan tidak boleh kosong" },
      { status: 400 }
    );
  }
  if (content.length > 4000) {
    return NextResponse.json({ error: "Pesan terlalu panjang" }, { status: 400 });
  }

  const ok = await assertMembership(kind, id, userId);
  if (!ok) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Validate replyToId belongs to the same conversation (if provided).
  if (replyToId) {
    const parent = await db.message.findUnique({
      where: { id: replyToId },
      select: {
        id: true,
        classroomId: true,
        groupId: true,
        dmId: true,
      },
    });
    if (!parent) {
      return NextResponse.json(
        { error: "Pesan yang dibalas tidak ditemukan" },
        { status: 400 }
      );
    }
    const sameConversation =
      (kind === "classroom" && parent.classroomId === id) ||
      (kind === "group" && parent.groupId === id) ||
      (kind === "dm" && parent.dmId === id);
    if (!sameConversation) {
      return NextResponse.json(
        { error: "Pesan yang dibalas tidak dari percakapan ini" },
        { status: 400 }
      );
    }
  }

  // Validate each attachment file id: exists, expiresAt set (temp chat file),
  // and uploadedBy === currentUser (security: can't attach someone else's file).
  if (attachmentFileIds.length > 0) {
    const files = await db.cloudFile.findMany({
      where: { id: { in: attachmentFileIds } },
      select: { id: true, uploadedBy: true, expiresAt: true },
    });
    if (files.length !== attachmentFileIds.length) {
      return NextResponse.json(
        { error: "File lampiran tidak ditemukan" },
        { status: 400 }
      );
    }
    for (const f of files) {
      if (!f.expiresAt) {
        return NextResponse.json(
          { error: "File lampiran tidak valid" },
          { status: 400 }
        );
      }
      if (f.uploadedBy !== userId) {
        return NextResponse.json(
          { error: "File lampiran bukan milik Anda" },
          { status: 403 }
        );
      }
    }
  }

  const data: Prisma.MessageCreateInput = {
    content,
    sender: { connect: { id: userId } },
  };
  if (kind === "classroom") data.classroom = { connect: { id } };
  else if (kind === "group") data.group = { connect: { id } };
  else data.dm = { connect: { id } };

  if (replyToId) {
    data.replyTo = { connect: { id: replyToId } };
  }

  if (attachmentFileIds.length > 0) {
    data.attachments = {
      create: attachmentFileIds.map((fileId) => ({ file: { connect: { id: fileId } } })),
    };
  }

  const message = (await db.message.create({
    data,
    include: messageInclude,
  })) as unknown as MessageWithRelations;

  return NextResponse.json({ message: toDto(message) }, { status: 201 });
}
