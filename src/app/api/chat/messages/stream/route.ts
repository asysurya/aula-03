import { NextRequest } from "next/server";
import {
  assertConversationMembership,
  computeChatSyncDelta,
  currentUserId,
  getWindowMessageIds,
  type ChatSyncDelta,
  type ConversationKind,
} from "@/lib/chat-sync";

// GET /api/chat/messages/stream?kind=classroom&id=…&since=ISO
//
// Server-Sent Events — realtime "0-delay" untuk chat: server memeriksa
// delta percakapan tiap ±400 ms dan LANGSUNG mengirim event begitu ada
// pesan baru / edit / hapus / reaksi. Koneksi hidup maks ±55 detik lalu
// ditutup; EventSource browser otomatis reconnect (fallback polling tetap
// berjalan sebagai jaring pengaman).
//
// Format event: `data: {"new":[…],"changed":[…],"deletedIds":[…],"serverTime":"…"}`
// Heartbeat: komentar `: keepalive` tiap ±15 detik.

export const runtime = "nodejs";
export const maxDuration = 60;

const TICK_MS = 400;
const HEARTBEAT_MS = 15_000;
const MAX_LIFETIME_MS = 55_000; // tutup sebelum maxDuration; client auto-reconnect

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function GET(req: NextRequest) {
  const userId = await currentUserId();
  if (!userId) {
    return new Response("Unauthorized", { status: 401 });
  }

  const url = new URL(req.url);
  const kind = url.searchParams.get("kind") as ConversationKind | null;
  const id = url.searchParams.get("id");
  const sinceRaw = url.searchParams.get("since");

  if (!kind || !id) {
    return new Response("kind and id are required", { status: 400 });
  }
  if (!["classroom", "group", "dm"].includes(kind)) {
    return new Response("Invalid kind", { status: 400 });
  }

  const ok = await assertConversationMembership(kind, id, userId);
  if (!ok) {
    return new Response("Forbidden", { status: 403 });
  }

  const sinceParsed = sinceRaw ? new Date(sinceRaw) : null;
  let since =
    sinceParsed && !Number.isNaN(sinceParsed.getTime())
      ? sinceParsed
      : new Date(0);

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const onClose = () => {
        closed = true;
      };
      req.signal.addEventListener("abort", onClose);

      const send = (payload: string) => {
        controller.enqueue(encoder.encode(payload));
      };

      try {
        // Snapshot awal: id pesan window terakhir — basis deteksi hapus.
        const loaded = new Set(await getWindowMessageIds(kind, id));

        // Event hello — client tahu stream aktif + patokan serverTime.
        send(
          `data: ${JSON.stringify({
            new: [],
            changed: [],
            deletedIds: [],
            serverTime: new Date().toISOString(),
            hello: true,
          } satisfies ChatSyncDelta & { hello?: boolean })}\n\n`
        );

        const startedAt = Date.now();
        let lastBeat = Date.now();

        while (!closed && Date.now() - startedAt < MAX_LIFETIME_MS) {
          const delta = await computeChatSyncDelta(
            kind,
            id,
            since,
            Array.from(loaded).slice(-500)
          );

          if (
            delta.new.length > 0 ||
            delta.changed.length > 0 ||
            delta.deletedIds.length > 0
          ) {
            send(`data: ${JSON.stringify(delta)}\n\n`);
            // Maju hanya setelah event terkirim (konservatif, idempotent).
            since = new Date(delta.serverTime);
            for (const m of delta.new) loaded.add(m.id);
            for (const d of delta.deletedIds) loaded.delete(d);
          } else if (Date.now() - lastBeat > HEARTBEAT_MS) {
            send(`: keepalive\n\n`);
            lastBeat = Date.now();
          }

          await sleep(TICK_MS);
        }
      } catch {
        // Error tak terduga (mis. DB blip) — tutup stream; client reconnect.
      } finally {
        req.signal.removeEventListener("abort", onClose);
        try {
          controller.close();
        } catch {
          /* sudah tertutup */
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
