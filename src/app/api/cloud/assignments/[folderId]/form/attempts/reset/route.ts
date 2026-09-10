import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import {
  errorResponse,
  folderClassroomId,
  getClassroomRole,
} from "@/lib/cloud-utils";
import { hardDeleteCloudFilesByIds } from "@/lib/hard-delete";

// POST /api/cloud/assignments/[folderId]/form/attempts/reset
// body: { userId }
//
// Guru menghapus pengerjaan seorang siswa (jawaban + file upload + pelanggaran)
// supaya siswa tersebut dapat MULAI ULANG dari awal. Berguna kalau:
//  - submit siswa gagal/tersangkut,
//  - siswa salah memulai / terlanjur,
//  - guru ingin memberi kesempatan pengerjaan ulang.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ folderId: string }> }
) {
  const user = await requireUser().catch(() => null);
  if (!user) return errorResponse("UNAUTHORIZED", 401);

  const { folderId } = await params;
  const body = await req.json().catch(() => null);
  const targetUserId =
    body && typeof body.userId === "string" ? body.userId : null;
  if (!targetUserId) return errorResponse("USER_ID_REQUIRED", 400);

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

  // Tidak boleh mereset pengerjaan guru lain / diri sendiri (hanya siswa).
  const target = await db.user.findUnique({
    where: { id: targetUserId },
    select: { id: true, role: true },
  });
  if (!target) return errorResponse("USER_NOT_FOUND", 404);
  if (target.role === "ADMIN") return errorResponse("CANNOT_RESET_ADMIN", 400);

  const form = await db.form.findUnique({
    where: { assignmentId: assignment.id },
    select: { id: true },
  });
  if (!form) return errorResponse("FORM_NOT_FOUND", 404);

  const attempt = await db.formAttempt.findUnique({
    where: { formId_userId: { formId: form.id, userId: targetUserId } },
    include: { answers: { select: { fileId: true } } },
  });
  if (!attempt) return errorResponse("ATTEMPT_NOT_FOUND", 404);

  // Kumpulkan file jawaban (FILE/IMAGE) supaya blob cloud ikut terhapus.
  const answerFileIds = attempt.answers
    .map((a) => a.fileId)
    .filter((x): x is string => !!x);

  // Hapus urutan: answers → attempt → file fisik (hard delete: baris
  // CloudFile + blob di MEGA/S3). Relasi attempt→answers pakai Cascade,
  // tapi hapus eksplisit supaya eksplisit & aman urutannya.
  await db.formAnswer.deleteMany({ where: { attemptId: attempt.id } });
  await db.formAttempt.delete({ where: { id: attempt.id } });
  await hardDeleteCloudFilesByIds(answerFileIds);

  return Response.json({
    ok: true,
    resetUserId: targetUserId,
    deletedFiles: answerFileIds.length,
  });
}
