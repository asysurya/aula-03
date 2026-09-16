import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import {
  errorResponse,
  folderClassroomId,
  getClassroomRole,
  isClassroomMember,
} from "@/lib/cloud-utils";

// ── Rekaman pengerjaan tugas (toggle guru Form.recordWork) ──────────
// GET  /api/cloud/assignments/[folderId]/form/recordings
//      → daftar semua rekaman form ini (guru): LIVE + SAVED, + user.
// POST /api/cloud/assignments/[folderId]/form/recordings
//      → siswa: mulai/lanjutkan rekaman LIVE miliknya (idempotent —
//        bila sudah ada rekaman LIVE (mis. siswa refresh halaman),
//        rekaman itu dipakai lagi, tidak dibuat baru).

function recordingDto(r: {
  id: string;
  status: string;
  startedAt: Date;
  finishedAt: Date | null;
  frameCount: number;
  lastSeq: number;
  lastFrameAt: Date | null;
}) {
  return {
    id: r.id,
    status: r.status as "LIVE" | "SAVED",
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    frameCount: r.frameCount,
    lastSeq: r.lastSeq,
    lastFrameAt: r.lastFrameAt,
  };
}

export async function GET(
  _req: NextRequest,
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

  const form = await db.form.findUnique({
    where: { assignmentId: assignment.id },
    select: { id: true, recordWork: true },
  });
  if (!form) return errorResponse("FORM_NOT_FOUND", 404);

  const rows = await db.formRecording.findMany({
    where: { formId: form.id },
    orderBy: { startedAt: "desc" },
  });

  // FormRecording tidak berelasi Prisma ke User (pola FormAttemptArchive)
  // — ambil profil user terpisah lalu petakan.
  const userIds = [...new Set(rows.map((r) => r.userId))];
  const users = userIds.length
    ? await db.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true, name: true, username: true },
      })
    : [];
  const userById = new Map(users.map((u) => [u.id, u]));

  return Response.json({
    recordWork: form.recordWork ?? false,
    recordings: rows.map((r) => ({
      ...recordingDto(r),
      user: userById.get(r.userId) ?? {
        id: r.userId,
        name: "(akun terhapus)",
        username: "-",
      },
    })),
  });
}

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
    select: { id: true },
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
    return errorResponse("TEACHERS_CANNOT_RECORD", 403);

  const form = await db.form.findUnique({
    where: { assignmentId: assignment.id },
    select: { id: true, recordWork: true },
  });
  if (!form) return errorResponse("FORM_NOT_FOUND", 404);
  if (!(form.recordWork ?? false))
    return errorResponse("RECORDING_DISABLED", 403);

  // Rekaman hanya berlaku saat attempt sedang berjalan.
  const attempt = await db.formAttempt.findUnique({
    where: { formId_userId: { formId: form.id, userId: user.id } },
    select: { id: true, status: true },
  });
  if (!attempt || attempt.status !== "IN_PROGRESS")
    return errorResponse("ATTEMPT_NOT_IN_PROGRESS", 409);

  // Idempotent: pakai rekaman LIVE yang sama setelah refresh / pindah device.
  const existingLive = await db.formRecording.findFirst({
    where: { formId: form.id, userId: user.id, status: "LIVE" },
  });
  if (existingLive)
    return Response.json({ recording: recordingDto(existingLive) });

  const rec = await db.formRecording.create({
    data: { formId: form.id, userId: user.id },
  });
  return Response.json({ recording: recordingDto(rec) });
}
