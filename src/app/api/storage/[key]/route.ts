import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { deleteFile, getFile } from "@/lib/storage";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { folderClassroomId, getClassroomRole } from "@/lib/cloud-utils";
import { canViewFile, type UserRole, type ClassroomRole } from "@/lib/cloud-perms";

// Serve uploaded files. Authenticated users can read; images also viewable inline.
// The requester must have `canViewFile` permission over the file. Files with no
// classroom context (e.g. chat attachments live outside the cloud hierarchy)
// fall back to "any authenticated user" so chat attachments keep working.
//
// Chat attachment files have `expiresAt` set (24h after upload). On access:
//   - if expired (expiresAt < now) → 410 Gone + delete blob + delete CloudFile
//     row (cascades to MessageAttachment).
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ key: string }> }
) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return new NextResponse("Unauthorized", { status: 401 });
  }
  const { key } = await params;

  // Resolve metadata from any cloud file using this storage key
  const file = await db.cloudFile.findFirst({
    where: { storageKey: key },
    select: {
      id: true,
      name: true,
      mimetype: true,
      visibility: true,
      uploadedBy: true,
      folderId: true,
      storageKey: true,
      expiresAt: true,
      grants: { select: { userId: true } },
    },
  });
  if (!file) {
    return new NextResponse("Not found", { status: 404 });
  }

  // Temp chat file expiry handling: if expiresAt is set and in the past,
  // treat the file as gone and clean it up lazily.
  if (file.expiresAt && file.expiresAt.getTime() < Date.now()) {
    try {
      await deleteFile(file.storageKey);
    } catch {
      /* ignore blob delete errors */
    }
    try {
      await db.cloudFile.delete({ where: { id: file.id } });
    } catch {
      /* may already be deleted by the cleanup cron */
    }
    return new NextResponse("Gone", { status: 410 });
  }

  // Permission check. If the file belongs to a cloud folder (classroom-owned),
  // resolve the classroom + classroom role and enforce visibility.
  const userRole = (session.user as any).role as UserRole;
  const userId = (session.user as any).id as string;

  let classroomRole: ClassroomRole | null = null;
  if (file.folderId) {
    const cid = await folderClassroomId(file.folderId);
    if (cid) {
      classroomRole =
        userRole === "ADMIN"
          ? "TEACHER"
          : await getClassroomRole(cid, userId);
    }
  }

  const allowed =
    // No classroom context (e.g. chat attachment) → any authenticated user.
    !file.folderId
      ? true
      : canViewFile(
          {
            id: file.id,
            visibility: file.visibility,
            uploadedBy: file.uploadedBy,
            folderId: file.folderId,
            grants: file.grants,
          },
          userId,
          userRole,
          classroomRole
        );

  if (!allowed) {
    return new NextResponse("Forbidden", { status: 403 });
  }

  const data = await getFile(key);
  if (!data) return new NextResponse("Not found", { status: 404 });

  // Decide Content-Disposition: inline for types that browsers can render
  // natively (images, PDFs, videos, audio, plain text, JSON, markdown, SVG)
  // so they can be embedded in <img>, <iframe>, <video>, <audio>, and fetched
  // for in-browser preview. Other types get `attachment` to download.
  const isInlineDisposition = (() => {
    if (file.mimetype.startsWith("image/")) return true;
    if (file.mimetype === "application/pdf") return true;
    if (file.mimetype.startsWith("video/")) return true;
    if (file.mimetype.startsWith("audio/")) return true;
    if (
      file.mimetype === "text/plain" ||
      file.mimetype === "text/markdown" ||
      file.mimetype === "application/json" ||
      file.mimetype.startsWith("text/")
    )
      return true;
    return false;
  })();

  const headers = new Headers();
  headers.set("Content-Type", file.mimetype);
  headers.set(
    "Content-Disposition",
    `${isInlineDisposition ? "inline" : "attachment"}; filename="${encodeURIComponent(
      file.name
    )}"`
  );
  headers.set("Cache-Control", "private, max-age=3600");
  // NextResponse requires a BodyInit — convert Buffer to a Uint8Array view
  // (shares the same underlying ArrayBuffer, no copy).
  return new NextResponse(new Uint8Array(data.bytes), { headers });
}
