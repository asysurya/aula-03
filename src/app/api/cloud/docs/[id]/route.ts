import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import {
  errorResponse,
  folderClassroomId,
  isClassroomMember,
} from "@/lib/cloud-utils";

// GET /api/cloud/docs/[id]
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await requireUser().catch(() => null);
  if (!user) return errorResponse("UNAUTHORIZED", 401);

  const { id } = await params;
  const doc = await db.sharedDoc.findUnique({
    where: { id },
    select: {
      id: true,
      title: true,
      content: true,
      folderId: true,
      createdBy: true,
      createdAt: true,
      updatedAt: true,
      creator: { select: { id: true, name: true, username: true } },
    },
  });
  if (!doc) return errorResponse("DOC_NOT_FOUND", 404);

  let classroomId: string | null = null;
  if (doc.folderId) {
    classroomId = await folderClassroomId(doc.folderId);
  }
  // If no classroom (folder-less doc), only creator or explicit collaborator can view.
  if (!classroomId) {
    if (doc.createdBy === user.id) return Response.json({ doc });
    const collab = await db.docCollaborator.findUnique({
      where: { docId_userId: { docId: id, userId: user.id } },
      select: { id: true },
    });
    if (!collab) {
      if (user.role !== "ADMIN") return errorResponse("FORBIDDEN", 403);
    }
    return Response.json({ doc });
  }

  if (
    user.role !== "ADMIN" &&
    !(await isClassroomMember(classroomId, user.id))
  ) {
    return errorResponse("FORBIDDEN", 403);
  }
  return Response.json({ doc });
}

// PATCH /api/cloud/docs/[id] — body: { title?, content? }
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await requireUser().catch(() => null);
  if (!user) return errorResponse("UNAUTHORIZED", 401);

  const { id } = await params;
  const doc = await db.sharedDoc.findUnique({
    where: { id },
    select: { id: true, folderId: true, createdBy: true },
  });
  if (!doc) return errorResponse("DOC_NOT_FOUND", 404);

  let classroomId: string | null = null;
  if (doc.folderId) {
    classroomId = await folderClassroomId(doc.folderId);
  }
  // Access control: creator, collaborator, classroom member, or admin.
  if (!classroomId) {
    if (doc.createdBy !== user.id) {
      const collab = await db.docCollaborator.findUnique({
        where: { docId_userId: { docId: id, userId: user.id } },
        select: { id: true },
      });
      if (!collab && user.role !== "ADMIN")
        return errorResponse("FORBIDDEN", 403);
    }
  } else {
    if (
      user.role !== "ADMIN" &&
      !(await isClassroomMember(classroomId, user.id))
    ) {
      return errorResponse("FORBIDDEN", 403);
    }
  }

  let body: { title?: string; content?: string };
  try {
    body = await req.json();
  } catch {
    return errorResponse("INVALID_JSON", 400);
  }

  const data: { title?: string; content?: string } = {};
  if (typeof body.title === "string" && body.title.trim()) {
    data.title = body.title.trim().slice(0, 200);
  }
  if (typeof body.content === "string") {
    data.content = body.content;
  }

  const updated = await db.sharedDoc.update({
    where: { id },
    data,
    select: {
      id: true,
      title: true,
      content: true,
      folderId: true,
      createdBy: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  // Ensure editor is a collaborator (best-effort).
  await db.docCollaborator
    .upsert({
      where: { docId_userId: { docId: id, userId: user.id } },
      update: {},
      create: { docId: id, userId: user.id },
    })
    .catch(() => {});

  return Response.json({ doc: updated });
}
