import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { errorResponse, folderClassroomId, isClassroomMember } from "@/lib/cloud-utils";
import { ALLOWED_MIMES, MAX_FILE_SIZE, saveFile } from "@/lib/storage";

// POST /api/cloud/assignments/[folderId]/form/answer-file — upload jawaban
// FILE/IMAGE selama pengerjaan form. File disimpan via storage layer (MEGA).
// CloudFile dibuat dengan folderId=null & visibility=PRIVATE agar tidak
// muncul di file browser kelas.
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
  if (user.role !== "ADMIN" && !(await isClassroomMember(classroomId, user.id)))
    return errorResponse("FORBIDDEN", 403);

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

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return errorResponse("INVALID_FORMDATA", 400);
  }

  const questionId = String(formData.get("questionId") || "");
  const file = formData.get("file");
  if (!questionId) return errorResponse("QUESTION_ID_REQUIRED", 400);
  if (!(file instanceof File)) return errorResponse("FILE_REQUIRED", 400);
  if (file.size === 0) return errorResponse("FILE_EMPTY", 400);
  if (file.size > MAX_FILE_SIZE) return errorResponse("FILE_TOO_LARGE", 413);

  const mimetype = file.type || "application/octet-stream";
  if (!ALLOWED_MIMES.has(mimetype)) return errorResponse("MIME_NOT_ALLOWED", 415);

  // Question must exist, be an upload type, and belong to this form.
  const question = await db.formQuestion.findFirst({
    where: { id: questionId, formId: form.id },
    select: { id: true, type: true },
  });
  if (!question) return errorResponse("QUESTION_NOT_FOUND", 404);
  if (question.type !== "FILE" && question.type !== "IMAGE")
    return errorResponse("QUESTION_NOT_UPLOAD_TYPE", 400);
  if (question.type === "IMAGE" && !mimetype.startsWith("image/"))
    return errorResponse("IMAGE_REQUIRED", 400);

  const bytes = Buffer.from(await file.arrayBuffer());
  const saved = await saveFile(file.name, mimetype, bytes).catch((e) => {
    console.error("[form answer-file] saveFile failed:", e);
    return null;
  });
  if (!saved) return errorResponse("UPLOAD_FAILED", 500);

  const cloudFile = await db.cloudFile.create({
    data: {
      name: file.name,
      folderId: null,
      uploadedBy: user.id,
      storageKey: saved.storageKey,
      size: saved.size,
      mimetype,
      visibility: "PRIVATE",
      cloudAccountId: saved.cloudAccountId ?? null,
    },
    select: {
      id: true,
      name: true,
      size: true,
      mimetype: true,
      storageKey: true,
    },
  });

  return Response.json({ file: cloudFile });
}
