import { NextRequest, NextResponse } from "next/server";
import {
  assertConversationMembership,
  computeChatSyncDelta,
  currentUserId,
  sanitizeLoadedIds,
  type ConversationKind,
} from "@/lib/chat-sync";

// POST /api/chat/messages/sync
// Realtime sync untuk pesan BARU, pesan DIUBAH (edit/reaksi), dan pesan
// DIHAPUS — fallback polling (tiap 2,5 dtk) bila SSE tidak tersedia.
//
// Body: { kind, id, since?: ISO, loadedIds?: string[] }
// Response: { new, changed, deletedIds, serverTime }

export async function POST(req: NextRequest) {
  const userId = await currentUserId();
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

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

  const ok = await assertConversationMembership(kind, id, userId);
  if (!ok) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const sinceParsed = since ? new Date(since) : null;
  const sinceDate =
    sinceParsed && !Number.isNaN(sinceParsed.getTime())
      ? sinceParsed
      : new Date(0);

  const loadedIds = sanitizeLoadedIds(loadedIdsRaw);

  const delta = await computeChatSyncDelta(kind, id, sinceDate, loadedIds);
  return NextResponse.json(delta);
}
