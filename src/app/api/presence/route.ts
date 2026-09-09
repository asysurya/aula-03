import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db } from "@/lib/db";
import { pingPresence, setOffline, getOnlineUserIds } from "@/lib/presence";

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const userId = (session.user as any).id as string;
  const body = await req.json().catch(() => ({}));
  if (body.offline) {
    await setOffline(userId);
  } else {
    await pingPresence(userId);
  }
  return NextResponse.json({ ok: true });
}

// Get list of currently online users
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const ids = await getOnlineUserIds();
  return NextResponse.json({ online: Array.from(ids) });
}
