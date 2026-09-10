import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { errorResponse } from "@/lib/cloud-utils";

// ── Papan skor Kuis Kilat (arcade) ───────────────────────────────────
// GET  /api/forms/quickquiz-score → Top 20 skor global + rekor pribadi.
// POST /api/forms/quickquiz-score → simpan hasil main { score, correct,
//                                    total, bestStreak } (validasi masuk
//                                    akal; skor maks dibatasi).
export async function GET() {
  const user = await requireUser().catch(() => null);
  if (!user) return errorResponse("UNAUTHORIZED", 401);

  const top = await db.quickQuizScore.findMany({
    orderBy: [{ score: "desc" }, { createdAt: "desc" }],
    take: 20,
  });

  const mine = await db.quickQuizScore.findFirst({
    where: { userId: user.id },
    orderBy: { score: "desc" },
  });

  return Response.json({
    top: top.map((r, i) => ({
      rank: i + 1,
      userName: r.userName,
      score: r.score,
      correct: r.correct,
      total: r.total,
      accuracy:
        r.total > 0 ? Math.round((r.correct / r.total) * 100) : 0,
      bestStreak: r.bestStreak,
      createdAt: new Date(r.createdAt).toISOString(),
      mine: r.userId === user.id,
    })),
    myBest: mine
      ? {
          score: mine.score,
          correct: mine.correct,
          total: mine.total,
          bestStreak: mine.bestStreak,
        }
      : null,
  });
}

export async function POST(req: NextRequest) {
  const user = await requireUser().catch(() => null);
  if (!user) return errorResponse("UNAUTHORIZED", 401);

  const body = await req.json().catch(() => null);
  if (!body) return errorResponse("INVALID_JSON", 400);

  const score = Math.max(0, Math.min(5000, Math.floor(Number(body.score) || 0)));
  const total = Math.max(0, Math.min(200, Math.floor(Number(body.total) || 0)));
  const correct = Math.max(0, Math.min(total, Math.floor(Number(body.correct) || 0)));
  const bestStreak = Math.max(0, Math.min(200, Math.floor(Number(body.bestStreak) || 0)));

  if (total === 0) return errorResponse("TOTAL_REQUIRED", 400);
  // Skor wajar: benar maks 40 poin (10 + combo 2×streak panjang) + toleransi.
  if (score > total * 60) return errorResponse("SCORE_TOO_HIGH", 400);

  await db.quickQuizScore.create({
    data: {
      userId: user.id,
      userName: user.name,
      score,
      correct,
      total,
      bestStreak,
    },
  });

  return Response.json({ ok: true }, { status: 201 });
}
