import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db } from "@/lib/db";
import type { Prisma } from "@prisma/client";
import {
  hydrateAssignments,
  type AssignmentCardDto,
} from "@/lib/chat-sync";
import { folderClassroomId, getClassroomRole } from "@/lib/cloud-utils";
import { canViewFile, canViewFolder, type UserRole } from "@/lib/cloud-perms";
import { parseMegaKey } from "@/lib/mega-storage";
import { canViewMount } from "@/lib/mount-access";
import { sendPushToUsers } from "@/lib/web-push";

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

const messageInclude = {
  sender: { select: senderSelect },
  attachments: { include: attachmentInclude },
  reactions: { include: { user: { select: reactionUserSelect } } },
  replyTo: { include: { sender: { select: replyToSenderSelect } } },
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

type MessageWithRelations = Prisma.MessageGetPayload<{
  include: typeof messageInclude;
}>;

function toDto(m: MessageWithRelations): MessageDto {
  return {
    id: m.id,
    content: m.content,
    createdAt: m.createdAt.toISOString(),
    editedAt: m.editedAt ? m.editedAt.toISOString() : null,
    senderId: m.senderId,
    sender: m.sender as SenderDto,
    attachments: m.attachments.map((a) => ({
      id: a.id,
      file: {
        id: a.file.id,
        name: a.file.name,
        size: a.file.size,
        mimetype: a.file.mimetype,
        storageKey: a.file.storageKey,
        expiresAt: a.file.expiresAt
          ? new Date(a.file.expiresAt).toISOString()
          : null,
      },
    })) as AttachmentDto[],
    reactions: m.reactions as ReactionDto[],
    replyTo: m.replyTo as ReplyToDto | null,
    assignmentId: m.assignmentId ?? null,
    assignment: null,
    pinnedAt: m.pinnedAt ? new Date(m.pinnedAt).toISOString() : null,
  };
}

// Emoji korup = sisa bug klien lama yang mengirim ID pesan sebagai emoji
// (tampil sebagai teks aneh seperti cuid). Disaring dari hasil + dihapus.
const BAD_EMOJI_RE = /^[A-Za-z0-9:_-]+$/;

function sanitizeMessages(messages: MessageWithRelations[]): MessageWithRelations[] {
  let dirty = false;
  const cleaned = messages.map((m) => {
    if (!m.reactions || m.reactions.length === 0) return m;
    const ok = m.reactions.filter((r) => !BAD_EMOJI_RE.test(r.emoji));
    if (ok.length !== m.reactions.length) {
      dirty = true;
      return { ...m, reactions: ok };
    }
    return m;
  });
  if (dirty) {
    // Hapus baris korup di latar belakang (fire-and-forget).
    const badIds = messages.flatMap((m) =>
      (m.reactions ?? []).filter((r) => BAD_EMOJI_RE.test(r.emoji)).map((r) => r.id)
    );
    if (badIds.length > 0) {
      void db.messageReaction
        .deleteMany({ where: { id: { in: badIds } } })
        .catch(() => {});
    }
  }
  return cleaned;
}

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

  // Waktu server di-sample SEBELUM query (konservatif): event yang terjadi
  // selama query berjalan tetap tertangkap poll berikutnya (merge by id di
  // client membuat duplikat aman). Dipakai client sebagai patokan `since`
  // untuk sync realtime edit/hapus — bebas skew jam client.
  const serverTime = new Date().toISOString();

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

  const messages = await db.message.findMany({
    where,
    orderBy: { createdAt: "asc" },
    take: 200,
    include: messageInclude,
  });

  const hydrated = await hydrateAssignments(
    sanitizeMessages(messages).map(toDto)
  );

  return NextResponse.json({
    messages: hydrated,
    serverTime,
  });
}

