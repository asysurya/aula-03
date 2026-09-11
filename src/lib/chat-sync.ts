import { db } from "@/lib/db";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";

// ─────────────────────────────────────────────────────────────────────────
// Chat sync core — dipakai bersama oleh:
// 1. POST /api/chat/messages/sync   (polling fallback, tiap 2,5 dtk)
// 2. GET  /api/chat/messages/stream (SSE — push delta tiap ±400 ms, "0-delay")
//
// Delta = { new, changed, deletedIds, serverTime }:
//  - new       → pesan dengan createdAt > since
//  - changed   → pesan dengan editedAt/pinnedAt/reactionTouchedAt > since
//               (edit / pin / reaksi bertambah ATAU dihapus)
//  - deletedIds→ loadedIds yang sudah tidak ada di DB (hard delete)
//
// serverTime di-sample SEBELUM query (konservatif) — event yang terjadi saat
// query berjalan tertangkap lagi di siklus berikutnya; duplikat di client
// dieliminasi by id (idempotent).
// ─────────────────────────────────────────────────────────────────────────

export type ConversationKind = "classroom" | "group" | "dm";

export interface AssignmentCardDto {
  id: string;
  folderId: string;
  title: string;
  description: string | null;
  deadline: string;
  maxScore: number | null;
  classroomName: string | null;
  /** Jumlah soal form (null = tugas tanpa form / upload saja). */
  questionCount: number | null;
  /** Sudah lewat tenggat? (dihitung saat response dibuat). */
  deadlinePassed: boolean;
}

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
  /** null = file permanen cloud (bukan file sementara 24 jam). */
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

export interface ChatMessageDto {
  id: string;
  content: string;
  createdAt: string;
  editedAt: string | null;
  senderId: string;
  sender: SenderDto;
  attachments: Array<{ id: string; file: AttachmentFileDto }>;
  reactions: ReactionDto[];
  replyTo: ReplyToDto | null;
  /** Id tugas yang dilampirkan (null = tanpa tugas). */
  assignmentId: string | null;
  /** Kartu tugas — null bila tugas sudah dihapus (tampilkan makam). */
  assignment: AssignmentCardDto | null;
  pinnedAt: string | null;
}

export interface ChatSyncDelta {
  new: ChatMessageDto[];
  changed: ChatMessageDto[];
  deletedIds: string[];
  serverTime: string;
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
      expiresAt: true,
    },
  },
} as const;

export const chatMessageInclude = {
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
  assignmentId: string | null;
  pinnedAt: Date | null;
  attachments: Array<{
    id: string;
    file: AttachmentFileDto & { expiresAt: Date | null };
  }>;
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

function toDto(m: MessageWithRelations): ChatMessageDto {
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

// ── Hidrasi kartu tugas ───────────────────────────────────────────────
// assignmentId di Message adalah scalar TANPA relasi Prisma (aman untuk DB
// lama). Data kartu digabung manual di sini — dipakai semua route pesan.
export async function hydrateAssignments(
  dtos: ChatMessageDto[]
): Promise<ChatMessageDto[]> {
  const ids = Array.from(
    new Set(
      dtos
        .map((d) => d.assignmentId)
        .filter((x): x is string => typeof x === "string" && x.length > 0)
    )
  );
  if (ids.length === 0) return dtos;

  const assignments = await db.assignment.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      folderId: true,
      title: true,
      description: true,
      deadline: true,
      maxScore: true,
      folder: { select: { name: true, classroom: { select: { name: true } } } },
      form: {
        select: {
          id: true,
          questions: { select: { id: true } },
        },
      },
    },
  });
  const map = new Map<string, AssignmentCardDto>();
  const now = Date.now();
  for (const a of assignments) {
    map.set(a.id, {
      id: a.id,
      folderId: a.folderId,
      title: a.title,
      description: a.description,
      deadline: new Date(a.deadline).toISOString(),
      maxScore: a.maxScore,
      classroomName:
        a.folder?.classroom?.name ?? a.folder?.name ?? null,
      questionCount: a.form ? a.form.questions.length : null,
      deadlinePassed: new Date(a.deadline).getTime() < now,
    });
  }
  return dtos.map((d) => ({
    ...d,
    assignment: d.assignmentId ? map.get(d.assignmentId) ?? null : null,
  }));
}

// Emoji korup (sisa bug klien lama) — disaring dari hasil.
const BAD_EMOJI_RE = /^[A-Za-z0-9:_-]+$/;

