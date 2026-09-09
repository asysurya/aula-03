import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import {
  errorResponse,
  folderClassroomId,
  getClassroomRole,
  isClassroomMember,
} from "@/lib/cloud-utils";
import { canViewFile, type UserRole, type ClassroomRole } from "@/lib/cloud-perms";

// GET /api/cloud/assignments/[folderId]
// Returns assignment details + submission status. Students get their own submission.
// Teachers/admins get the list of all classroom members + their submission status.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ folderId: string }> }
) {
  const user = await requireUser().catch(() => null);
  if (!user) return errorResponse("UNAUTHORIZED", 401);

  const { folderId } = await params;

  const folder = await db.cloudFolder.findUnique({
    where: { id: folderId },
    select: { id: true, name: true, type: true, classroomId: true, parentId: true },
  });
  if (!folder) return errorResponse("FOLDER_NOT_FOUND", 404);
  if (folder.type !== "ASSIGNMENT")
    return errorResponse("NOT_AN_ASSIGNMENT", 400);

  const classroomId = await folderClassroomId(folderId);
  if (!classroomId) return errorResponse("FOLDER_NO_CLASSROOM", 400);

  if (
    user.role !== "ADMIN" &&
    !(await isClassroomMember(classroomId, user.id))
  ) {
    return errorResponse("FORBIDDEN", 403);
  }

  const assignment = await db.assignment.findUnique({
    where: { folderId },
    select: {
      id: true,
      folderId: true,
      title: true,
      description: true,
      deadline: true,
      maxScore: true,
      createdAt: true,
      createdBy: true,
    },
  });
  if (!assignment) return errorResponse("ASSIGNMENT_NOT_FOUND", 404);

  // Submissions (must be fetched first so we can exclude submission files
  // from the reference materials list below).
  const submissions = await db.submission.findMany({
    where: { assignmentId: assignment.id },
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
      user: { select: { id: true, name: true, username: true } },
    },
  });

  // Reference materials (files uploaded by teacher inside assignment folder).
  // EXCLUDE files that are linked to a Submission (student uploads) so they
  // don't leak into the "materi pendukung" list.
  const submissionFileIds = submissions
    .map((s) => s.fileId)
    .filter((id): id is string => !!id);
  const referenceFilesRaw = await db.cloudFile.findMany({
    where: {
      folderId,
      id: { notIn: submissionFileIds },
    },
    orderBy: [{ createdAt: "desc" }],
    select: {
      id: true,
      name: true,
      size: true,
      mimetype: true,
      storageKey: true,
      createdAt: true,
      uploadedBy: true,
      folderId: true,
      visibility: true,
      uploader: { select: { id: true, name: true, username: true } },
      grants: { select: { userId: true } },
    },
  });

  // ── Visibility filter on reference materials ───────────────────────
  // Students shouldn't see PRIVATE/TEACHERS materials they don't have a grant
  // for. Teacher viewers see everything (visibility TEACHERS already allows
  // teachers, and ADMIN/GURU is treated as TEACHER below).
  const userRole = user.role as UserRole;
  const myRole =
    userRole === "ADMIN" ? "TEACHER" : await getClassroomRole(classroomId, user.id);

  const classroomRole: ClassroomRole | null =
    myRole === "TEACHER" ? "TEACHER" : myRole;

  const referenceFiles = referenceFilesRaw.filter((f) =>
    canViewFile(
      {
        id: f.id,
        visibility: f.visibility,
        uploadedBy: f.uploadedBy,
        folderId: f.folderId ?? null,
        grants: f.grants,
      },
      user.id,
      userRole,
      classroomRole
    )
  );

  if (myRole === "TEACHER") {
    // Build the full member roster with submission status.
    const members = await db.classroomMember.findMany({
      where: { classroomId },
      orderBy: [{ user: { name: "asc" } }],
      select: {
        role: true,
        user: { select: { id: true, name: true, username: true } },
      },
    });
    const subByUser = new Map(submissions.map((s) => [s.userId, s]));
    const roster = members.map((m) => {
      const sub = subByUser.get(m.user.id) ?? null;
      return {
        user: m.user,
        role: m.role,
        submitted: !!sub,
        submittedAt: sub?.submittedAt ?? null,
        note: sub?.note ?? null,
        file: sub?.file ?? null,
      };
    });
    const submittedCount = roster.filter((r) => r.submitted).length;
    const studentCount = roster.filter((r) => r.role === "STUDENT").length;
    return Response.json({
      assignment,
      classroomId,
      referenceFiles,
      myRole,
      mySubmission: null,
      roster,
      summary: { submittedCount, studentCount, total: roster.length },
    });
  }

  // Student view.
  const mine = submissions.find((s) => s.userId === user.id) ?? null;
  return Response.json({
    assignment,
    classroomId,
    referenceFiles,
    myRole,
    mySubmission: mine,
    roster: null,
    summary: null,
  });
}
