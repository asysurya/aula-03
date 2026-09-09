import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db } from "@/lib/db";

// Start or get a DM conversation with a peer
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = (session.user as any).id as string;
  const { peerId } = await req.json();
  if (!peerId || peerId === userId) {
    return NextResponse.json({ error: "Invalid peer" }, { status: 400 });
  }

  const peer = await db.user.findUnique({ where: { id: peerId } });
  if (!peer) return NextResponse.json({ error: "Peer not found" }, { status: 404 });

  // Normalize order so user1Id < user2Id for the unique constraint
  const [a, b] = [userId, peerId].sort();
  const dm = await db.dMConversation.upsert({
    where: { user1Id_user2Id: { user1Id: a, user2Id: b } },
    update: {},
    create: { user1Id: a, user2Id: b },
  });

  return NextResponse.json({ id: dm.id, peerId });
}
