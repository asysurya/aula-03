import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import {
  errorResponse,
  folderClassroomId,
  getClassroomRole,
  isClassroomMember,
} from "@/lib/cloud-utils";
import { seededShuffle } from "../route";

function parseJsonArray<T>(raw: string | null | undefined): T[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

// POST /api/cloud/assignments/[folderId]/form/attempt — start attempt (student).
// Anti-nyontek: one attempt per student (DB unique), locked after deadline,
// per-attempt orderSeed for deterministic server-side shuffling.
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ folderId: string }> }
) {
  const user = await requireUser().catch(() => null);
  if (!user) return errorResponse("UNAUTHORIZED", 401);

  const { folderId } = await params;
  const folder = await db.cloudFolder.findUnique({
    where: { id: folderId },
    select: { id: true, type: true },
  });
  if (!folder || folder.type !== "ASSIGNMENT")
    return errorResponse("FOLDER_NOT_FOUND", 404);

  const assignment = await db.assignment.findUnique({
    where: { folderId },
    select: { id: true, deadline: true },
  });
  if (!assignment) return errorResponse("ASSIGNMENT_NOT_FOUND", 404);

  const classroomId = await folderClassroomId(folderId);
  if (!classroomId) return errorResponse("FOLDER_NO_CLASSROOM", 400);
  if (user.role !== "ADMIN" && !(await isClassroomMember(classroomId, user.id)))
    return errorResponse("FORBIDDEN", 403);

  const myRole =
    user.role === "ADMIN"
      ? "TEACHER"
      : await getClassroomRole(classroomId, user.id);
  if (myRole === "TEACHER")
    return errorResponse("TEACHERS_CANNOT_ATTEMPT", 403);

  const form = await db.form.findUnique({
    where: { assignmentId: assignment.id },
    include: { questions: { orderBy: { order: "asc" } } },
  });
  if (!form) return errorResponse("FORM_NOT_FOUND", 404);
  if (form.questions.length === 0) return errorResponse("FORM_EMPTY", 400);

  // Deadline lock — cannot START after deadline.
  if (assignment.deadline.getTime() < Date.now())
    return errorResponse("DEADLINE_PASSED", 403);

  // One attempt only.
  const existing = await db.formAttempt.findUnique({
    where: { formId_userId: { formId: form.id, userId: user.id } },
  });
  if (existing) return errorResponse("ATTEMPT_EXISTS", 409);

  const maxScore = form.questions.reduce((sum, q) => sum + q.points, 0);
  const orderSeed = Math.floor(Math.random() * 1_000_000) + 1;

  const attempt = await db.formAttempt.create({
    data: {
      formId: form.id,
      userId: user.id,
      orderSeed,
      maxScore,
      violations: "[]",
    },
  });

  // Build the student's question order (server-side, deterministic).
  const qs = form.questions.map((q) => {
    const options = parseJsonArray<{ id: string; label: string }>(q.options);
    const shuffledOpts = form.shuffleOptions
      ? seededShuffle(options, orderSeed + q.order * 131)
      : options;
    return {
      id: q.id,
      type: q.type,
      text: q.text,
      points: q.points,
      required: q.required,
      order: q.order,
      options: shuffledOpts,
      correct: null, // never leak to student while answering
      imageFileId: q.imageFileId,
    };
  });
  const ordered = form.shuffleQuestions
    ? seededShuffle(qs, orderSeed)
    : [...qs].sort((a, b) => a.order - b.order);

  return Response.json({
    attempt: {
      id: attempt.id,
      status: attempt.status,
      startedAt: attempt.startedAt,
      submittedAt: null,
      score: null,
      maxScore,
      violations: [],
      answers: [],
    },
    settings: {
      oneByOne: form.oneByOne,
      preventPaste: form.preventPaste,
      trackTabSwitch: form.trackTabSwitch,
      timeLimitMin: form.timeLimitMin,
      showResult: form.showResult,
      shuffleQuestions: form.shuffleQuestions,
      shuffleOptions: form.shuffleOptions,
      allowBack: form.allowBack ?? false,
    },
    questions: ordered,
  });
}

