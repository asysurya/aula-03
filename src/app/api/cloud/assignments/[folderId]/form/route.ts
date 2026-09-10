import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import {
  errorResponse,
  folderClassroomId,
  getClassroomRole,
  isClassroomMember,
} from "@/lib/cloud-utils";
import type { FormOption } from "@/lib/form-types";

// ── helpers ───────────────────────────────────────────────────────

function parseJsonArray<T>(raw: string | null | undefined): T[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

/** Deterministic seeded shuffle (mulberry32) — same seed ⇒ same order. */
export function seededShuffle<T>(arr: T[], seed: number): T[] {
  const a = [...arr];
  let t = seed >>> 0;
  function rand() {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  }
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function loadFormWithQuestions(assignmentId: string) {
  const form = await db.form.findUnique({
    where: { assignmentId },
    include: {
      questions: {
        orderBy: { order: "asc" },
        include: {
          imageFile: {
            select: { id: true, name: true, storageKey: true, mimetype: true },
          },
        },
      },
    },
  });
  return form;
}

function toQuestionDTO(
  q: NonNullable<
    Awaited<ReturnType<typeof loadFormWithQuestions>>
  >["questions"][number],
  includeCorrect: boolean,
  optionSeed?: number
) {
  const options: FormOption[] = parseJsonArray<FormOption>(q.options);
  const ordered =
    typeof optionSeed === "number"
      ? seededShuffle(options, optionSeed + q.order * 131)
      : options;
  return {
    id: q.id,
    type: q.type,
    text: q.text,
    points: q.points,
    required: q.required,
    order: q.order,
    options: ordered,
    correct: includeCorrect ? parseJsonArray<string>(q.correct) : null,
    imageFile: q.imageFile,
  };
}

// GET /api/cloud/assignments/[folderId]/form
// Role-aware: teachers get full form (with correct answers);
// students get questions WITHOUT correct answers, ordered per attempt seed.
export async function GET(
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

  const form = await loadFormWithQuestions(assignment.id);
  const deadlinePassed = assignment.deadline.getTime() < Date.now();

  if (!form) {
    return Response.json({
      role: myRole,
      hasForm: false,
      form: null,
      attempt: null,
      canStart: false,
      deadlinePassed,
      questionOrder: [],
    });
  }

  if (myRole === "TEACHER") {
    return Response.json({
      role: myRole,
      hasForm: true,
      form: {
        id: form.id,
        shuffleQuestions: form.shuffleQuestions,
        shuffleOptions: form.shuffleOptions,
        oneByOne: form.oneByOne,
        preventPaste: form.preventPaste,
        trackTabSwitch: form.trackTabSwitch,
        timeLimitMin: form.timeLimitMin,
        showResult: form.showResult,
        allowBack: form.allowBack ?? false,
        maxAttempts: form.maxAttempts ?? 1,
        questions: form.questions.map((q) => toQuestionDTO(q, true)),
      },
      attempt: null,
      canStart: false,
      deadlinePassed,
      questionOrder: form.questions.map((q) => q.id),
    });
  }

  // ── Student view ──
  const attempt = await db.formAttempt.findUnique({
    where: { formId_userId: { formId: form.id, userId: user.id } },
    include: {
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
  });

  if (attempt) {
    const seed = attempt.orderSeed;
    const qs = form.questions.map((q) => toQuestionDTO(q, false, seed));
    const ordered = form.shuffleQuestions
      ? seededShuffle(qs, seed)
      : [...qs].sort((a, b) => a.order - b.order);
    const showCorrect = form.showResult && attempt.status === "SUBMITTED";
    // Percobaan terpakai = arsip + attempt aktif ini.
    const archivedCount = await db.formAttemptArchive.count({
      where: { formId: form.id, userId: user.id },
    });
    const attemptsUsed = archivedCount + 1;
    const maxAttempts = form.maxAttempts ?? 1;
    const canRetry =
      attempt.status === "SUBMITTED" &&
      !deadlinePassed &&
      maxAttempts > 1 &&
      attemptsUsed < maxAttempts;
    return Response.json({
      role: myRole,
      hasForm: true,
      form: {
        id: form.id,
        shuffleQuestions: form.shuffleQuestions,
        shuffleOptions: form.shuffleOptions,
        oneByOne: form.oneByOne,
        preventPaste: form.preventPaste,
        trackTabSwitch: form.trackTabSwitch,
        timeLimitMin: form.timeLimitMin,
        showResult: form.showResult,
        allowBack: form.allowBack ?? false,
        maxAttempts,
        questions: showCorrect
          ? form.questions.map((q) => toQuestionDTO(q, true, seed))
          : ordered,
      },
      attempt: {
        id: attempt.id,
        status: attempt.status,
        startedAt: attempt.startedAt,
        submittedAt: attempt.submittedAt,
        score: attempt.score,
        maxScore: attempt.maxScore,
        violations: parseJsonArray(attempt.violations),
        answers: attempt.answers.map((a) => ({
          questionId: a.questionId,
          text: a.text,
          optionIds: parseJsonArray<string>(a.optionIds),
          fileId: a.fileId,
          file: a.file,
          score: a.score,
          feedback: a.feedback,
        })),
      },
      canStart: false,
      deadlinePassed,
      questionOrder: ordered.map((q) => q.id),
      attemptsUsed,
      canRetry,
    });
  }

  // No attempt yet — preview (order by builder order; shuffle applied at start)
  const qs = form.questions.map((q) => toQuestionDTO(q, false));
  return Response.json({
    role: myRole,
    hasForm: true,
    form: {
      id: form.id,
      shuffleQuestions: form.shuffleQuestions,
      shuffleOptions: form.shuffleOptions,
      oneByOne: form.oneByOne,
      preventPaste: form.preventPaste,
      trackTabSwitch: form.trackTabSwitch,
      timeLimitMin: form.timeLimitMin,
      showResult: form.showResult,
      allowBack: form.allowBack ?? false,
      maxAttempts: form.maxAttempts ?? 1,
      questions: [...qs].sort((a, b) => a.order - b.order),
    },
    attempt: null,
    canStart: !deadlinePassed,
    deadlinePassed,
    questionOrder: [],
    attemptsUsed: 0,
    canRetry: false,
  });
}

// PUT /api/cloud/assignments/[folderId]/form — save builder (teacher only).
// Full-replace strategy. Blocked once any student has started an attempt.
export async function PUT(
  req: NextRequest,
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
  if (!body || typeof body !== "object") return errorResponse("INVALID_BODY", 400);

  const settings = body.settings ?? {};
  const questions = Array.isArray(body.questions) ? body.questions : [];

  if (questions.length === 0) return errorResponse("QUESTIONS_REQUIRED", 400);
  if (questions.length > 100) return errorResponse("TOO_MANY_QUESTIONS", 400);

  // Validate each question
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const type = String(q.type || "");
    if (!["PG", "MULTI_PG", "ESSAY", "SHORT", "FILE", "IMAGE"].includes(type))
      return errorResponse(`Q${i + 1}: jenis soal tidak valid`, 400);
    const text = String(q.text || "").trim();
    if (!text) return errorResponse(`Q${i + 1}: teks soal wajib diisi`, 400);
    if (text.length > 2000)
      return errorResponse(`Q${i + 1}: teks soal terlalu panjang`, 400);
    const points = Number(q.points ?? 1);
    if (!Number.isFinite(points) || points < 0 || points > 1000)
      return errorResponse(`Q${i + 1}: poin tidak valid`, 400);

    if (type === "PG" || type === "MULTI_PG") {
      const opts = Array.isArray(q.options) ? q.options : [];
      if (opts.length < 2)
        return errorResponse(`Q${i + 1}: minimal 2 opsi jawaban`, 400);
      if (opts.length > 10)
        return errorResponse(`Q${i + 1}: maksimal 10 opsi`, 400);
      const labels = opts.map((o: { label?: string }) =>
        String(o.label || "").trim()
      );
      if (labels.some((l: string) => !l))
        return errorResponse(`Q${i + 1}: label opsi wajib diisi`, 400);
      const correct = Array.isArray(q.correct) ? q.correct : [];
      if (type === "PG" && correct.length !== 1)
        return errorResponse(
          `Q${i + 1}: PG harus menandai tepat 1 jawaban benar`,
          400
        );
      if (type === "MULTI_PG" && correct.length < 1)
        return errorResponse(
          `Q${i + 1}: PG multi harus menandai minimal 1 jawaban benar`,
          400
        );
      const optIds = new Set(opts.map((o: { id?: string }) => String(o.id)));
      if (correct.some((c: string) => !optIds.has(String(c))))
        return errorResponse(
          `Q${i + 1}: jawaban benar harus salah satu opsi`,
          400
        );
    }
  }

  // Block edits once attempts exist (anti-cheat integrity).
  const existing = await db.form.findUnique({
    where: { assignmentId: assignment.id },
    select: { id: true },
  });
  if (existing) {
    const attemptCount = await db.formAttempt.count({
      where: { formId: existing.id },
    });
    if (attemptCount > 0) return errorResponse("FORM_LOCKED_ATTEMPTS", 409);
  }

  const timeLimit =
    settings.timeLimitMin == null ? null : Number(settings.timeLimitMin);
  if (
    timeLimit != null &&
    (!Number.isFinite(timeLimit) || timeLimit < 1 || timeLimit > 300)
  )
    return errorResponse("TIME_LIMIT_INVALID", 400);

  const maxAttemptsRaw =
    settings.maxAttempts == null ? 1 : Number(settings.maxAttempts);
  if (
    !Number.isFinite(maxAttemptsRaw) ||
    maxAttemptsRaw < 1 ||
    maxAttemptsRaw > 10
  )
    return errorResponse("MAX_ATTEMPTS_INVALID (1–10)", 400);
  const maxAttempts = Math.round(maxAttemptsRaw);

  const data = {
    shuffleQuestions: !!settings.shuffleQuestions,
    shuffleOptions: !!settings.shuffleOptions,
    oneByOne: !!settings.oneByOne,
    preventPaste: !!settings.preventPaste,
    trackTabSwitch: !!settings.trackTabSwitch,
    timeLimitMin: timeLimit == null ? null : Math.round(timeLimit),
    showResult: settings.showResult !== false,
    allowBack: !!settings.allowBack,
    maxAttempts,
    createdBy: user.id,
  };

  // Upsert form + replace questions
  const form = existing
    ? await db.form.update({ where: { id: existing.id }, data })
    : await db.form.create({
        data: { ...data, assignmentId: assignment.id },
      });

  // Full-replace questions
  await db.formQuestion.deleteMany({ where: { formId: form.id } });
  await db.formQuestion.createMany({
    data: questions.map((q: Record<string, unknown>, i: number) => ({
      formId: form.id,
      type: String(q.type),
      text: String(q.text).trim(),
      points: Math.round(Number(q.points ?? 1)),
      required: q.required !== false,
      order: i,
      options: JSON.stringify(
        (Array.isArray(q.options) ? q.options : []).map(
          (o: { id?: string; label?: string }) => ({
            id: String(o.id ?? ""),
            label: String(o.label ?? ""),
          })
        )
      ),
      correct:
        q.type === "PG" || q.type === "MULTI_PG"
          ? JSON.stringify((Array.isArray(q.correct) ? q.correct : []).map(String))
          : null,
      imageFileId: q.imageFileId ? String(q.imageFileId) : null,
    })),
  });

  return Response.json({ ok: true, formId: form.id });
}
