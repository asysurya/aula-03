import { NextResponse } from "next/server";
import { requireUser } from "@/lib/session";
import { builderQuotaStatus, nextMondayJakarta } from "@/lib/builder-quota";

// ─────────────────────────────────────────────────────────────────────
// GET /api/ai/builder/session — status kuota proyek AI Builder user
// yang sedang login (TIDAK membuat sesi baru).
//
// Dipakai UI untuk badge "used/limit" dan panel terkunci saat kuota
// habis. Admin selalu unlimited (limit & remaining = null).
// ─────────────────────────────────────────────────────────────────────

export const runtime = "nodejs";

export async function GET() {
  const user = await requireUser().catch(() => null);
  if (!user) return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });

  const q = await builderQuotaStatus(user);
  return NextResponse.json(
    {
      used: q.used,
      limit: q.limit,
      remaining: q.remaining,
      unlimited: q.unlimited,
      resetAt: nextMondayJakarta().toISOString(),
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
