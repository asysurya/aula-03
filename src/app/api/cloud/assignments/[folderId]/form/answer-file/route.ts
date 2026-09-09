import { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import { errorResponse } from "@/lib/cloud-utils";
import { uploadAnswerFileAction, type UploadBytes } from "@/lib/upload-actions";

// POST /api/cloud/assignments/[folderId]/form/answer-file — upload jawaban
// FILE/IMAGE selama pengerjaan form (siswa).
// Inti logika di lib/upload-actions.ts (dipakai juga jalur chunked).

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ folderId: string }> }
) {
  const user = await requireUser().catch(() => null);
  if (!user) return errorResponse("UNAUTHORIZED", 401);

  const { folderId } = await params;

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

  const upload: UploadBytes = {
    name: file.name,
    mimetype: file.type || "application/octet-stream",
    size: file.size,
    bytes: Buffer.from(await file.arrayBuffer()),
  };

  const result = await uploadAnswerFileAction(user, upload, {
    folderId,
    questionId,
  });
  return Response.json(result.body, { status: result.status });
}
