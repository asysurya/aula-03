import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db } from "@/lib/db";

// POST /api/chat/messages/sync
// Realtime sync untuk pesan BARU, pesan DIUBAH (edit/reaksi), dan pesan
// DIHAPUS — dipanggil client lewat polling (MESSAGE_POLL_INTERVAL).
//
// Body: { kind, id, since?: ISO, loadedIds?: string[] }
//  - since     → timestamp poll sukses terakhir (jam SERVER, dari serverTime
//                response sebelumnya) — supaya bebas skew jam client.
//  - loadedIds → id pesan yang saat ini dimuat client (window aktif).
//
// Response: { new: MessageDto[], changed: MessageDto[], deletedIds: string[],
//             serverTime: ISO }
//  - new       → pesan dengan createdAt > since
//  - changed   → pesan dengan editedAt > since (edit) ATAU reaksinya
//                berubah sejak since (replace penuh di client)
//  - deletedIds→ loadedIds yang sudah tidak ada di DB (hard delete)

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

const messageInclude = {
  sender: { select: senderSelect },
  attachments: { include: attachmentInclude },
  reactions: { include: { user: { select: reactionUserSelect } } },
  replyTo: { include: { sender: { select: replyToSenderSelect } } },
} as const;

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

// Emoji korup (sisa bug klien lama) — disaring dari hasil.
const BAD_EMOJI_RE = /^[A-Za-z0-9:_-]+$/;

function sanitizeReactions(m: MessageWithRelations): MessageWithRelations {
  if (!m.reactions || m.reactions.length === 0) return m;
  const ok = m.reactions.filter((r) => !BAD_EMOJI_RE.test(r.emoji));
  if (ok.length === m.reactions.length) return m;
  return { ...m, reactions: ok };
}

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

const MAX_LOADED_IDS = 500;

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
  const kind = body.kind as ConversationKind | undefined;
  const id = body.id as string | undefined;
  const since = typeof body.since === "string" ? body.since : null;
  const loadedIdsRaw = Array.isArray(body.loadedIds) ? body.loadedIds : [];

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

  // Sample waktu server SEBELUM query (konservatif): event yang terjadi saat
  // query berjalan akan tertangkap lagi oleh poll berikutnya. Duplikat di
  // sisi client dieliminasi lewat merge by id (idempotent).
  const serverTime = new Date().toISOString();

  const sinceParsed = since ? new Date(since) : null;
  const sinceDate =
    sinceParsed && !Number.isNaN(sinceParsed.getTime())
      ? sinceParsed
      : new Date(0);

  // Id pesan yang dimuat client — filter id optimistik ("temp_") supaya
  // pesan kiriman yang masih in-flight tidak salah dianggap terhapus.
  const loadedIds = loadedIdsRaw
    .filter(
      (x: unknown): x is string =>
        typeof x === "string" &&
        x.length > 0 &&
        x.length <= 64 &&
        !x.startsWith("temp_")
    )
    .slice(0, MAX_LOADED_IDS);

  const convWhere: Record<string, unknown> = {};
  if (kind === "classroom") convWhere.classroomId = id;
  else if (kind === "group") convWhere.groupId = id;
  else convWhere.dmId = id;

  // 1) Pesan baru sejak since.
  const newRaw = (await db.message.findMany({
    where: { ...convWhere, createdAt: { gt: sinceDate } },
    orderBy: { createdAt: "asc" },
    take: 100,
    include: messageInclude,
  })) as unknown as MessageWithRelations[];

  // 2) Pesan yang diedit sejak since (editedAt null tidak match "gt").
  const editedRaw = await db.message.findMany({
    where: { ...convWhere, editedAt: { gt: sinceDate } },
    select: { id: true },
    take: 200,
  });

  // 3) Pesan yang reaksinya bertambah sejak since (hapus reaksi murni tidak
  //    meninggalkan jejak row — ditangkap lewat replace penuh saat ada
  //    perubahan lain pada pesan yang sama).
  const reactionTouched = loadedIds.length
    ? await db.messageReaction.findMany({
        where: { messageId: { in: loadedIds }, createdAt: { gt: sinceDate } },
        select: { messageId: true },
        take: 1000,
      })
    : [];

  const newIds = new Set(newRaw.map((m) => m.id));
  const changedIds = Array.from(
    new Set([
      ...editedRaw.map((m) => m.id),
      ...reactionTouched.map((r) => r.messageId),
    ])
  )
    .filter((mid) => !newIds.has(mid))
    .slice(0, 100);

  const changedRaw = changedIds.length
    ? ((await db.message.findMany({
        where: { id: { in: changedIds } },
        include: messageInclude,
      })) as unknown as MessageWithRelations[])
    : [];

  // 4) Pesan terhapus: loadedIds yang sudah tidak ada di DB.
  const still = loadedIds.length
    ? await db.message.findMany({
        where: { id: { in: loadedIds } },
        select: { id: true },
      })
    : [];
  const stillSet = new Set(still.map((s) => s.id));
  const deletedIds = loadedIds.filter((mid) => !stillSet.has(mid));

  return NextResponse.json({
    new: newRaw.map(sanitizeReactions).map(toDto),
    changed: changedRaw.map(sanitizeReactions).map(toDto),
    deletedIds,
    serverTime,
  });
}
