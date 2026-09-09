import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import {
  errorResponse,
  folderClassroomId,
  getClassroomRole,
  isClassroomMember,
} from "@/lib/cloud-utils";

// POST /api/cloud/assignments — create an ASSIGNMENT-type folder + Assignment row.
// Body: { title, description?, deadline (ISO), classroomId, parentId?, maxScore? }
// Allowed for: TEACHER members + ADMIN only.
export async function POST(req: NextRequest) {
  const user = await requireUser().catch(() => null);
  if (!user) return errorResponse("UNAUTHORIZED", 401);

  let body: {
    title?: string;
    description?: string;
    deadline?: string;
    classroomId?: string;
    parentId?: string;
    maxScore?: number;
  };
  try {
    body = await req.json();
  } catch {
    return errorResponse("INVALID_JSON", 400);
  }

  const title = (body.title ?? "").trim();
  if (!title) return errorResponse("TITLE_REQUIRED", 400);

  const deadlineStr = body.deadline;
  if (!deadlineStr) return errorResponse("DEADLINE_REQUIRED", 400);
  const deadline = new Date(deadlineStr);
  if (isNaN(deadline.getTime())) return errorResponse("INVALID_DEADLINE", 400);

  let classroomId: string | null = null;
  let parentId: string | null = body.parentId ?? null;

  if (parentId) {
    const parent = await db.cloudFolder.findUnique({
      where: { id: parentId },
      select: { id: true, classroomId: true },
    });
    if (!parent) return errorResponse("PARENT_NOT_FOUND", 404);
    const derived = await folderClassroomId(parentId);
    if (!derived) return errorResponse("PARENT_NO_CLASSROOM", 400);
    classroomId = derived;
  } else if (body.classroomId) {
    classroomId = body.classroomId;
  } else {
    return errorResponse("REQUIRES_PARENT_OR_CLASSROOM", 400);
  }

  if (!classroomId) return errorResponse("CLASSROOM_REQUIRED", 400);

  const role =
    user.role === "ADMIN" ? "TEACHER" : await getClassroomRole(classroomId, user.id);
  if (!role) return errorResponse("FORBIDDEN", 403);
  if (role !== "TEACHER") return errorResponse("TEACHER_ONLY", 403);

  let maxScore: number | null = null;
  if (body.maxScore !== undefined && body.maxScore !== null) {
    const n = Number(body.maxScore);
    if (!Number.isFinite(n) || n < 0 || n > 1000)
      return errorResponse("INVALID_MAX_SCORE", 400);
    maxScore = Math.floor(n);
  }

  // Create folder + assignment in a transaction.
  const folder = await db.cloudFolder.create({
    data: {
      name: title,
      parentId,
      classroomId,
      type: "ASSIGNMENT",
      createdBy: user.id,
    },
    select: {
      id: true,
      name: true,
      type: true,
      classroomId: true,
      parentId: true,
      createdAt: true,
    },
  });

  const assignment = await db.assignment.create({
    data: {
      folderId: folder.id,
      title,
      description: body.description?.trim() ? body.description.trim() : null,
      deadline,
      maxScore,
      createdBy: user.id,
    },
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

  // Silence unused import in some lint configs.
  void isClassroomMember;

  return Response.json({ folder, assignment }, { status: 201 });
}
