import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import {
  assertConversationMembership,
  currentUserId,
  type ConversationKind,
} from "@/lib/chat-sync";

// GET /api/chat/messages/pinned?kind=group&id=abc
// Daftar pesan yang disematkan (pin) pada percakapan — tidak dibatasi
// jendela 200 pesan terakhir (pin bisa jauh lebih tua). Maks 50, urut
// terbaru disematkan.
export async function GET(req: NextRequest) {
  const userId = await currentUserId();
  if (!userId) return Response.json({ error: "UNAUTHORIZED" }, { status: 401 });

  const url = new URL(req.url);
  const kind = url.searchParams.get("kind") as ConversationKind | null;
  const id = url.searchParams.get("id");
  if (!kind || !id || !["classroom", "group", "dm"].includes(kind)) {
    return Response.json({ error: "INVALID_KIND" }, { status: 400 });
  }

  const ok = await assertConversationMembership(kind, id, userId);
  if (!ok) return Response.json({ error: "FORBIDDEN" }, { status: 403 });

  const where: Record<string, unknown> = { pinnedAt: { not: null } };
  if (kind === "classroom") where.classroomId = id;
  else if (kind === "group") where.groupId = id;
  else where.dmId = id;

  const rows = await db.message.findMany({
    where,
    orderBy: { pinnedAt: "desc" },
    take: 50,
    select: {
      id: true,
      content: true,
      createdAt: true,
      pinnedAt: true,
      sender: { select: { id: true, name: true, username: true } },
    },
  });

  return Response.json({
    pinned: rows.map((r) => ({
      id: r.id,
      content: r.content,
      createdAt: new Date(r.createdAt).toISOString(),
      pinnedAt: new Date(r.pinnedAt as Date).toISOString(),
      sender: r.sender,
    })),
  });
}
