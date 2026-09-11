import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import {
  errorResponse,
  folderClassroomId,
  getClassroomRole,
  isClassroomMember,
} from "@/lib/cloud-utils";
import { seededShuffle } from "../../route";

function parseJsonArray<T>(raw: string | null | undefined): T[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

// POST /api/cloud/assignments/[folderId]/form/attempt/retry
// Siswa mengulang pengerjaan (guru mengizinkan via Form.maxAttempts > 1).
// Attempt lama (sudah SUBMITTED) diarsipkan ke FormAttemptArchive — lengkap
// dengan snapshot jawaban per soal (JSON) — lalu attempt baru dibuat dengan
// orderSeed baru. Nilai yang dipakai = percobaan TERAKHIR; riwayat percobaan
// sebelumnya (skor, durasi, pelanggaran, detail jawaban) tetap tersimpan di arsip.
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
  if (myRole === "TEACHER") return errorResponse("TEACHERS_CANNOT_ATTEMPT", 403);

  const form = await db.form.findUnique({
    where: { assignmentId: assignment.id },
    include: { questions: { orderBy: { order: "asc" } } },
  });
  if (!form) return errorResponse("FORM_NOT_FOUND", 404);
  if (form.questions.length === 0) return errorResponse("FORM_EMPTY", 400);

  // Deadline lock.
  if (assignment.deadline.getTime() < Date.now())
    return errorResponse("DEADLINE_PASSED", 403);

  const maxAttempts = form.maxAttempts ?? 1;
  if (maxAttempts <= 1) return errorResponse("RETRY_NOT_ALLOWED", 403);

  // Include answers + nama file supaya detail jawaban percobaan lama ikut
  // terarsip (FormAnswer akan ter-cascade saat attempt dihapus).
  const existing = await db.formAttempt.findUnique({
    where: { formId_userId: { formId: form.id, userId: user.id } },
    include: {
      answers: {
        include: { file: { select: { id: true, name: true } } },
      },
    },
  });
  if (!existing) return errorResponse("ATTEMPT_NOT_FOUND", 404);
  if (existing.status !== "SUBMITTED")
    return errorResponse("ATTEMPT_IN_PROGRESS", 409);

  const archivedCount = await db.formAttemptArchive.count({
    where: { formId: form.id, userId: user.id },
  });
  const attemptsUsed = archivedCount + 1;
  if (attemptsUsed >= maxAttempts)
    return errorResponse("RETRY_LIMIT_REACHED", 403);

  // ── Snapshot jawaban per soal (disimpan sebagai JSON string) ──
  // Bentuk tiap item: { questionId, text, optionIds, fileId, fileName, score }.
  // Diurutkan mengikuti urutan soal form; jawaban yang soalnya sudah
  // dihapus dari form tetap disimpan di belakang (tidak ada yang hilang).
  const snapshotOne = (a: {
    questionId: string;
    text: string | null;
    optionIds: string | null;
    fileId: string | null;
    file: { name: string } | null;
    score: number | null;
  }): {
    questionId: string;
    text: string | null;
    optionIds: string[];
    fileId: string | null;
    fileName: string | null;
    score: number | null;
  } => ({
    questionId: a.questionId,
    text: a.text,
    optionIds: parseJsonArray<string>(a.optionIds),
    fileId: a.fileId,
    fileName: a.file?.name ?? null,
    score: a.score,
  });
  const knownQuestionIds = new Set(form.questions.map((q) => q.id));
  const answersSnapshot = [
    ...form.questions
      .filter((q) => existing.answers.some((a) => a.questionId === q.id))
      .map(
        (q) =>
          snapshotOne(existing.answers.find((a) => a.questionId === q.id)!)
      ),
    ...existing.answers
      .filter((a) => !knownQuestionIds.has(a.questionId))
      .map(snapshotOne),
  ];

  // ── Arsipkan percobaan lama (skor + pelanggaran + detail jawaban) ──
  await db.formAttemptArchive.create({
    data: {
      formId: form.id,
      userId: user.id,
      attemptId: existing.id,
      score: existing.score,
      maxScore: existing.maxScore,
      violations: existing.violations,
      startedAt: existing.startedAt,
      submittedAt: existing.submittedAt ?? new Date(),
      answers: JSON.stringify(answersSnapshot),
    },
  });

  // Hapus attempt lama (answers ikut ter-cascade; file jawaban CloudFile
  // tetap ada — relasi SetNull, bukan delete file).
  await db.formAttempt.delete({ where: { id: existing.id } });

  // ── Buat attempt baru ──
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
      correct: null,
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
      maxAttempts,
    },
    questions: ordered,
    attemptsUsed: attemptsUsed + 1,
    maxAttempts,
  });
}
