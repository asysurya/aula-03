import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { errorResponse, folderClassroomId, getClassroomRole } from "@/lib/cloud-utils";

function parseJsonArray<T>(raw: string | null | undefined): T[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

// GET /api/cloud/assignments/[folderId]/form/attempts — review guru.
// Semua attempt + jawaban + pelanggaran anti-nyontek + kunci jawaban.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ folderId: string }> }
) {
  const user = await requireUser().catch(() => null);
  if (!user) return errorResponse("UNAUTHORIZED", 401);

  const { folderId } = await params;
  const assignment = await db.assignment.findUnique({
    where: { folderId },
    select: { id: true },
  });
  if (!assignment) return errorResponse("ASSIGNMENT_NOT_FOUND", 404);

  const classroomId = await folderClassroomId(folderId);
  if (!classroomId) return errorResponse("FOLDER_NO_CLASSROOM", 400);
  const myRole =
    user.role === "ADMIN"
      ? "TEACHER"
      : await getClassroomRole(classroomId, user.id);
  if (myRole !== "TEACHER") return errorResponse("FORBIDDEN", 403);

  const form = await db.form.findUnique({
    where: { assignmentId: assignment.id },
    include: {
      questions: {
        orderBy: { order: "asc" },
        select: {
          id: true,
          type: true,
          text: true,
          points: true,
          required: true,
          order: true,
          options: true,
          correct: true,
          imageFileId: true,
        },
      },
      attempts: {
        orderBy: { startedAt: "desc" },
        include: {
          user: { select: { id: true, name: true, username: true } },
          answers: {
            include: {
              file: {
                select: {
                  id: true,
                  name: true,
                  size: true,
                  mimetype: true,
                  storageKey: true,
                },
              },
            },
          },
        },
      },
    },
  });
  if (!form) return errorResponse("FORM_NOT_FOUND", 404);

  // Roster: all classroom students (so teacher sees who hasn't started).
  const members = await db.classroomMember.findMany({
    where: { classroomId },
    select: {
      role: true,
      user: { select: { id: true, name: true, username: true } },
    },
    orderBy: { user: { name: "asc" } },
  });

  const questions = form.questions.map((q) => ({
    id: q.id,
    type: q.type,
    text: q.text,
    points: q.points,
    required: q.required,
    order: q.order,
    options: parseJsonArray<{ id: string; label: string }>(q.options),
    correct: parseJsonArray<string>(q.correct),
    imageFileId: q.imageFileId,
  }));

  const attempts = form.attempts.map((a) => ({
    id: a.id,
    user: a.user,
    status: a.status,
    startedAt: a.startedAt,
    submittedAt: a.submittedAt,
    score: a.score,
    maxScore: a.maxScore,
    violations: parseJsonArray<{ type: string; at: string; detail?: string }>(
      a.violations
    ),
    answers: a.answers.map((ans) => ({
      id: ans.id,
      questionId: ans.questionId,
      text: ans.text,
      optionIds: parseJsonArray<string>(ans.optionIds),
      fileId: ans.fileId,
      file: ans.file,
      score: ans.score,
    })),
  }));

  const attemptByUser = new Map(attempts.map((a) => [a.user.id, a]));
  const roster = members.map((m) => ({
    user: m.user,
    role: m.role,
    hasAttempt: attemptByUser.has(m.user.id),
    status: attemptByUser.get(m.user.id)?.status ?? null,
  }));

  return Response.json({
    form: {
      id: form.id,
      timeLimitMin: form.timeLimitMin,
      showResult: form.showResult,
    },
    questions,
    attempts,
    roster,
  });
}

// POST /api/cloud/assignments/[folderId]/form/attempts — nilai manual satu jawaban.
// Body: { answerId, score } → recompute attempt total.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ folderId: string }> }
) {
  const user = await requireUser().catch(() => null);
  if (!user) return errorResponse("UNAUTHORIZED", 401);

  const { folderId } = await params;
  const assignment = await db.assignment.findUnique({
    where: { folderId },
    select: { id: true },
  });
  if (!assignment) return errorResponse("ASSIGNMENT_NOT_FOUND", 404);

  const classroomId = await folderClassroomId(folderId);
  if (!classroomId) return errorResponse("FOLDER_NO_CLASSROOM", 400);
  const myRole =
    user.role === "ADMIN"
      ? "TEACHER"
      : await getClassroomRole(classroomId, user.id);
  if (myRole !== "TEACHER") return errorResponse("FORBIDDEN", 403);

  const body = await req.json().catch(() => null);
  if (!body) return errorResponse("INVALID_BODY", 400);
  const answerId = String(body.answerId || "");
  const score = Number(body.score);
  if (!answerId) return errorResponse("ANSWER_ID_REQUIRED", 400);
  if (!Number.isFinite(score) || score < 0 || score > 1000)
    return errorResponse("SCORE_INVALID", 400);

  const form = await db.form.findUnique({
    where: { assignmentId: assignment.id },
    select: { id: true },
  });
  if (!form) return errorResponse("FORM_NOT_FOUND", 404);

  const answer = await db.formAnswer.findUnique({
    where: { id: answerId },
    include: { attempt: true },
  });
  if (!answer || answer.attempt.formId !== form.id)
    return errorResponse("ANSWER_NOT_FOUND", 404);

  await db.formAnswer.update({
    where: { id: answerId },
    data: { score: Math.round(score) },
  });

  // Recompute total from FRESH database state (avoids stale-answer races
  // when the teacher grades several answers quickly).
  const freshAnswers = await db.formAnswer.findMany({
    where: { attemptId: answer.attemptId },
    select: { score: true },
  });
  const total = freshAnswers.reduce((s, a) => s + (a.score ?? 0), 0);

  const updated = await db.formAttempt.update({
    where: { id: answer.attemptId },
    data: { score: total },
    select: { id: true, score: true, maxScore: true, status: true },
  });

  return Response.json({ ok: true, attempt: updated });
}
