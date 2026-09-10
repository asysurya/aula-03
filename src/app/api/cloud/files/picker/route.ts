import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import {
  errorResponse,
  getClassroomRole,
  isClassroomMember,
} from "@/lib/cloud-utils";
import {
  canViewFile,
  type UserRole,
  type ClassroomRole,
} from "@/lib/cloud-perms";

// GET /api/cloud/files/picker?kind=classroom|group|dm&id=<id>&q=<search>
// Daftar FLAT file cloud yang bisa dilampirkan ke chat (Cloud Picker):
// - classroom:<id> → semua file kelas yang terlihat user
// - group:<id>     → file kelas asal grup itu (fallback: file milik sendiri)
// - dm             → file milik user sendiri di semua kelas
// Maks 100 file terbaru, dikecualikan file jawaban tugas.
export async function GET(req: NextRequest) {
  const user = await requireUser().catch(() => null);
  if (!user) return errorResponse("UNAUTHORIZED", 401);

  const url = new URL(req.url);
  const kind = url.searchParams.get("kind") ?? "classroom";
  const id = url.searchParams.get("id") ?? "";
  const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();

  let classroomId: string | null = null;
  let onlyMine = false;

  if (kind === "classroom") {
    if (!id) return errorResponse("ID_REQUIRED", 400);
    if (user.role !== "ADMIN" && !(await isClassroomMember(id, user.id)))
      return errorResponse("FORBIDDEN", 403);
    classroomId = id;
  } else if (kind === "group") {
    if (!id) return errorResponse("ID_REQUIRED", 400);
    const group = await db.group.findUnique({
      where: { id },
      select: { classroomId: true },
    });
    classroomId = group?.classroomId ?? null;
    if (
      classroomId &&
      user.role !== "ADMIN" &&
      !(await isClassroomMember(classroomId, user.id))
    )
      classroomId = null;
    if (!classroomId) onlyMine = true; // grup tanpa kelas → file milik sendiri
  } else {
    // dm → hanya file milik sendiri
    onlyMine = true;
  }

  const userRole = user.role as UserRole;

  // Semua kelas yang user ikuti (untuk mode onlyMine / group fallback).
  const myClassroomIds = (
    await db.classroomMember.findMany({
      where: { userId: user.id },
      select: { classroomId: true },
    })
  ).map((m) => m.classroomId);

  let folders: { id: string; name: string }[] = [];
  if (classroomId) {
    folders = await db.cloudFolder.findMany({
      where: { classroomId },
      select: { id: true, name: true },
    });
  } else {
    folders = await db.cloudFolder.findMany({
      where: { classroomId: { in: myClassroomIds } },
      select: { id: true, name: true },
    });
  }
  const folderName = new Map(folders.map((f) => [f.id, f.name]));

  let memberIds: string[] = [];
  if (classroomId) {
    memberIds = (
      await db.classroomMember.findMany({
        where: { classroomId },
        select: { userId: true },
      })
    ).map((m) => m.userId);
  }

  // Kandidat file.
  const where = onlyMine
    ? {
        uploadedBy: user.id,
        OR: [
          { folderId: { in: folders.map((f) => f.id) } },
          // File PERMANEN tanpa folder — unggahan chat permanen & referensi
          // mount MEGA milik sendiri — bisa dipakai ulang di pesan lain.
          { folderId: null, expiresAt: null },
        ],
      }
    : {
        OR: [
          { folderId: { in: folders.map((f) => f.id) } },
          { folderId: null, uploadedBy: { in: memberIds } },
        ],
      };

  const filesRaw = await db.cloudFile.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: 200,
    include: {
      uploader: { select: { id: true, name: true, username: true } },
      grants: { select: { userId: true } },
    },
  });

  // File jawaban tugas (relasi submission) tidak ditawarkan ulang.
  const usedIds = new Set(
    (
      await db.submission.findMany({
        where: { fileId: { in: filesRaw.map((f) => f.id) } },
        select: { fileId: true },
      })
    )
      .map((s) => s.fileId)
      .filter((fid): fid is string => !!fid)
  );

  const classroomRole: ClassroomRole | null = classroomId
    ? userRole === "ADMIN"
      ? "TEACHER"
      : await getClassroomRole(classroomId, user.id)
    : null;

  const visible: typeof filesRaw = [];
  for (const f of filesRaw) {
    if (usedIds.has(f.id)) continue;
    if (
      !canViewFile(
        {
          id: f.id,
          folderId: f.folderId,
          visibility: f.visibility,
          uploadedBy: f.uploadedBy,
          grants: f.grants ?? [],
        } as Parameters<typeof canViewFile>[0],
        user.id,
        userRole,
        classroomRole
      )
    )
      continue;
    if (q && !f.name.toLowerCase().includes(q)) continue;
    visible.push(f);
    if (visible.length >= 100) break;
  }

  return Response.json({
    files: visible.map((f) => ({
      id: f.id,
      name: f.name,
      size: f.size,
      mimetype: f.mimetype,
      storageKey: f.storageKey,
      createdAt: f.createdAt,
      folderName: f.folderId ? folderName.get(f.folderId) ?? null : null,
      uploader: f.uploader,
    })),
  });
}
