import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import {
  errorResponse,
  folderClassroomId,
  getClassroomRole,
} from "@/lib/cloud-utils";
import { MAX_FILE_SIZE, saveFile, deleteFile } from "@/lib/storage";
import { resolveMime } from "@/lib/file-constants";

// POST /api/cloud/submissions — multipart/form-data
// Fields: assignmentId (string), note? (string), file? (File).
// Replaces any prior submission (upsert on [assignmentId, userId]).
// Allowed for: STUDENT classroom members only (teachers/admins don't submit).
export async function POST(req: NextRequest) {
  const user = await requireUser().catch(() => null);
  if (!user) return errorResponse("UNAUTHORIZED", 401);

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return errorResponse("INVALID_FORMDATA", 400);
  }

  const assignmentId = (form.get("assignmentId") as string | null) ?? null;
  const note = (form.get("note") as string | null) ?? null;
  const file = form.get("file");

  if (!assignmentId) return errorResponse("ASSIGNMENT_REQUIRED", 400);

  const assignment = await db.assignment.findUnique({
    where: { id: assignmentId },
    select: {
      id: true,
      folderId: true,
      deadline: true,
    },
  });
  if (!assignment) return errorResponse("ASSIGNMENT_NOT_FOUND", 404);

  const classroomId = await folderClassroomId(assignment.folderId);
  if (!classroomId) return errorResponse("FOLDER_NO_CLASSROOM", 400);

  const role =
    user.role === "ADMIN" ? "TEACHER" : await getClassroomRole(classroomId, user.id);
  if (!role) return errorResponse("FORBIDDEN", 403);
  if (role !== "STUDENT") return errorResponse("STUDENT_ONLY", 403);

  let fileId: string | null = null;
  if (file instanceof File) {
    if (file.size === 0) return errorResponse("FILE_EMPTY", 400);
    if (file.size > MAX_FILE_SIZE)
      return errorResponse("FILE_TOO_LARGE", 413, { maxBytes: MAX_FILE_SIZE });
    const mimetype = resolveMime(file.name, file.type);
    const bytes = Buffer.from(await file.arrayBuffer());
    let stored: { storageKey: string; size: number; cloudAccountId: string | null };
    try {
      stored = await saveFile(file.name, mimetype, bytes);
    } catch (e) {
      // Pesan error dari saveFile sudah ramah-user — tampilkan langsung.
      const msg = e instanceof Error ? e.message : "SAVE_FAILED";
      return errorResponse(msg, 502);
    }
    const row = await db.cloudFile.create({
      data: {
        name: file.name,
        folderId: assignment.folderId,
        uploadedBy: user.id,
        storageKey: stored.storageKey,
        size: stored.size,
        mimetype,
        cloudAccountId: stored.cloudAccountId,
      },
      select: { id: true },
    });
    fileId = row.id;
  }

  // Upsert: replace prior submission.
  const existing = await db.submission.findUnique({
    where: {
      assignmentId_userId: { assignmentId, userId: user.id },
    },
    select: { id: true, fileId: true },
  });

  let submission;
  if (existing) {
    const oldFileId = existing.fileId;
    // Fetch the old file's storageKey before deleting the row so we can also
    // remove the underlying blob (local or MEGA-backed).
    let oldStorageKey: string | null = null;
    if (oldFileId && oldFileId !== fileId) {
      const oldFile = await db.cloudFile.findUnique({
        where: { id: oldFileId },
        select: { storageKey: true },
      }).catch(() => null);
      oldStorageKey = oldFile?.storageKey ?? null;
    }
    submission = await db.submission.update({
      where: { id: existing.id },
      data: {
        note: note?.trim() ? note.trim() : null,
        fileId,
        submittedAt: new Date(),
      },
      select: {
        id: true,
        assignmentId: true,
        userId: true,
        fileId: true,
        note: true,
        submittedAt: true,
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
    });
    // Delete previous file (if replaced and not referenced elsewhere).
    if (oldFileId && oldFileId !== fileId) {
      await db.cloudFile.delete({ where: { id: oldFileId } }).catch(() => {});
      if (oldStorageKey) {
        // Hapus blob HANYA bila tak ada baris lain yang memakai kunci sama
        // (file hasil "Salin" berbagi blob — dulu ikut terhapus!).
        const remaining = await db.cloudFile
          .count({ where: { storageKey: oldStorageKey } })
          .catch(() => 1);
        if (remaining === 0) await deleteFile(oldStorageKey).catch(() => {});
      }
    }
  } else {
    submission = await db.submission.create({
      data: {
        assignmentId,
        userId: user.id,
        fileId,
        note: note?.trim() ? note.trim() : null,
      },
      select: {
        id: true,
        assignmentId: true,
        userId: true,
        fileId: true,
        note: true,
        submittedAt: true,
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
    });
  }

  return Response.json({ submission }, { status: 201 });
}