function sanitizeReactions(m: MessageWithRelations): MessageWithRelations {
  if (!m.reactions || m.reactions.length === 0) return m;
  const ok = m.reactions.filter((r) => !BAD_EMOJI_RE.test(r.emoji));
  if (ok.length === m.reactions.length) return m;
  return { ...m, reactions: ok };
}

export async function assertConversationMembership(
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

/** User dari session NextAuth (null kalau tidak login). */
export async function currentUserId(): Promise<string | null> {
  const session = await getServerSession(authOptions).catch(() => null);
  if (!session?.user) return null;
  return (session.user as { id?: string }).id ?? null;
}

export const MAX_SYNC_LOADED_IDS = 500;

/** Filter id pesan valid (buang id optimistik client & aneh). */
export function sanitizeLoadedIds(raw: unknown[]): string[] {
  return raw
    .filter(
      (x): x is string =>
        typeof x === "string" &&
        x.length > 0 &&
        x.length <= 64 &&
        !x.startsWith("temp_")
    )
    .slice(0, MAX_SYNC_LOADED_IDS);
}

/** Id pesan pada window terakhir (200 terbaru) — dipakai snapshot awal SSE. */
export async function getWindowMessageIds(
  kind: ConversationKind,
  convId: string
): Promise<string[]> {
  const where: Record<string, unknown> = {};
  if (kind === "classroom") where.classroomId = convId;
  else if (kind === "group") where.groupId = convId;
  else where.dmId = convId;
  const rows = await db.message.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: 200,
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

/**
 * Hitung delta percakapan. `loadedIds` = id pesan yang dimuat client
 * (untuk deteksi pesan terhapus).
 */
export async function computeChatSyncDelta(
  kind: ConversationKind,
  convId: string,
  since: Date,
  loadedIds: string[]
): Promise<ChatSyncDelta> {
  // Sample SEBELUM query (konservatif — lihat header file).
  const serverTime = new Date().toISOString();

  const convWhere: Record<string, unknown> = {};
  if (kind === "classroom") convWhere.classroomId = convId;
  else if (kind === "group") convWhere.groupId = convId;
  else convWhere.dmId = convId;

  // 1) Pesan baru sejak since.
  const newRaw = (await db.message.findMany({
    where: { ...convWhere, createdAt: { gt: since } },
    orderBy: { createdAt: "asc" },
    take: 100,
    include: chatMessageInclude,
  })) as unknown as MessageWithRelations[];

  // 2) Pesan yang berubah sejak since: diedit, dipin, atau reaksinya
  //    tersentuh (tambah ATAU hapus — reactionTouchedAt di-set route reaksi
  //    pada KEDUA cabang toggle). Field null (dokumen lama) tidak match
  //    "gt" — aman. Query ini conversation-wide (tidak dibatasi loadedIds)
  //    sehingga reaksi pada pesan di luar window tetap terdeteksi.
  //    Pin → realtime; unpin → segar saat reload.
  const editedRaw = await db.message.findMany({
    where: {
      ...convWhere,
      OR: [
        { editedAt: { gt: since } },
        { pinnedAt: { gt: since } },
        { reactionTouchedAt: { gt: since } },
      ],
    },
    select: { id: true },
    take: 200,
  });

  // 3) Reaksi BARU pada pesan loaded — melengkapi reactionTouchedAt untuk
  //    baris reaksi yang dibuat sebelum penanda itu diperkenalkan.
  const reactionTouched = loadedIds.length
    ? await db.messageReaction.findMany({
        where: { messageId: { in: loadedIds }, createdAt: { gt: since } },
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
        include: chatMessageInclude,
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

  const hydratedNew = await hydrateAssignments(
    newRaw.map(sanitizeReactions).map(toDto)
  );
  const hydratedChanged = await hydrateAssignments(
    changedRaw.map(sanitizeReactions).map(toDto)
  );

  return {
    new: hydratedNew,
    changed: hydratedChanged,
    deletedIds,
    // Patokan (`serverTime` dipakai semua konsumen sebagai `since` berikutnya):
    // bila jendela 100 pesan BARU penuh tercapai, JANGAN lompat ke "sekarang"
    // — pesan di belakang 100 tertua belum terkirim & akan terlewati
    // selamanya. Gunakan createdAt pesan TERAKHIR yang terkirim supaya
    // delta berikutnya melanjutkan sisa antrean (client dedupe by id
    // membuat pengiriman ulang aman).
    serverTime:
      newRaw.length >= 100 && newRaw.length > 0
        ? new Date(newRaw[newRaw.length - 1].createdAt).toISOString()
        : serverTime,
  };
}
