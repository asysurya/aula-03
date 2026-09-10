import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { errorResponse, folderClassroomId, getClassroomRole } from "@/lib/cloud-utils";

// POST /api/cloud/assignments/[folderId]/form/feedback
// Umpan balik tertulis guru per jawaban siswa.
// Body: { answerId, feedback: string } (maks 1000 karakter, "" = hapus).
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
  const feedback =
    typeof body.feedback === "string" ? body.feedback.trim().slice(0, 1000) : null;
  if (!answerId) return errorResponse("ANSWER_ID_REQUIRED", 400);

  const form = await db.form.findUnique({
    where: { assignmentId: assignment.id },
    select: { id: true },
  });
  if (!form) return errorResponse("FORM_NOT_FOUND", 404);

  const answer = await db.formAnswer.findUnique({
    where: { id: answerId },
    select: { id: true, attempt: { select: { formId: true } } },
  });
  if (!answer || answer.attempt.formId !== form.id)
    return errorResponse("ANSWER_NOT_FOUND", 404);

  await db.formAnswer.update({
    where: { id: answerId },
    data: { feedback: feedback && feedback.length > 0 ? feedback : null },
  });

  return Response.json({ ok: true, feedback: feedback || null });
}
