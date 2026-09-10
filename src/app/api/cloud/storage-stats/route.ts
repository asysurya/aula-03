import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";

// GET /api/cloud/storage-stats
// Statistik penyimpanan milik user: jumlah file, total ukuran, jumlah
// dokumen, dan rincian per kelas (file milik sendiri).
export async function GET() {
  const user = await requireUser().catch(() => null);
  if (!user) {
    return Response.json({ error: "UNAUTHORIZED" }, { status: 401 });
  }

  const myFiles = await db.cloudFile.findMany({
    where: { uploadedBy: user.id },
    select: { size: true, folderId: true, expiresAt: true },
  });

  const folders = await db.cloudFolder.findMany({
    where: { id: { in: myFiles.map((f) => f.folderId).filter((x): x is string => !!x) } },
    select: { id: true, name: true, classroomId: true, classroom: { select: { name: true } } },
  });
  const folderMap = new Map(folders.map((f) => [f.id, f]));

  const perClassroom = new Map<
    string,
    { classroomName: string; fileCount: number; totalSize: number }
  >();
  let totalSize = 0;
  let tempCount = 0;

  for (const f of myFiles) {
    totalSize += f.size;
    if (f.expiresAt) {
      tempCount += 1;
      continue; // file sementara chat tidak dihitung ke kelas
    }
    const folder = f.folderId ? folderMap.get(f.folderId) : null;
    const key = folder?.classroomId ?? "_none";
    const label = folder?.classroom?.name ?? "Tanpa kelas";
    const cur =
      perClassroom.get(key) ??
      ({ classroomName: label, fileCount: 0, totalSize: 0 } as {
        classroomName: string;
        fileCount: number;
        totalSize: number;
      });
    cur.fileCount += 1;
    cur.totalSize += f.size;
    perClassroom.set(key, cur);
  }

  const docCount = await db.sharedDoc.count({
    where: { createdBy: user.id },
  });

  return Response.json({
    fileCount: myFiles.length - tempCount,
    totalSize,
    tempCount,
    docCount,
    perClassroom: Array.from(perClassroom.values()).sort(
      (a, b) => b.totalSize - a.totalSize
    ),
  });
}
