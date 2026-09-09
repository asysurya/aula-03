import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { errorResponse, folderClassroomId, isClassroomMember } from "@/lib/cloud-utils";

function parseJsonArray<T>(raw: string | null | undefined): T[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

// POST /api/cloud/assignments/[folderId]/form/attempt/submit
// Final submit with SERVER-SIDE grading (anti-nyontek: klien tidak pernah
// tahu jawaban benar sebelum submit; penilaian hanya terjadi di server).
// PG / MULTI_PG dinilai otomatis. ESSAY / SHORT / FILE menunggu nilai manual.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ folderId: string }> }
) {
  const user = await requireUser().catch(() => null);
  if (!user) return errorResponse("UNAUTHORIZED", 401);

  const { folderId } = await params;
  const assignment = await db.assignment.findUnique({
    where: { folderId },
    select: { id: true, deadline: true },
  });
  if (!assignment) return errorResponse("ASSIGNMENT_NOT_FOUND", 404);

  const classroomId = await folderClassroomId(folderId);
  if (!classroomId) return errorResponse("FOLDER_NO_CLASSROOM", 400);
  if (user.role !== "ADMIN" && !(await isClassroomMember(classroomId, user.id)))
    return errorResponse("FORBIDDEN", 403);

  const form = await db.form.findUnique({
    where: { assignmentId: assignment.id },
    include: { questions: true },
  });
  if (!form) return errorResponse("FORM_NOT_FOUND", 404);

  const attempt = await db.formAttempt.findUnique({
    where: { formId_userId: { formId: form.id, userId: user.id } },
    include: { answers: true },
  });
  if (!attempt) return errorResponse("ATTEMPT_NOT_FOUND", 404);
  if (attempt.status !== "IN_PROGRESS")
    return errorResponse("ATTEMPT_ALREADY_SUBMITTED", 409);

  const body = await req.json().catch(() => ({}));
  const isAutoSubmit = body?.auto === true; // timer expiry / auto-submit

  // Timer enforcement: if elapsed exceeds limit + 60s grace, still accept
  // (answers were autosaved) but log TIMEOUT violation.
  const elapsedMin =
    (Date.now() - attempt.startedAt.getTime()) / 60000;
  if (form.timeLimitMin && elapsedMin > form.timeLimitMin + 1) {
    const violations = parseJsonArray<{ type: string; at: string }>(
      attempt.violations
    );
    if (!violations.some((v) => v.type === "TIMEOUT")) {
      violations.push({
        type: "TIMEOUT",
        at: new Date().toISOString(),
        detail: `Terkirim ${Math.round(elapsedMin)} menit setelah mulai (limit ${form.timeLimitMin} m)`,
      });
      await db.formAttempt.update({
        where: { id: attempt.id },
        data: { violations: JSON.stringify(violations.slice(0, 200)) },
      });
    }
  }

  // ── Server-side grading ──────────────────────────────────────────
  const answerByQ = new Map(attempt.answers.map((a) => [a.questionId, a]));
  const results: {
    questionId: string;
    auto: boolean;
    correct: boolean | null;
    correctOptionIds: string[] | null;
    earned: number | null;
  }[] = [];
  let autoScore = 0;
  const maxScore = form.questions.reduce((s, q) => s + q.points, 0);

  for (const q of form.questions) {
    const answer = answerByQ.get(q.id);
    const auto =
      (q.type === "PG" || q.type === "MULTI_PG") &&
      (q.correct != null);
    if (!auto) {
      results.push({
        questionId: q.id,
        auto: false,
        correct: null,
        correctOptionIds: null,
        earned: null, // pending manual grade (or null answer)
      });
      continue;
    }
    const correctIds = parseJsonArray<string>(q.correct);
    const selected = answer?.optionIds
      ? parseJsonArray<string>(answer.optionIds)
      : [];
    const isCorrect =
      selected.length === correctIds.length &&
      correctIds.every((c) => selected.includes(c));
    const earned = isCorrect ? q.points : 0;
    autoScore += earned;

    // Persist auto score on the answer row.
    if (answer) {
      await db.formAnswer.update({
        where: { id: answer.id },
        data: { score: earned },
      });
    }
    results.push({
      questionId: q.id,
      auto: true,
      correct: isCorrect,
      correctOptionIds: correctIds,
      earned,
    });
  }

  const manualScores = attempt.answers
    .filter((a) => a.score != null)
    .reduce((s, a) => s + (a.score ?? 0), 0);

  const totalScore = autoScore + manualScores;

  const updated = await db.formAttempt.update({
    where: { id: attempt.id },
    data: {
      status: "SUBMITTED",
      submittedAt: new Date(),
      score: totalScore,
      maxScore,
    },
  });

  return Response.json({
    ok: true,
    autoSubmitted: isAutoSubmit,
    attempt: {
      id: updated.id,
      status: updated.status,
      startedAt: updated.startedAt,
      submittedAt: updated.submittedAt,
      score: updated.score,
      maxScore: updated.maxScore,
    },
    showResult: form.showResult,
    results: form.showResult ? results : null,
  });
}
