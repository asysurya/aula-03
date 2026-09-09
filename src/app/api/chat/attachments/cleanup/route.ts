import { db } from "@/lib/db";
import { deleteFile } from "@/lib/storage";
import { requireUser } from "@/lib/session";

// POST /api/chat/attachments/cleanup
// Poor-man's cron (Vercel serverless has no built-in cron).
// Finds all CloudFile with expiresAt < now and deletes them:
//   1. deleteFile(blob) for the underlying storage (local or MEGA)
//   2. Delete the CloudFile row → cascades to MessageAttachment.
// Any logged-in user can trigger this. Returns { cleaned: count }.
export async function POST() {
  const user = await requireUser().catch(() => null);
  if (!user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const expired = await db.cloudFile.findMany({
    where: {
      expiresAt: { lt: new Date() },
    },
    select: { id: true, storageKey: true },
    take: 100, // cap per call to avoid timeouts on huge backlogs
  });

  let cleaned = 0;
  for (const f of expired) {
    try {
      await deleteFile(f.storageKey);
    } catch {
      // Even if blob delete fails, still drop the DB row so the file
      // is no longer referenced. The orphaned blob is a leak (rare).
    }
    try {
      await db.cloudFile.delete({ where: { id: f.id } });
      cleaned += 1;
    } catch {
      // Already deleted by a concurrent call — ignore.
    }
  }

  return Response.json({ cleaned });
}