// POST /api/chat/messages
// body: { kind, id, content, attachmentFileIds?, replyToId?, assignmentId? }
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
  const assignmentIdRaw = body.assignmentId;
  const assignmentId =
    typeof assignmentIdRaw === "string" && assignmentIdRaw.length > 0
      ? assignmentIdRaw
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
  // Content may be empty if there are attachments / tugas.
  if (!content && attachmentFileIds.length === 0 && !assignmentId) {
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

  // ── Validasi tugas yang dilampirkan ──────────────────────────────
  // Tugas harus berada di folder kelas tempat user adalah anggota DAN
  // foldernya terlihat oleh user (ALL/TEACHERS/PRIVATE sesuai aturan).
  if (assignmentId) {
    const assignment = await db.assignment.findUnique({
      where: { id: assignmentId },
      select: {
        id: true,
        folder: {
          select: {
            id: true,
            visibility: true,
            createdBy: true,
            classroomId: true,
            grants: { select: { userId: true } },
          },
        },
      },
    });
    if (!assignment || !assignment.folder.classroomId) {
      return NextResponse.json(
        { error: "Tugas tidak ditemukan" },
        { status: 400 }
      );
    }
    const isMember =
      (session.user as any).role === "ADMIN" ||
      (await db.classroomMember.findUnique({
        where: {
          classroomId_userId: {
            classroomId: assignment.folder.classroomId,
            userId,
          },
        },
      }));
    if (!isMember) {
      return NextResponse.json(
        { error: "Kamu bukan anggota kelas tugas ini" },
        { status: 403 }
      );
    }
    const classroomRole =
      (session.user as any).role === "ADMIN"
        ? "TEACHER"
        : await getClassroomRole(assignment.folder.classroomId, userId);
    if (
      !canViewFolder(
        {
          id: assignment.folder.id,
          visibility: assignment.folder.visibility as "ALL" | "TEACHERS" | "PRIVATE",
          createdBy: assignment.folder.createdBy,
          grants: assignment.folder.grants ?? [],
        },
        userId,
        (session.user as any).role as UserRole,
        classroomRole
      )
    ) {
      return NextResponse.json(
        { error: "Tugas tidak boleh kamu bagikan" },
        { status: 403 }
      );
    }
  }

  // ── Validasi lampiran file ───────────────────────────────────────
  // Tiga jalur sah:
  //  1. File sementara chat lama (expiresAt terisi — warisan) → milik sendiri.
  //  2. File permanen cloud di folder kelas → wajib TERLIHAT oleh user
  //     (aturan visibility folder/kelas + grants).
  //  3. File permanen TANPA folder:
  //     a. Referensi mount MEGA (storageKey mega:<accountId>:<nodeId>) →
  //        boleh bila user boleh membuka mount akun itu (Admin Panel).
  //     b. Unggahan chat permanen user lain → boleh bila pengunggahnya
  //        seanggota kelas percakapan ini (konsisten dengan Cloud Picker).
  if (attachmentFileIds.length > 0) {
    const files = await db.cloudFile.findMany({
      where: { id: { in: attachmentFileIds } },
      select: {
        id: true,
        uploadedBy: true,
        expiresAt: true,
        folderId: true,
        visibility: true,
        storageKey: true,
        grants: { select: { userId: true } },
      },
    });
    if (files.length !== attachmentFileIds.length) {
      return NextResponse.json(
        { error: "File lampiran tidak ditemukan" },
        { status: 400 }
      );
    }
    const userRole = (session.user as any).role as UserRole;
    // Cache classroom role per classroomId (hemat query).
    const roleCache = new Map<string, "TEACHER" | "STUDENT" | null>();
    const getRole = async (classroomId: string) => {
      if (roleCache.has(classroomId)) return roleCache.get(classroomId) ?? null;
      const r =
        userRole === "ADMIN"
          ? "TEACHER"
          : await getClassroomRole(classroomId, userId);
      roleCache.set(classroomId, r);
      return r;
    };
    // Kelas asal percakapan ini (classroom → diri sendiri; group → kelas
    // grupnya; dm → null) — untuk aturan file permanen milik anggota kelas.
    let convClassroomId: string | null = null;
    if (kind === "classroom") {
      convClassroomId = id;
    } else if (kind === "group") {
      const group = await db.group.findUnique({
        where: { id },
        select: { classroomId: true },
      });
      convClassroomId = group?.classroomId ?? null;
    }
    for (const f of files) {
      if (f.expiresAt) {
        // File sementara (warisan unggahan 24 jam lama) — milik sendiri saja.
        if (f.uploadedBy !== userId) {
          return NextResponse.json(
            { error: "File lampiran bukan milik Anda" },
            { status: 403 }
          );
        }
        continue;
      }
      // File permanen cloud.
      if (f.uploadedBy === userId || userRole === "ADMIN") continue;
      if (f.folderId) {
        const cid = await folderClassroomId(f.folderId);
        const classroomRole = cid ? await getRole(cid) : null;
        if (
          !cid ||
          !canViewFile(
            {
              id: f.id,
              folderId: f.folderId,
              visibility: f.visibility as "ALL" | "TEACHERS" | "PRIVATE",
              uploadedBy: f.uploadedBy,
              grants: f.grants ?? [],
            },
            userId,
            userRole,
            classroomRole
          )
        ) {
          return NextResponse.json(
            { error: "File lampiran tidak boleh kamu bagikan" },
            { status: 403 }
          );
        }
        continue;
      }
      // File permanen TANPA folder.
      const mega = parseMegaKey(f.storageKey);
      if (mega) {
        // (a) Referensi mount MEGA / file yang tersimpan di akun MEGA —
        // boleh bila mount akunnya terlihat oleh user (aturan Admin Panel).
        const account = await db.cloudAccount.findUnique({
          where: { id: mega.accountId },
          select: { mountVisibleTo: true, mountMode: true },
        });
        if (account && canViewMount(account, userRole)) continue;
        return NextResponse.json(
          { error: "File lampiran tidak boleh kamu bagikan" },
          { status: 403 }
        );
      }
      // (b) Unggahan chat permanen user lain — boleh bila pengunggahnya
      // seanggota kelas percakapan ini (persis seperti daftar Cloud Picker).
      if (convClassroomId) {
        const uploaderMember = await db.classroomMember.findUnique({
          where: {
            classroomId_userId: {
              classroomId: convClassroomId,
              userId: f.uploadedBy,
            },
          },
          select: { id: true },
        });
        if (uploaderMember) continue;
      }
      return NextResponse.json(
        { error: "File lampiran tidak boleh kamu bagikan" },
        { status: 403 }
      );
    }
  }

  const data: Prisma.MessageCreateInput = {
    content,
    sender: { connect: { id: userId } },
    assignmentId: assignmentId ?? undefined,
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

  const message = await db.message.create({
    data,
    include: messageInclude,
  });

  // ── Web Push (PWA): beri tahu anggota percakapan KECUALI pengirim ──
  // Kegagalan push TIDAK BOLEH menggagalkan respons pesan — dibatasi
  // maks 5 detik (Promise.race) lalu dibiarkan selesai di latar belakang.
  try {
    let recipientIds: string[] = [];
    if (kind === "classroom") {
      const members = await db.classroomMember.findMany({
        where: { classroomId: id },
        select: { userId: true },
      });
      recipientIds = members.map((m) => m.userId);
    } else if (kind === "group") {
      const members = await db.groupMember.findMany({
        where: { groupId: id },
        select: { userId: true },
      });
      recipientIds = members.map((m) => m.userId);
    } else {
      const dm = await db.dMConversation.findUnique({
        where: { id },
        select: { user1Id: true, user2Id: true },
      });
      recipientIds = dm ? [dm.user1Id, dm.user2Id] : [];
    }

    let pushBody = content.slice(0, 120);
    if (!pushBody) pushBody = "[Lampiran]";
    if (replyToId) pushBody = `[Balasan] ${pushBody}`.slice(0, 140);

    const pushJob = sendPushToUsers(
      recipientIds,
      {
        title: message.sender.name,
        body: pushBody,
        url: "/",
        tag: `${kind}:${id}`,
      },
      { excludeUserId: userId }
    );
    // Jangan menunda respons lebih dari 5 detik karena push.
    await Promise.race([
      pushJob.then((r) => {
        if (r.attempted > 0) {
          console.log(
            `[push] ${kind}:${id} → terkirim ${r.sent}/${r.attempted}, gagal ${r.failed}, dihapus ${r.removed}`
          );
        }
      }),
      new Promise((resolve) => setTimeout(resolve, 5000)),
    ]);
  } catch (e) {
    console.error("[push] kirim push pesan baru gagal (diabaikan):", e);
  }

  const [dto] = await hydrateAssignments([toDto(message)]);

  return NextResponse.json({ message: dto }, { status: 201 });
}
