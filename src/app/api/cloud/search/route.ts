import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { errorResponse, getClassroomRole, isClassroomMember } from "@/lib/cloud-utils";
import {
  canViewFile,
  canViewFolder,
  type ClassroomRole,
  type UserRole,
} from "@/lib/cloud-perms";

// GET /api/cloud/search?q=...
// Pencarian global cloud: folder + file + dokumen bersama di semua kelas
// yang user ikuti (difilter visibilitas). Maks 15 per kategori.
export async function GET(req: NextRequest) {
  const user = await requireUser().catch(() => null);
  if (!user) return errorResponse("UNAUTHORIZED", 401);

  const q = (new URL(req.url).searchParams.get("q") ?? "").trim().toLowerCase();
  if (q.length < 2) {
    return Response.json({ folders: [], files: [], docs: [] });
  }

  const memberships = await db.classroomMember.findMany({
    where: { userId: user.id },
    select: { classroomId: true },
  });
  const classroomIds = memberships.map((m) => m.classroomId);
  const userRole = user.role as UserRole;

  // ── Folder (incl. tugas) ──
  const folderRows = await db.cloudFolder.findMany({
    where: {
      classroomId: { in: classroomIds },
      name: { contains: q },
    },
    select: {
      id: true,
      name: true,
      type: true,
      visibility: true,
      createdBy: true,
      classroomId: true,
      classroom: { select: { name: true } },
      grants: { select: { userId: true } },
    },
    take: 40,
    orderBy: { createdAt: "desc" },
  });
  const folders: {
    id: string;
    name: string;
    type: string;
    classroomName: string | null;
  }[] = [];
  for (const f of folderRows) {
    if (userRole !== "ADMIN") {
      const cr: ClassroomRole | null = await getClassroomRole(
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
          cr
        )
      )
        continue;
    }
    folders.push({
      id: f.id,
      name: f.name,
      type: f.type,
      classroomName: f.classroom?.name ?? null,
    });
    if (folders.length >= 15) break;
  }

  // ── File ──
  const fileRows = await db.cloudFile.findMany({
    where: {
      name: { contains: q },
      OR: [
        { folder: { classroomId: { in: classroomIds } } },
        { folderId: null },
      ],
    },
    select: {
      id: true,
      name: true,
      size: true,
      mimetype: true,
      storageKey: true,
      uploadedBy: true,
      visibility: true,
      folderId: true,
      folder: { select: { name: true, classroomId: true } },
      grants: { select: { userId: true } },
    },
    take: 60,
    orderBy: { createdAt: "desc" },
  });
  const files: {
    id: string;
    name: string;
    size: number;
    mimetype: string;
    storageKey: string;
    folderName: string | null;
  }[] = [];
  for (const f of fileRows) {
    // Lewati file jawaban tugas (privasi siswa).
    const isSubmissionFile = await db.submission.findUnique({
      where: { fileId: f.id },
      select: { id: true },
    });
    if (isSubmissionFile) continue;

    if (userRole !== "ADMIN" && f.uploadedBy !== user.id) {
      if (!f.folderId || !f.folder?.classroomId) continue;
      if (!(await isClassroomMember(f.folder.classroomId, user.id))) continue;
      const cr = await getClassroomRole(f.folder.classroomId, user.id);
      if (
        !canViewFile(
          {
            id: f.id,
            folderId: f.folderId,
            visibility: f.visibility as "ALL" | "TEACHERS" | "PRIVATE",
            uploadedBy: f.uploadedBy,
            grants: f.grants ?? [],
          },
          user.id,
          userRole,
          cr
        )
      )
        continue;
    }
    files.push({
      id: f.id,
      name: f.name,
      size: f.size,
      mimetype: f.mimetype,
      storageKey: f.storageKey,
      folderName: f.folder?.name ?? null,
    });
    if (files.length >= 15) break;
  }

  // ── Dokumen bersama ──
  const docs = await db.sharedDoc.findMany({
    where: {
      title: { contains: q },
      OR: [
        { folder: { classroomId: { in: classroomIds } } },
        { folderId: null, createdBy: user.id },
      ],
    },
    select: {
      id: true,
      title: true,
      updatedAt: true,
      folder: { select: { name: true, classroomId: true } },
    },
    take: 15,
    orderBy: { updatedAt: "desc" },
  });

  return Response.json({
    folders,
    files,
    docs: docs.map((d) => ({
      id: d.id,
      title: d.title,
      updatedAt: new Date(d.updatedAt).toISOString(),
      folderName: d.folder?.name ?? null,
    })),
  });
}
