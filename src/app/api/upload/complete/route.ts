import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import {
  uploadCloudFileAction,
  uploadSubmissionAction,
  uploadMegaFileAction,
  uploadAttachmentAction,
  uploadAvatarAction,
  uploadFormImageAction,
  uploadAnswerFileAction,
  type SessionUser,
  type UploadBytes,
} from "@/lib/upload-actions";

// POST /api/upload/complete — rakit chunk jadi file utuh lalu jalankan
// logika upload TUJUAN yang sama dengan endpoint aslinya.
//
// Body (JSON): {
//   uploadId: string,
//   target: {
//     kind: "cloud-file" | "submission" | "mega" | "attachment" | "avatar"
//          | "form-image" | "answer-file",
//     ...parameter khusus tujuan (folderId / assignmentId / note / dll.)
//   }
// }
//
// Response & status code IDENTIK dengan endpoint tujuan aslinya —
// client tidak perlu tahu bedanya.

export const runtime = "nodejs";
export const maxDuration = 60;

const targetSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("cloud-file"),
    folderId: z.string().optional().nullable(),
    classroomId: z.string().optional().nullable(),
    visibility: z.string().optional().nullable(),
  }),
  z.object({
    kind: z.literal("submission"),
    assignmentId: z.string().min(1),
    note: z.string().max(2000).optional().nullable(),
  }),
  z.object({
    kind: z.literal("mega"),
    parentId: z.string().optional().nullable(),
    accountId: z.string().optional().nullable(),
  }),
  z.object({
    kind: z.literal("attachment"),
    convKind: z.enum(["classroom", "group", "dm"]),
    convId: z.string().min(1),
  }),
  z.object({ kind: z.literal("avatar") }),
  z.object({
    kind: z.literal("form-image"),
    folderId: z.string().min(1),
  }),
  z.object({
    kind: z.literal("answer-file"),
    folderId: z.string().min(1),
    questionId: z.string().min(1),
  }),
]);

const completeSchema = z.object({
  uploadId: z.string().min(1),
  target: targetSchema,
});

async function cleanupSession(sessionId: string): Promise<void> {
  try {
    // Chunk ikut terhapus (onDelete: Cascade).
    await db.uploadSession.delete({ where: { id: sessionId } });
  } catch {
    /* best-effort */
  }
}

export async function POST(req: NextRequest) {
  const user = await requireUser().catch(() => null);
  if (!user || !user.id) {
    return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "INVALID_JSON" }, { status: 400 });
  }
  const parsed = completeSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Data tidak valid" },
      { status: 400 }
    );
  }
  const { uploadId, target } = parsed.data;

  const session = await db.uploadSession.findUnique({
    where: { id: uploadId },
  });
  if (!session) {
    return NextResponse.json({ error: "SESSION_NOT_FOUND" }, { status: 404 });
  }
  if (session.uploadedBy !== user.id) {
    return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });
  }
  if (session.expiresAt.getTime() < Date.now()) {
    await cleanupSession(session.id);
    return NextResponse.json({ error: "SESSION_EXPIRED" }, { status: 410 });
  }

  // Rakit file dari chunk (urut idx).
  const chunks = await db.uploadChunk.findMany({
    where: { sessionId: session.id },
    orderBy: { idx: "asc" },
    select: { idx: true, data: true },
  });
  if (chunks.length !== session.chunkCount) {
    return NextResponse.json(
      {
        error: "CHUNKS_INCOMPLETE",
        received: chunks.length,
        total: session.chunkCount,
      },
      { status: 400 }
    );
  }
  for (let i = 0; i < chunks.length; i++) {
    if (chunks[i].idx !== i) {
      return NextResponse.json(
        { error: "CHUNKS_INCOMPLETE", missing: i },
        { status: 400 }
      );
    }
  }

  const totalBytes = chunks.reduce((acc, c) => acc + c.data.length, 0);
  if (totalBytes !== session.size) {
    return NextResponse.json(
      { error: "SIZE_MISMATCH", expected: session.size, received: totalBytes },
      { status: 400 }
    );
  }

  const file: UploadBytes = {
    name: session.name,
    mimetype: session.mimetype,
    size: session.size,
    bytes: Buffer.concat(chunks.map((c) => c.data)),
  };

  // Bersihkan staging SEBELUM aksi (file sudah dirakit di memori) supaya
  // sesi tidak menggantung bila aksi lama (upload MEGA bisa ±menit).
  await cleanupSession(session.id);

  const sessionUser = user as SessionUser;
  let result: { status: number; body: unknown };
  switch (target.kind) {
    case "cloud-file":
      result = await uploadCloudFileAction(sessionUser, file, {
        folderId: target.folderId ?? null,
        classroomId: target.classroomId ?? null,
        visibility: target.visibility ?? null,
      });
      break;
    case "submission":
      result = await uploadSubmissionAction(sessionUser, file, {
        assignmentId: target.assignmentId,
        note: target.note ?? null,
      });
      break;
    case "mega":
      result = await uploadMegaFileAction(sessionUser, file, {
        parentId: target.parentId ?? null,
        accountId: target.accountId ?? null,
      });
      break;
    case "attachment":
      result = await uploadAttachmentAction(sessionUser, file, {
        kind: target.convKind,
        id: target.convId,
      });
      break;
    case "avatar":
      result = await uploadAvatarAction(sessionUser, file);
      break;
    case "form-image":
      result = await uploadFormImageAction(sessionUser, file, {
        folderId: target.folderId,
      });
      break;
    case "answer-file":
      result = await uploadAnswerFileAction(sessionUser, file, {
        folderId: target.folderId,
        questionId: target.questionId,
      });
      break;
    default:
      return NextResponse.json({ error: "UNKNOWN_TARGET" }, { status: 400 });
  }

  return NextResponse.json(result.body, { status: result.status });
}
