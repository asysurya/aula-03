import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { errorResponse, isClassroomMember } from "@/lib/cloud-utils";

// GET /api/cloud/classrooms/[id]/leaderboard
// Papan peringkat kelas — total poin tugas form yang sudah dikumpulkan.
// Terlihat semua anggota kelas (motivasi belajar). Poin = jumlah skor
// attempt TERAKHIR tiap tugas (percobaan lama sudah diarsipkan).
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await requireUser().catch(() => null);
  if (!user) return errorResponse("UNAUTHORIZED", 401);

  const { id } = await params;

  if (user.role !== "ADMIN" && !(await isClassroomMember(id, user.id))) {
    return errorResponse("FORBIDDEN", 403);
  }

  // Semua tugas form di kelas ini.
  const forms = await db.form.findMany({
    where: {
      assignment: {
        folder: { classroomId: id },
      },
    },
    select: { id: true },
  });
  const formIds = forms.map((f) => f.id);

  if (formIds.length === 0) {
    return Response.json({ leaderboard: [], totalForms: 0 });
  }

  // Attempt terkumpul (FormAttempt = attempt TERAKHIR per user per form).
  const attempts = await db.formAttempt.findMany({
    where: { formId: { in: formIds }, status: "SUBMITTED" },
    select: {
      userId: true,
      score: true,
      maxScore: true,
      user: {
        select: { id: true, name: true, username: true, avatarUrl: true, avatarColor: true },
      },
    },
  });

  type Row = {
    userId: string;
    name: string;
    username: string;
    avatarUrl: string | null;
    avatarColor: string;
    totalScore: number;
    totalMax: number;
    completed: number;
  };
  const map = new Map<string, Row>();
  for (const a of attempts) {
    const cur =
      map.get(a.userId) ??
      ({
        userId: a.userId,
        name: a.user.name,
        username: a.user.username,
        avatarUrl: a.user.avatarUrl,
        avatarColor: a.user.avatarColor,
        totalScore: 0,
        totalMax: 0,
        completed: 0,
      } as Row);
    cur.totalScore += a.score ?? 0;
    cur.totalMax += a.maxScore;
    cur.completed += 1;
    map.set(a.userId, cur);
  }

  const leaderboard = Array.from(map.values())
    .sort(
      (x, y) =>
        y.totalScore - x.totalScore ||
        y.completed - x.completed ||
        x.name.localeCompare(y.name)
    )
    .slice(0, 50)
    .map((r, i) => ({ ...r, rank: i + 1 }));

  return Response.json({ leaderboard, totalForms: formIds.length });
}
