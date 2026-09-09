import { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import { errorResponse } from "@/lib/cloud-utils";
import { uploadFormImageAction, type UploadBytes } from "@/lib/upload-actions";

// POST /api/cloud/assignments/[folderId]/form/image — upload gambar soal (guru).
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

  const file = formData.get("file");
  if (!(file instanceof File)) return errorResponse("FILE_REQUIRED", 400);

  const upload: UploadBytes = {
    name: file.name,
    mimetype: file.type || "application/octet-stream",
    size: file.size,
    bytes: Buffer.from(await file.arrayBuffer()),
  };

  const result = await uploadFormImageAction(user, upload, { folderId });
  return Response.json(result.body, { status: result.status });
}
