import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import {
  errorResponse,
  folderClassroomId,
  isClassroomMember,
} from "@/lib/cloud-utils";

// GET /api/cloud/docs?folderId=<id> — list docs in a folder (or root docs for a classroom).
export async function GET(req: NextRequest) {
  const user = await requireUser().catch(() => null);
  if (!user) return errorResponse("UNAUTHORIZED", 401);

  const url = new URL(req.url);
  const folderIdParam = url.searchParams.get("folderId");
  const folderId =
    folderIdParam && folderIdParam !== "null" ? folderIdParam : null;
  const classroomIdParam = url.searchParams.get("classroomId");
  const classroomId =
    classroomIdParam && classroomIdParam !== "null" ? classroomIdParam : null;

  if (folderId) {
    const cid = await folderClassroomId(folderId);
    if (!cid) return errorResponse("FOLDER_NO_CLASSROOM", 400);
    if (
      user.role !== "ADMIN" &&
      !(await isClassroomMember(cid, user.id))
    ) {
      return errorResponse("FORBIDDEN", 403);
    }
    const docs = await db.sharedDoc.findMany({
      where: { folderId },
      orderBy: [{ updatedAt: "desc" }],
      select: {
        id: true,
        title: true,
        updatedAt: true,
        createdBy: true,
        creator: { select: { id: true, name: true, username: true } },
      },
    });
    return Response.json({ docs });
  }

  if (classroomId) {
    if (
      user.role !== "ADMIN" &&
      !(await isClassroomMember(classroomId, user.id))
    ) {
      return errorResponse("FORBIDDEN", 403);
    }
    // Pre-fetch classroom member user IDs so we can filter root-level docs
    // (folderId=null) by creator — avoids Prisma's nested User filter that
    // doesn't accept `classroomMemberships` as a scalar relation predicate.
    const memberIds = (
      await db.classroomMember.findMany({
        where: { classroomId },
        select: { userId: true },
      })
    ).map((m) => m.userId);

    const docs = await db.sharedDoc.findMany({
      where: {
        OR: [
          { folder: { classroomId } },
          { folderId: null, createdBy: { in: memberIds } },
        ],
      },
      orderBy: [{ updatedAt: "desc" }],
      select: {
        id: true,
        title: true,
        updatedAt: true,
        createdBy: true,
        creator: { select: { id: true, name: true, username: true } },
      },
    });
    return Response.json({ docs });
  }

  return errorResponse("REQUIRES_FOLDER_OR_CLASSROOM", 400);
}

// POST /api/cloud/docs — body: { title, content?, folderId?, classroomId? }
export async function POST(req: NextRequest) {
  const user = await requireUser().catch(() => null);
  if (!user) return errorResponse("UNAUTHORIZED", 401);

  let body: {
    title?: string;
    content?: string;
    folderId?: string;
    classroomId?: string;
  };
  try {
    body = await req.json();
  } catch {
    return errorResponse("INVALID_JSON", 400);
  }

  const title = (body.title ?? "").trim();
  if (!title) return errorResponse("TITLE_REQUIRED", 400);
  if (title.length > 200) return errorResponse("TITLE_TOO_LONG", 400);

  let folderId: string | null = body.folderId ?? null;
  let classroomId: string | null = body.classroomId ?? null;

  if (folderId) {
    const cid = await folderClassroomId(folderId);
    if (!cid) return errorResponse("FOLDER_NO_CLASSROOM", 400);
    if (
      user.role !== "ADMIN" &&
      !(await isClassroomMember(cid, user.id))
    ) {
      return errorResponse("FORBIDDEN", 403);
    }
    classroomId = cid;
  } else if (classroomId) {
    if (
      user.role !== "ADMIN" &&
      !(await isClassroomMember(classroomId, user.id))
    ) {
      return errorResponse("FORBIDDEN", 403);
    }
  }

  const doc = await db.sharedDoc.create({
    data: {
      title,
      content: body.content ?? "",
      folderId,
      createdBy: user.id,
    },
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

  await db.docCollaborator.create({
    data: { docId: doc.id, userId: user.id },
  });

  return Response.json({ doc }, { status: 201 });
}
