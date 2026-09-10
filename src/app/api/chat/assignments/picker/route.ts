import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { errorResponse, getClassroomRole } from "@/lib/cloud-utils";
import {
  canViewFolder,
  type ClassroomRole,
  type UserRole,
} from "@/lib/cloud-perms";

// GET /api/chat/assignments/picker?q=<search>
// Daftar tugas dari SEMUA kelas yang user ikuti dan foldernya terlihat
// oleh user — dipakai dialog "Lampirkan Tugas" di chat (kelas/grup/DM).
export async function GET(req: NextRequest) {
  const user = await requireUser().catch(() => null);
  if (!user) return errorResponse("UNAUTHORIZED", 401);

  const q = (new URL(req.url).searchParams.get("q") ?? "")
    .trim()
    .toLowerCase();

  const memberships = await db.classroomMember.findMany({
    where: { userId: user.id },
    select: { classroomId: true },
  });
  const classroomIds = memberships.map((m) => m.classroomId);
  if (classroomIds.length === 0) return Response.json({ assignments: [] });

  const userRole = user.role as UserRole;

  // Semua folder tugas di kelas yang diikuti + assignment + form + kelas.
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
          description: true,
          deadline: true,
          maxScore: true,
          form: { select: { id: true, questions: { select: { id: true } } } },
        },
      },
      classroom: { select: { name: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 200,
  });

  const out: {
    id: string;
    folderId: string;
    title: string;
    description: string | null;
    deadline: string;
    maxScore: number | null;
    classroomName: string;
    questionCount: number | null;
    deadlinePassed: boolean;
  }[] = [];
  const now = Date.now();

  for (const f of folders) {
    if (!f.assignment) continue;
    if (q && !f.assignment.title.toLowerCase().includes(q)) continue;

    // Filter visibilitas folder (sama seperti Cloud Picker file).
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

    out.push({
      id: f.assignment.id,
      folderId: f.id,
      title: f.assignment.title,
      description: f.assignment.description,
      deadline: new Date(f.assignment.deadline).toISOString(),
      maxScore: f.assignment.maxScore,
      classroomName: f.classroom?.name ?? f.name,
      questionCount: f.assignment.form
        ? f.assignment.form.questions.length
        : null,
      deadlinePassed: new Date(f.assignment.deadline).getTime() < now,
    });
    if (out.length >= 50) break; // cukup
  }

  return Response.json({ assignments: out });
}
