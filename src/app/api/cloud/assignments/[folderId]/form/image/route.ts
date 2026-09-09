import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { errorResponse, folderClassroomId, getClassroomRole } from "@/lib/cloud-utils";
import { ALLOWED_MIMES, MAX_FILE_SIZE, saveFile } from "@/lib/storage";

// POST /api/cloud/assignments/[folderId]/form/image — upload gambar soal (guru).
// Disimpan via storage layer (MEGA) sebagai CloudFile PRIVATE tanpa folder,
// lalu di-link ke FormQuestion.imageFileId saat form disimpan.
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

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return errorResponse("INVALID_FORMDATA", 400);
  }

  const file = formData.get("file");
  if (!(file instanceof File)) return errorResponse("FILE_REQUIRED", 400);
  if (file.size === 0) return errorResponse("FILE_EMPTY", 400);
  if (file.size > MAX_FILE_SIZE) return errorResponse("FILE_TOO_LARGE", 413);

  const mimetype = file.type || "application/octet-stream";
  if (!ALLOWED_MIMES.has(mimetype) || !mimetype.startsWith("image/"))
    return errorResponse("IMAGE_REQUIRED", 415);

  const bytes = Buffer.from(await file.arrayBuffer());
  const saved = await saveFile(file.name, mimetype, bytes).catch((e) => {
    console.error("[form image] saveFile failed:", e);
    return { storageKey: null, size: 0, cloudAccountId: null, error: e } as const;
  });
  if (!saved || saved.storageKey === null) {
    const msg = saved && "error" in saved && saved.error instanceof Error
      ? saved.error.message
      : "UPLOAD_FAILED";
    return errorResponse(msg, 502);
  }

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
    select: { id: true, name: true, size: true, mimetype: true, storageKey: true },
  });

  return Response.json({ file: cloudFile });
}
