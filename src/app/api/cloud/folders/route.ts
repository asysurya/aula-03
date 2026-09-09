import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import {
  errorResponse,
  folderAncestors,
  isClassroomMember,
  folderClassroomId,
  getClassroomRole,
} from "@/lib/cloud-utils";
import {
  canViewFolder,
  canViewFile,
  parseVisibility,
  canSetVisibility,
  type UserRole,
  type ClassroomRole,
} from "@/lib/cloud-perms";

// GET /api/cloud/folders?folderId=<id>&classroomId=<id>
// Lists contents of a folder (folders + files + docs). If folderId is null but
// classroomId provided, returns root-level items (parentId=null) for that classroom.
export async function GET(req: NextRequest) {
  const user = await requireUser().catch(() => null);
  if (!user) return errorResponse("UNAUTHORIZED", 401);

  const url = new URL(req.url);
  const folderIdParam = url.searchParams.get("folderId");
  const folderId =
    folderIdParam && folderIdParam !== "null" ? folderIdParam : null;
  const classroomId = url.searchParams.get("classroomId");

  let targetClassroomId: string | null = null;

  if (folderId) {
    const folder = await db.cloudFolder.findUnique({
      where: { id: folderId },
      select: {
        id: true,
        classroomId: true,
        parentId: true,
        type: true,
        name: true,
      },
    });
    if (!folder) return errorResponse("FOLDER_NOT_FOUND", 404);
    targetClassroomId = await folderClassroomId(folderId);
    if (!targetClassroomId)
      return errorResponse("FOLDER_NO_CLASSROOM", 400);
    if (
      user.role !== "ADMIN" &&
      !(await isClassroomMember(targetClassroomId, user.id))
    ) {
      return errorResponse("FORBIDDEN", 403);
    }
  } else if (classroomId) {
    targetClassroomId = classroomId;
    if (
      user.role !== "ADMIN" &&
      !(await isClassroomMember(classroomId, user.id))
    ) {
      return errorResponse("FORBIDDEN", 403);
    }
  } else {
    return errorResponse("MISSING_FOLDER_OR_CLASSROOM", 400);
  }

  const memberIds = (
    await db.classroomMember.findMany({
      where: { classroomId: targetClassroomId! },
      select: { userId: true },
    })
  ).map((m) => m.userId);

  const folderWhere = folderId
    ? { parentId: folderId }
    : { parentId: null, classroomId: targetClassroomId! };

  const filesWhere = folderId
    ? { folderId }
    : { folderId: null, uploadedBy: { in: memberIds } };

  // Exclude submission files from listing (they're shown in the assignment
  // detail view's submission panel, not in the file browser).
  let excludeFileIds: string[] = [];
  if (folderId) {
    const subs = await db.submission.findMany({
      where: { assignment: { folderId } },
      select: { fileId: true },
    });
    excludeFileIds = subs
      .map((s) => s.fileId)
      .filter((id): id is string => !!id);
  }
  if (excludeFileIds.length > 0) {
    (filesWhere as any).id = { notIn: excludeFileIds };
  }

  const docsWhere = folderId
    ? { folderId }
    : { folderId: null };

  const [foldersRaw, filesRaw, docs, assignment, ancestors] = await Promise.all([
    db.cloudFolder.findMany({
      where: folderWhere,
      orderBy: [{ name: "asc" }],
      select: {
        id: true,
        name: true,
        type: true,
        classroomId: true,
        createdAt: true,
        createdBy: true,
        visibility: true,
        grants: { select: { userId: true } },
      },
    }),
    db.cloudFile.findMany({
      where: filesWhere,
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
    }),
    db.sharedDoc.findMany({
      where: docsWhere,
      orderBy: [{ updatedAt: "desc" }],
      select: {
        id: true,
        title: true,
        updatedAt: true,
        createdBy: true,
        creator: { select: { id: true, name: true, username: true } },
      },
    }),
    folderId
      ? db.assignment.findUnique({
          where: { folderId },
          select: {
            id: true,
            title: true,
            description: true,
            deadline: true,
            maxScore: true,
            createdAt: true,
            createdBy: true,
          },
        })
      : null,
    folderId ? folderAncestors(folderId) : [],
  ]);

  // ── Visibility filtering ─────────────────────────────────────────
  // Compute classroom role once (used by both folder + file predicates).
  const userRole = user.role as UserRole;
  const classroomRole: ClassroomRole | null =
    userRole === "ADMIN"
      ? "TEACHER"
      : await getClassroomRole(targetClassroomId!, user.id);

  const folders = foldersRaw.filter((f) =>
    canViewFolder(
      {
        id: f.id,
        visibility: f.visibility,
        createdBy: f.createdBy,
        grants: f.grants,
      },
      user.id,
      userRole,
      classroomRole
    )
  );

  const files = filesRaw.filter((f) =>
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

  return Response.json({
    folder: folderId
      ? { id: folderId, classroomId: targetClassroomId }
      : null,
    classroomId: targetClassroomId,
    folders,
    files,
    docs,
    assignment,
    ancestors,
  });
}

// POST /api/cloud/folders — body: { name, parentId?, classroomId?, type?, visibility? }
export async function POST(req: NextRequest) {
  const user = await requireUser().catch(() => null);
  if (!user) return errorResponse("UNAUTHORIZED", 401);

  let body: {
    name?: string;
    parentId?: string;
    classroomId?: string;
    type?: string;
    visibility?: string;
  };
  try {
    body = await req.json();
  } catch {
    return errorResponse("INVALID_JSON", 400);
  }

  const name = (body.name ?? "").trim();
  if (!name) return errorResponse("NAME_REQUIRED", 400);
  if (name.length > 120) return errorResponse("NAME_TOO_LONG", 400);

  const type = body.type === "ASSIGNMENT" ? "ASSIGNMENT" : "FOLDER";

  let classroomId: string | null = body.classroomId ?? null;
  const parentId: string | null = body.parentId ?? null;

  if (parentId) {
    const parent = await db.cloudFolder.findUnique({
      where: { id: parentId },
      select: { id: true, classroomId: true, parentId: true },
    });
    if (!parent) return errorResponse("PARENT_NOT_FOUND", 404);
    const derivedClassroomId = await folderClassroomId(parentId);
    if (!derivedClassroomId) return errorResponse("PARENT_NO_CLASSROOM", 400);
    if (
      user.role !== "ADMIN" &&
      !(await isClassroomMember(derivedClassroomId, user.id))
    ) {
      return errorResponse("FORBIDDEN", 403);
    }
    classroomId = derivedClassroomId;
  } else if (classroomId) {
    if (
      user.role !== "ADMIN" &&
      !(await isClassroomMember(classroomId, user.id))
    ) {
      return errorResponse("FORBIDDEN", 403);
    }
  } else {
    return errorResponse("REQUIRES_PARENT_OR_CLASSROOM", 400);
  }

  // ── Visibility validation ───────────────────────────────────────
  // Default ALL. TEACHERS requires teacher-classroom-role (or ADMIN/GURU).
  // PRIVATE requires creator (or ADMIN/GURU) — always true for creator here.
  const userRole = user.role as UserRole;
  const classroomRole: ClassroomRole | null =
    userRole === "ADMIN"
      ? "TEACHER"
      : await getClassroomRole(classroomId!, user.id);
  const visibility = parseVisibility(body.visibility) ?? "ALL";
  if (
    !canSetVisibility(visibility, true /* isCreator: will be */, userRole, classroomRole)
  ) {
    return errorResponse("VISIBILITY_NOT_ALLOWED", 403);
  }

  const folder = await db.cloudFolder.create({
    data: {
      name,
      parentId,
      classroomId,
      type,
      visibility,
      createdBy: user.id,
    },
    select: {
      id: true,
      name: true,
      type: true,
      classroomId: true,
      parentId: true,
      createdAt: true,
      createdBy: true,
      visibility: true,
    },
  });

  return Response.json({ folder }, { status: 201 });
}