// PATCH /api/cloud/assignments/[folderId]/form/attempt — autosave answers + violations.
// Only valid while IN_PROGRESS. Answers are capped; violations appended (max 200).
export async function PATCH(
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

  const form = await db.form.findUnique({
    where: { assignmentId: assignment.id },
    select: { id: true },
  });
  if (!form) return errorResponse("FORM_NOT_FOUND", 404);

  const attempt = await db.formAttempt.findUnique({
    where: { formId_userId: { formId: form.id, userId: user.id } },
  });
  if (!attempt) return errorResponse("ATTEMPT_NOT_FOUND", 404);
  if (attempt.status !== "IN_PROGRESS")
    return errorResponse("ATTEMPT_ALREADY_SUBMITTED", 409);

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") return errorResponse("INVALID_BODY", 400);

  // Valid question ids + tipe soal (jawaban file hanya utk soal FILE/IMAGE)
  const questions = await db.formQuestion.findMany({
    where: { formId: form.id },
    select: { id: true, type: true },
  });
  const validQuestions = new Map(questions.map((q) => [q.id, q.type]));

  // Validasi fileId: HARUS file milik user sendiri (dulu: siswa bisa
  // menautkan CloudFile SIAPA PUN — termasuk file jawaban siswa lain —
  // lalu mengunduhnya lewat GET form).
  const requestedFileIds = Array.from(
    new Set(
      ((Array.isArray(body.answers) ? body.answers : []) as {
        fileId?: unknown;
      }[])
        .map((a) => (a?.fileId == null ? null : String(a.fileId)))
        .filter((x): x is string => !!x)
    )
  );
  const ownedFileIds = new Set(
    requestedFileIds.length === 0
      ? []
      : (
          await db.cloudFile.findMany({
            where: {
              id: { in: requestedFileIds },
              uploadedBy: user.id,
            },
            select: { id: true },
          })
        ).map((f) => f.id)
  );

  const answers = Array.isArray(body.answers) ? body.answers : [];
  for (const a of answers) {
    const questionId = String(a.questionId || "");
    const qType = validQuestions.get(questionId);
    if (!qType) continue;
    const text = a.text == null ? null : String(a.text).slice(0, 8000);
    const optionIds = Array.isArray(a.optionIds)
      ? a.optionIds.map(String).filter((id: string) => id.length > 0).slice(0, 20)
      : null;
    let fileId = a.fileId == null ? null : String(a.fileId);
    // File bukan milik user / soal bukan tipe unggahan → tolak file-nya.
    if (fileId && (!ownedFileIds.has(fileId) || (qType !== "FILE" && qType !== "IMAGE"))) {
      fileId = null;
    }
    await db.formAnswer.upsert({
      where: { attemptId_questionId: { attemptId: attempt.id, questionId } },
      update: { text, optionIds: optionIds ? JSON.stringify(optionIds) : null, fileId },
      create: {
        attemptId: attempt.id,
        questionId,
        text,
        optionIds: optionIds ? JSON.stringify(optionIds) : null,
        fileId,
      },
    });
  }

  // Violations log (append, dedupe exact timestamps, cap 200)
  if (Array.isArray(body.violations) && body.violations.length > 0) {
    const existingViolations = parseJsonArray<{
      type: string;
      at: string;
    }>(attempt.violations);
    const incoming = body.violations
      .filter((v: { type?: string; at?: string }) => v && v.type)
      .map((v: { type: string; at?: string }) => ({
        type: String(v.type),
        at: v.at ? String(v.at) : new Date().toISOString(),
      }))
      .slice(0, 50);
    const seen = new Set(existingViolations.map((v) => `${v.type}:${v.at}`));
    const merged = [...existingViolations];
    for (const v of incoming) {
      const key = `${v.type}:${v.at}`;
      if (!seen.has(key)) {
        seen.add(key);
        merged.push(v);
      }
    }
    await db.formAttempt.update({
      where: { id: attempt.id },
      data: { violations: JSON.stringify(merged.slice(0, 200)) },
    });
  }

  return Response.json({ ok: true, savedAt: new Date().toISOString() });
}
