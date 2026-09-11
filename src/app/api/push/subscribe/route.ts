import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { db } from "@/lib/db";
import { getVapidPublicKey } from "@/lib/web-push";

// ─────────────────────────────────────────────────────────────────────────
// /api/push/subscribe — manajemen langganan Web Push (PWA) per user.
//   GET    → { publicKey }  — kunci publik VAPID (auto-generate bila kosong)
//   POST   → daftarkan/perbarui langganan perangkat ini (upsert by endpoint)
//   DELETE → hapus langganan (hanya milik user sesi login)
// Semua route butuh sesi login (pola sama dengan route API lain).
// ─────────────────────────────────────────────────────────────────────────

export const runtime = "nodejs";

const MAX_ENDPOINT_LEN = 2048;
const MAX_KEY_LEN = 256;

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const publicKey = await getVapidPublicKey();
  if (!publicKey) {
    return NextResponse.json(
      { error: "Gagal menyiapkan kunci push" },
      { status: 500 }
    );
  }
  return NextResponse.json({ publicKey });
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = (session.user as { id?: string }).id;
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  if (!body) {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  const endpoint = typeof body.endpoint === "string" ? body.endpoint.trim() : "";
  const keys = body.keys as { p256dh?: unknown; auth?: unknown } | undefined;
  const p256dh = typeof keys?.p256dh === "string" ? keys.p256dh.trim() : "";
  const auth = typeof keys?.auth === "string" ? keys.auth.trim() : "";

  if (
    !endpoint ||
    !p256dh ||
    !auth ||
    !/^https?:\/\//.test(endpoint) ||
    endpoint.length > MAX_ENDPOINT_LEN ||
    p256dh.length > MAX_KEY_LEN ||
    auth.length > MAX_KEY_LEN
  ) {
    return NextResponse.json(
      { error: "endpoint, keys.p256dh, keys.auth wajib valid" },
      { status: 400 }
    );
  }

  const agent =
    typeof req.headers.get("user-agent") === "string"
      ? (req.headers.get("user-agent") as string).slice(0, 200)
      : null;

  try {
    const saved = await db.pushSubscription.upsert({
      where: { endpoint },
      update: { userId, p256dh, auth, agent },
      create: { userId, endpoint, p256dh, auth, agent },
    });
    return NextResponse.json({ ok: true, id: saved.id });
  } catch (e) {
    console.error("[push] upsert subscription gagal:", e);
    return NextResponse.json(
      { error: "Gagal menyimpan langganan" },
      { status: 500 }
    );
  }
}

export async function DELETE(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = (session.user as { id?: string }).id;
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  const endpoint =
    body && typeof body.endpoint === "string" ? body.endpoint.trim() : "";
  if (!endpoint) {
    return NextResponse.json(
      { error: "endpoint wajib diisi" },
      { status: 400 }
    );
  }

  try {
    // deleteMany dengan filter userId → hanya boleh menghapus milik sendiri.
    const res = await db.pushSubscription.deleteMany({
      where: { endpoint, userId },
    });
    return NextResponse.json({ ok: true, deleted: res.count });
  } catch (e) {
    console.error("[push] hapus subscription gagal:", e);
    return NextResponse.json(
      { error: "Gagal menghapus langganan" },
      { status: 500 }
    );
  }
}
