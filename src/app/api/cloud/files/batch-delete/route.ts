import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { errorResponse } from "@/lib/cloud-utils";
import {
  canDeleteFile,
  type UserRole,
} from "@/lib/cloud-perms";
import { deleteFile } from "@/lib/storage";

// POST /api/cloud/files/batch-delete
// Body: { fileIds: string[] }
// Deletes each file (storage + row). Validates edit permission per file.
export async function POST(req: NextRequest) {
  const user = await requireUser().catch(() => null);
  if (!user) return errorResponse("UNAUTHORIZED", 401);

  let body: { fileIds?: string[] };
  try {
    body = await req.json();
  } catch {
    return errorResponse("INVALID_JSON", 400);
  }

  const fileIds = Array.isArray(body.fileIds)
    ? body.fileIds.filter((x): x is string => typeof x === "string" && !!x)
    : [];
  if (fileIds.length === 0) return errorResponse("FILE_IDS_REQUIRED", 400);
  if (fileIds.length > 100) return errorResponse("TOO_MANY", 400);

  const files = await db.cloudFile.findMany({
    where: { id: { in: fileIds } },
    select: {
      id: true,
      storageKey: true,
      uploadedBy: true,
      folderId: true,
      submission: { select: { id: true } },
    },
  });

  if (files.length === 0) return errorResponse("FILES_NOT_FOUND", 404);

  const userRole = user.role as UserRole;

  // Verify delete permission for each file. canDeleteFile is stricter than
  // canEditFile (admin/guru/owner only — classroom teachers cannot delete
  // files they didn't upload).
  for (const file of files) {
    // Stricter delete check: ADMIN, GURU, or owner only.
    if (
      !canDeleteFile(
        { uploadedBy: file.uploadedBy },
        user.id,
        userRole
      )
    ) {
      return errorResponse("FORBIDDEN_FILE", 403, { fileId: file.id });
    }
  }

  // Clear submission links for any files tied to submissions.
  const filesWithSubs = files.filter((f) => f.submission);
  if (filesWithSubs.length > 0) {
    await db.submission.updateMany({
      where: { fileId: { in: filesWithSubs.map((f) => f.id) } },
      data: { fileId: null },
    });
  }

  // Delete rows.
  await db.cloudFile.deleteMany({
    where: { id: { in: fileIds } },
  });

  // Delete blobs (best-effort, sequential).
  const storageKeys = Array.from(new Set(files.map((f) => f.storageKey)));
  for (const key of storageKeys) {
    try {
      await deleteFile(key);
    } catch {
      // Storage deletion failure is non-fatal for the DB row removal.
    }
  }

  return Response.json({
    ok: true,
    deletedCount: files.length,
  });
}
