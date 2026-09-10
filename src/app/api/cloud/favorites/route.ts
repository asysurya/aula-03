import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { errorResponse } from "@/lib/cloud-utils";

// ── Favorit file/folder cloud ───────────────────────────────────────
// GET    /api/cloud/favorites           → daftar favorit user (+info item)
// POST   /api/cloud/favorites           → toggle { fileId } | { folderId }
// (Koleksi baru — aman untuk MongoDB produksi tanpa migrasi.)

export async function GET() {
  const user = await requireUser().catch(() => null);
  if (!user) return errorResponse("UNAUTHORIZED", 401);

  const favs = await db.favorite.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  const fileIds = favs.filter((f) => f.fileId).map((f) => f.fileId as string);
  const folderIds = favs
    .filter((f) => f.folderId)
    .map((f) => f.folderId as string);

  const [files, folders] = await Promise.all([
    fileIds.length
      ? db.cloudFile.findMany({
          where: { id: { in: fileIds } },
          select: {
            id: true,
            name: true,
            size: true,
            mimetype: true,
            storageKey: true,
            folder: { select: { id: true, name: true, classroomId: true } },
          },
        })
      : [],
    folderIds.length
      ? db.cloudFolder.findMany({
          where: { id: { in: folderIds } },
          select: {
            id: true,
            name: true,
            type: true,
            classroomId: true,
            classroom: { select: { name: true } },
          },
        })
      : [],
  ]);

  const fileMap = new Map(files.map((f) => [f.id, f]));
  const folderMap = new Map(folders.map((f) => [f.id, f]));

  const items = favs
    .map((fav) => {
      if (fav.fileId) {
        const f = fileMap.get(fav.fileId);
        if (!f) return null; // file sudah dihapus → favorit basi
        return {
          kind: "file" as const,
          favoriteId: fav.id,
          id: f.id,
          name: f.name,
          size: f.size,
          mimetype: f.mimetype,
          storageKey: f.storageKey,
          folderId: f.folder?.id ?? null,
          classroomId: f.folder?.classroomId ?? null,
        };
      }
      if (fav.folderId) {
        const f = folderMap.get(fav.folderId);
        if (!f) return null;
        return {
          kind: "folder" as const,
          favoriteId: fav.id,
          id: f.id,
          name: f.name,
          type: f.type,
          classroomId: f.classroomId,
          classroomName: f.classroom?.name ?? null,
        };
      }
      return null;
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  return Response.json({ favorites: items });
}

export async function POST(req: NextRequest) {
  const user = await requireUser().catch(() => null);
  if (!user) return errorResponse("UNAUTHORIZED", 401);

  const body = await req.json().catch(() => null);
  if (!body) return errorResponse("INVALID_JSON", 400);

  const fileId = typeof body.fileId === "string" ? body.fileId : null;
  const folderId = typeof body.folderId === "string" ? body.folderId : null;
  if (!fileId === !folderId) {
    // Harus tepat satu dari fileId / folderId.
    return errorResponse("ONE_TARGET_REQUIRED", 400);
  }

  // Validasi target ada.
  if (fileId) {
    const f = await db.cloudFile.findUnique({
      where: { id: fileId },
      select: { id: true },
    });
    if (!f) return errorResponse("FILE_NOT_FOUND", 404);
  } else if (folderId) {
    const f = await db.cloudFolder.findUnique({
      where: { id: folderId },
      select: { id: true },
    });
    if (!f) return errorResponse("FOLDER_NOT_FOUND", 404);
  }

  const existing = await db.favorite.findFirst({
    where: { userId: user.id, ...(fileId ? { fileId } : { folderId }) },
    select: { id: true },
  });
  if (existing) {
    await db.favorite.delete({ where: { id: existing.id } });
    return Response.json({ favorited: false });
  }
  await db.favorite.create({
    data: { userId: user.id, fileId, folderId },
  });
  return Response.json({ favorited: true });
}
