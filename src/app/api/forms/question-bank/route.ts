import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { errorResponse } from "@/lib/cloud-utils";

// ── Bank soal pribadi guru ───────────────────────────────────────────
// GET  /api/forms/question-bank          → daftar soal tersimpan (terbaru)
// POST /api/forms/question-bank          → simpan soal { type, text, options,
//                                           correct, points }
// Hanya GURU / ADMIN. Koleksi baru — aman tanpa migrasi.

const VALID_TYPES = ["PG", "MULTI_PG", "ESSAY", "SHORT", "FILE", "IMAGE"];

export async function GET() {
  const user = await requireUser().catch(() => null);
  if (!user) return errorResponse("UNAUTHORIZED", 401);
  if (user.role === "STUDENT") return errorResponse("FORBIDDEN", 403);

  const rows = await db.questionBank.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: "desc" },
    take: 200,
  });

  return Response.json({
    questions: rows.map((r) => ({
      id: r.id,
      type: r.type,
      text: r.text,
      points: r.points,
      options: safeParse(r.options),
      correct: r.correct ? safeParse(r.correct) : null,
      createdAt: new Date(r.createdAt).toISOString(),
    })),
  });
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return [];
  }
}

export async function POST(req: NextRequest) {
  const user = await requireUser().catch(() => null);
  if (!user) return errorResponse("UNAUTHORIZED", 401);
  if (user.role === "STUDENT") return errorResponse("FORBIDDEN", 403);

  const body = await req.json().catch(() => null);
  if (!body) return errorResponse("INVALID_JSON", 400);

  const type = typeof body.type === "string" ? body.type : "";
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!VALID_TYPES.includes(type)) return errorResponse("INVALID_TYPE", 400);
  if (!text) return errorResponse("TEXT_REQUIRED", 400);
  if (text.length > 2000) return errorResponse("TEXT_TOO_LONG", 400);

  const pointsRaw = Number(body.points);
  const points =
    Number.isFinite(pointsRaw) && pointsRaw >= 1 && pointsRaw <= 100
      ? Math.floor(pointsRaw)
      : 1;

  // Validasi bentuk options/correct (array sederhana).
  const options = Array.isArray(body.options)
    ? body.options
        .filter(
          (o: unknown): o is { id: string; label: string } =>
            !!o &&
            typeof o === "object" &&
            typeof (o as { id?: unknown }).id === "string" &&
            typeof (o as { label?: unknown }).label === "string"
        )
        .slice(0, 10)
        .map((o) => ({ id: o.id, label: o.label.slice(0, 500) }))
    : [];
  const correct = Array.isArray(body.correct)
    ? body.correct
        .filter((c: unknown): c is string => typeof c === "string")
        .slice(0, 10)
    : [];

  const row = await db.questionBank.create({
    data: {
      userId: user.id,
      type,
      text,
      points,
      options: JSON.stringify(options),
      correct: JSON.stringify(correct),
    },
  });

  return Response.json(
    {
      question: {
        id: row.id,
        type: row.type,
        text: row.text,
        points: row.points,
        options,
        correct,
        createdAt: new Date(row.createdAt).toISOString(),
      },
    },
    { status: 201 }
  );
}
