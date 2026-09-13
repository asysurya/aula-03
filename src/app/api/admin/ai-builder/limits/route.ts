import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/session";
import { db } from "@/lib/db";
import {
  LIMITS_SETTING_KEY,
  LIMIT_MAX,
  mondayKeyJakarta,
  readGlobalLimit,
} from "@/lib/builder-quota";

// ─────────────────────────────────────────────────────────────────────
// GET  /api/admin/ai-builder/limits — batas proyek AI Builder mingguan:
//        batas global (null = default 5) + daftar SEMUA user lengkap
//        dengan batas khusus (null = ikut global) dan pemakaian minggu ini.
// PUT  /api/admin/ai-builder/limits — dua bentuk body (satu per request):
//        { weeklyLimit: number|null }                      → batas global
//        { userLimit: { userId, limit: number|null } }      → batas khusus
//        (null = kembali ke default / ikut global; admin selalu bebas)
// Hanya ADMIN — non-admin 403, userId tak dikenal 400.
// ─────────────────────────────────────────────────────────────────────

export const runtime = "nodejs";

const putSchema = z.union([
  z.object({
    weeklyLimit: z.number().int().min(0).max(LIMIT_MAX).nullable(),
  }),
  z.object({
    userLimit: z.object({
      userId: z.string().trim().min(1).max(64),
      limit: z.number().int().min(0).max(LIMIT_MAX).nullable(),
    }),
  }),
]);

async function requireAdmin(): Promise<{ id: string } | null> {
  const user = await requireUser().catch(() => null);
  if (!user || user.role !== "ADMIN") return null;
  return user;
}

export async function GET() {
  if (!(await requireAdmin())) {
    return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });
  }

  const weekKey = mondayKeyJakarta();
  const [globalLimit, users, grouped] = await Promise.all([
    readGlobalLimit(),
    db.user.findMany({
      select: {
        id: true,
        username: true,
        name: true,
        role: true,
        builderWeeklyLimit: true,
      },
      orderBy: [{ role: "desc" }, { username: "asc" }],
    }),
    db.builderSession.groupBy({
      by: ["userId"],
      where: { weekKey },
      _count: { _all: true },
    }),
  ]);
  const usedMap = new Map(grouped.map((g) => [g.userId, g._count._all]));

  return NextResponse.json(
    {
      weeklyLimit: globalLimit,
      users: users.map((u) => ({
        id: u.id,
        username: u.username,
        name: u.name,
        role: u.role,
        // null = ikut batas global (admin tetap bebas walau ada nilai)
        limit: u.role === "ADMIN" ? null : (u.builderWeeklyLimit ?? null),
        used: usedMap.get(u.id) ?? 0,
      })),
      resetAt: null, // dihitung klien dari weekKey bila perlu
      weekKey,
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}

export async function PUT(req: NextRequest) {
  if (!(await requireAdmin())) {
    return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Data tidak valid" }, { status: 400 });
  }
  const parsed = putSchema.safeParse(body);
  if (!parsed.success) {
    const first = parsed.error.issues[0]?.message ?? "Data tidak valid";
    return NextResponse.json({ error: first }, { status: 400 });
  }

  if ("weeklyLimit" in parsed.data) {
    const v = parsed.data.weeklyLimit;
    if (v === null) {
      await db.appSetting.deleteMany({ where: { key: LIMITS_SETTING_KEY } });
    } else {
      await db.appSetting.upsert({
        where: { key: LIMITS_SETTING_KEY },
        create: { key: LIMITS_SETTING_KEY, value: JSON.stringify({ weeklyLimit: v }) },
        update: { value: JSON.stringify({ weeklyLimit: v }) },
      });
    }
    return NextResponse.json({ ok: true, weeklyLimit: v });
  }

  // userLimit
  const { userId, limit } = parsed.data.userLimit;
  const target = await db.user.findUnique({
    where: { id: userId },
    select: { id: true, role: true },
  });
  if (!target) {
    return NextResponse.json(
      { error: "USER_NOT_FOUND" },
      { status: 400 }
    );
  }
  await db.user.update({
    where: { id: userId },
    data: { builderWeeklyLimit: limit },
  });
  return NextResponse.json({ ok: true, userId, limit });
}
