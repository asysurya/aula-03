import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import {
  assertConversationMembership,
  currentUserId,
  type ConversationKind,
} from "@/lib/chat-sync";
import { requireUser } from "@/lib/session";

// ── Indikator "sedang menulis…" ─────────────────────────────────────
// POST /api/chat/typing  body: { kind, id }
//   → Upsert TypingState (userId + nama) untuk percakapan ini. Di-throttle
//     client (maks 1 kali per ~2,5 dtk). Baris > 60 dtk dibersihkan oportunis.
// GET  /api/chat/typing?kind=group&id=abc
//   → Nama user yang sedang menulis (≤ 5 dtk terakhir), tanpa diri sendiri.

const KEY_PREFIX_OK: ConversationKind[] = ["classroom", "group", "dm"];
const TYPING_WINDOW_MS = 5_000;
const CLEANUP_OLDER_MS = 60_000;

export async function POST(req: NextRequest) {
  const user = await requireUser().catch(() => null);
  if (!user) return Response.json({ error: "UNAUTHORIZED" }, { status: 401 });

  const body = await req.json().catch(() => null);
  if (!body) return Response.json({ error: "INVALID_JSON" }, { status: 400 });

  const kind = body.kind as ConversationKind | undefined;
  const id = typeof body.id === "string" ? body.id : "";
  if (!kind || !id || !KEY_PREFIX_OK.includes(kind)) {
    return Response.json({ error: "INVALID_KIND" }, { status: 400 });
  }

  const ok = await assertConversationMembership(kind, id, user.id);
  if (!ok) return Response.json({ error: "FORBIDDEN" }, { status: 403 });

  const conversationKey = `${kind}:${id}`;

  // Upsert manual (bukan prisma.upsert) — aman untuk koleksi baru tanpa
  // migrasi index di DB produksi.
  const existing = await db.typingState.findFirst({
    where: { conversationKey, userId: user.id },
    select: { id: true },
  });
  const now = new Date();
  if (existing) {
    await db.typingState.update({
      where: { id: existing.id },
      data: { updatedAt: now, userName: user.name },
    });
  } else {
    await db.typingState.create({
      data: {
        conversationKey,
        userId: user.id,
        userName: user.name,
        updatedAt: now,
      },
    });
  }

  // Bersihkan baris basi (fire-and-forget).
  void db.typingState
    .deleteMany({
      where: { updatedAt: { lt: new Date(Date.now() - CLEANUP_OLDER_MS) } },
    })
    .catch(() => {});

  return Response.json({ ok: true });
}

export async function GET(req: NextRequest) {
  const userId = await currentUserId();
  if (!userId) return Response.json({ error: "UNAUTHORIZED" }, { status: 401 });

  const url = new URL(req.url);
  const kind = url.searchParams.get("kind") as ConversationKind | null;
  const id = url.searchParams.get("id");
  if (!kind || !id || !KEY_PREFIX_OK.includes(kind)) {
    return Response.json({ error: "INVALID_KIND" }, { status: 400 });
  }

  const ok = await assertConversationMembership(kind, id, userId);
  if (!ok) return Response.json({ error: "FORBIDDEN" }, { status: 403 });

  const rows = await db.typingState.findMany({
    where: {
      conversationKey: `${kind}:${id}`,
      updatedAt: { gt: new Date(Date.now() - TYPING_WINDOW_MS) },
      userId: { not: userId },
    },
    select: { userName: true },
    take: 10,
  });

  return Response.json({
    typing: Array.from(new Set(rows.map((r) => r.userName))),
  });
}
