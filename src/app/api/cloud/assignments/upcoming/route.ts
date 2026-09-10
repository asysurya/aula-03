import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { errorResponse, getClassroomRole } from "@/lib/cloud-utils";
import {
  canViewFolder,
  type ClassroomRole,
  type UserRole,
} from "@/lib/cloud-perms";

// GET /api/cloud/assignments/upcoming
// Agenda tenggat: SEMUA tugas (dengan atau tanpa form) dari kelas yang
// user ikuti dan foldernya terlihat — urut deadline naik, maks 60.
// Termasuk status pengerjaan user (sudah kirim / sedang / belum).
export async function GET() {
  const user = await requireUser().catch(() => null);
  if (!user) return errorResponse("UNAUTHORIZED", 401);

  const memberships = await db.classroomMember.findMany({
    where: { userId: user.id },
    select: { classroomId: true },
  });
  const classroomIds = memberships.map((m) => m.classroomId);
  if (classroomIds.length === 0) return Response.json({ items: [] });

  const userRole = user.role as UserRole;

  const folders = await db.cloudFolder.findMany({
    where: { classroomId: { in: classroomIds }, type: "ASSIGNMENT" },
    select: {
      id: true,
      name: true,
      visibility: true,
      createdBy: true,
      classroomId: true,
      grants: { select: { userId: true } },
      assignment: {
        select: {
          id: true,
          title: true,
          deadline: true,
          maxScore: true,
          form: { select: { id: true, maxAttempts: true } },
        },
      },
      classroom: { select: { name: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 300,
  });

  const now = Date.now();
  const items: {
    id: string;
    folderId: string;
    title: string;
    deadline: string;
    maxScore: number | null;
    classroomName: string;
    hasForm: boolean;
    deadlinePassed: boolean;
    myStatus: "NOT_STARTED" | "IN_PROGRESS" | "SUBMITTED";
  }[] = [];

  // Form attempt milik user (status pengerjaan).
  const myAttempts = new Map(
    (
      await db.formAttempt.findMany({
        where: {
          form: { assignment: { folder: { classroomId: { in: classroomIds } } } },
          userId: user.id,
        },
        select: { formId: true, status: true },
      })
    ).map((a) => [a.formId, a.status])
  );
  // Submission file milik user (tugas non-form).
  const mySubmissions = new Set(
    (
      await db.submission.findMany({
        where: {
          assignment: { folder: { classroomId: { in: classroomIds } } },
          userId: user.id,
        },
        select: { assignmentId: true },
      })
    ).map((s) => s.assignmentId)
  );

  for (const f of folders) {
    if (!f.assignment) continue;

    if (userRole !== "ADMIN") {
      const classroomRole: ClassroomRole | null = await getClassroomRole(
        f.classroomId as string,
        user.id
      );
      if (
        !canViewFolder(
          {
            id: f.id,
            visibility: f.visibility as "ALL" | "TEACHERS" | "PRIVATE",
            createdBy: f.createdBy,
            grants: f.grants ?? [],
          },
          user.id,
          userRole,
          classroomRole
        )
      ) {
        continue;
      }
    }

    const hasForm = !!f.assignment.form;
    let myStatus: "NOT_STARTED" | "IN_PROGRESS" | "SUBMITTED" = "NOT_STARTED";
    if (hasForm && f.assignment.form) {
      const st = myAttempts.get(f.assignment.form.id);
      if (st === "SUBMITTED") myStatus = "SUBMITTED";
      else if (st === "IN_PROGRESS") myStatus = "IN_PROGRESS";
    } else if (mySubmissions.has(f.assignment.id)) {
      myStatus = "SUBMITTED";
    }

    items.push({
      id: f.assignment.id,
      folderId: f.id,
      title: f.assignment.title,
      deadline: new Date(f.assignment.deadline).toISOString(),
      maxScore: f.assignment.maxScore,
      classroomName: f.classroom?.name ?? f.name,
      hasForm,
      deadlinePassed: new Date(f.assignment.deadline).getTime() < now,
      myStatus,
    });
  }

  items.sort((a, b) => a.deadline.localeCompare(b.deadline));

  return Response.json({ items: items.slice(0, 60) });
}
