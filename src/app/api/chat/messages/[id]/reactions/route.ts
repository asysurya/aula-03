import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db } from "@/lib/db";

type ConversationKind = "classroom" | "group" | "dm";

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

// POST /api/chat/messages/[id]/reactions  body: { emoji: string }
// Toggles reaction (messageId, userId, emoji).
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = (session.user as any).id as string;
  const { id: messageId } = await params;

  const body = await req.json().catch(() => null);
  if (!body) {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }
  const emoji =
    typeof body.emoji === "string" ? body.emoji.trim() : "";
  if (!emoji) {
    return NextResponse.json(
      { error: "Emoji diperlukan" },
      { status: 400 }
    );
  }
  // Cap emoji length to a reasonable single-grapheme size (covers most ZWJ sequences).
  if (emoji.length > 32) {
    return NextResponse.json(
      { error: "Emoji tidak valid" },
      { status: 400 }
    );
  }
  // Tolak string yang jelas bukan emoji (ID/cuid/storageKey — sisa bug klien
  // lama yang mengirim ID pesan sebagai emoji).
  if (/^[A-Za-z0-9:_\-]+$/.test(emoji)) {
    return NextResponse.json(
      { error: "Emoji tidak valid" },
      { status: 400 }
    );
  }

  const message = await db.message.findUnique({
    where: { id: messageId },
    select: {
      id: true,
      classroomId: true,
      groupId: true,
      dmId: true,
    },
  });
  if (!message) {
    return NextResponse.json(
      { error: "Pesan tidak ditemukan" },
      { status: 404 }
    );
  }

  // Verify membership of the message's conversation.
  const convId =
    message.classroomId ?? message.groupId ?? message.dmId ?? null;
  if (!convId) {
    return NextResponse.json(
      { error: "Pesan tidak memiliki percakapan" },
      { status: 400 }
    );
  }
  const kind: ConversationKind = message.classroomId
    ? "classroom"
    : message.groupId
      ? "group"
      : "dm";
  const ok = await assertMembership(kind, convId, userId);
  if (!ok) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Toggle via findFirst + delete/create on the unique trio.
  const existing = await db.messageReaction.findFirst({
    where: { messageId, userId, emoji },
    select: { id: true },
  });
  if (existing) {
    await db.messageReaction.delete({ where: { id: existing.id } });
    return NextResponse.json({ reacted: false, emoji });
  }

  await db.messageReaction.create({
    data: { messageId, userId, emoji },
  });
  return NextResponse.json({ reacted: true, emoji });
}
