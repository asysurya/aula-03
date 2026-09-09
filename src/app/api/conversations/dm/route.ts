import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db } from "@/lib/db";

// List the current user's DM conversations with the other participant + last message preview
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = (session.user as any).id as string;

  const dms = await db.dMConversation.findMany({
    where: { OR: [{ user1Id: userId }, { user2Id: userId }] },
    include: {
      user1: {
        select: {
          id: true,
          name: true,
          username: true,
          avatarUrl: true,
          avatarColor: true,
          status: true,
          lastSeen: true,
        },
      },
      user2: {
        select: {
          id: true,
          name: true,
          username: true,
          avatarUrl: true,
          avatarColor: true,
          status: true,
          lastSeen: true,
        },
      },
      messages: {
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { id: true, content: true, createdAt: true, senderId: true },
      },
    },
    orderBy: { messages: { _count: "desc" } },
  });

  const result = dms
    .map((d) => {
      const peer = d.user1Id === userId ? d.user2 : d.user1;
      const last = d.messages[0];
      return {
        id: d.id,
        peer,
        lastMessage: last
          ? {
              id: last.id,
              content: last.content,
              createdAt: last.createdAt,
              senderId: last.senderId,
            }
          : null,
      };
    })
    .sort((a, b) => {
      const at = a.lastMessage ? new Date(a.lastMessage.createdAt).getTime() : 0;
      const bt = b.lastMessage ? new Date(b.lastMessage.createdAt).getTime() : 0;
      return bt - at;
    });

  return NextResponse.json({ conversations: result });
}
