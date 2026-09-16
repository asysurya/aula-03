import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import {
  errorResponse,
  folderClassroomId,
  getClassroomRole,
  isClassroomMember,
} from "@/lib/cloud-utils";

// ── Rekaman pengerjaan tugas (toggle guru Form.recordWork) ──────────
// GET   /api/cloud/assignments/[folderId]/form/recordings/[recordingId]
//       ?after=<seq>&limit=<n> → guru: meta terbaru + frame setelah seq
//       (live polling: after=lastSeq; putar ulang: batch bertahap).
// POST  /…/[recordingId]  { html } → siswa pemilik: tambah frame baru
//       (seq ditentukan SERVER — monotonic, bebas race client).
// PATCH /…/[recordingId]  → siswa pemilik: tandai selesai (SAVED).
//       Submit attempt juga men-SAVED-kan rekaman di server (jaminan
//       bila client mati sebelum sempat memanggil PATCH).

/** Batas keras satu frame (karakter) — snapshot wajar 5–40 KB. */
const MAX_FRAME_HTML = 300_000;
/** Batas jumlah frame per rekaman (± 2 jam @ 1 frame/10 dtk). */
const MAX_FRAMES = 720;
/** Maks frame per response GET (putar ulang memuat bertahap). */
const MAX_PAGE = 50;

/** Sanitasi sisi SERVER (pertahanan kedua — client sudah mensanitasi):
 *  buang blok <script>, atribut on*, dan URL javascript:. */
function sanitizeRecordingHtml(raw: string): string {
  return raw
    .replace(/<script[\s\S]*?<\/script\s*>/gi, "")
    .replace(/<script[^>]*>/gi, "")
    .replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, "")
    .replace(/\son[a-z]+\s*=\s*'[^']*'/gi, "")
    .replace(/\son[a-z]+\s*=\s*[^\s>]+/gi, "")
    .replace(/javascript\s*:/gi, "");
}

function recordingDto(r: {
  id: string;
  status: string;
  startedAt: Date;
  finishedAt: Date | null;
  frameCount: number;
  lastSeq: number;
  lastFrameAt: Date | null;
  faceOk: boolean | null;
  camOff: boolean | null;
}) {
  return {
    id: r.id,
    status: r.status as "LIVE" | "SAVED",
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    frameCount: r.frameCount,
    lastSeq: r.lastSeq,
    lastFrameAt: r.lastFrameAt,
    faceOk: r.faceOk,
    camOff: r.camOff,
  };
}

async function loadContext(folderId: string) {
  const assignment = await db.assignment.findUnique({
    where: { folderId },
    select: { id: true },
  });
  if (!assignment) return { error: "ASSIGNMENT_NOT_FOUND" as const };
  const form = await db.form.findUnique({
    where: { assignmentId: assignment.id },
    select: { id: true },
  });
  if (!form) return { error: "FORM_NOT_FOUND" as const };
  const classroomId = await folderClassroomId(folderId);
  if (!classroomId) return { error: "FOLDER_NO_CLASSROOM" as const };
  return { formId: form.id, classroomId };
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ folderId: string; recordingId: string }> }
) {
  const user = await requireUser().catch(() => null);
  if (!user) return errorResponse("UNAUTHORIZED", 401);

  const { folderId, recordingId } = await params;
  const ctx = await loadContext(folderId);
  if ("error" in ctx) return errorResponse(ctx.error, 404);
  const { classroomId } = ctx;

  const myRole =
    user.role === "ADMIN"
      ? "TEACHER"
      : await getClassroomRole(classroomId, user.id);
  if (myRole !== "TEACHER") return errorResponse("FORBIDDEN", 403);

  const rec = await db.formRecording.findUnique({ where: { id: recordingId } });
  if (!rec || rec.formId !== ctx.formId)
    return errorResponse("RECORDING_NOT_FOUND", 404);

  const url = new URL(req.url);
  const after = Math.max(0, parseInt(url.searchParams.get("after") ?? "0", 10) || 0);
  const limit = Math.min(
    MAX_PAGE,
    Math.max(1, parseInt(url.searchParams.get("limit") ?? "30", 10) || 30)
  );

  const frames = await db.formRecordingFrame.findMany({
    where: { recordingId: rec.id, seq: { gt: after } },
    orderBy: { seq: "asc" },
    take: limit,
  });

  return Response.json({
    recording: recordingDto(rec),
    frames: frames.map((f) => ({
      seq: f.seq,
      html: f.html,
      capturedAt: f.capturedAt,
    })),
    hasMore: frames.length === limit,
  });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ folderId: string; recordingId: string }> }
) {
  const user = await requireUser().catch(() => null);
  if (!user) return errorResponse("UNAUTHORIZED", 401);

  const { folderId, recordingId } = await params;
  const ctx = await loadContext(folderId);
  if ("error" in ctx) return errorResponse(ctx.error, 404);
  const { classroomId } = ctx;

  if (user.role !== "ADMIN" && !(await isClassroomMember(classroomId, user.id)))
    return errorResponse("FORBIDDEN", 403);

  const rec = await db.formRecording.findUnique({ where: { id: recordingId } });
  if (!rec || rec.formId !== ctx.formId)
    return errorResponse("RECORDING_NOT_FOUND", 404);
  if (rec.userId !== user.id) return errorResponse("FORBIDDEN", 403);
  if (rec.status !== "LIVE") return errorResponse("RECORDING_SAVED", 409);

  // Rekaman hanya mengalir selama attempt masih berjalan.
  const attempt = await db.formAttempt.findUnique({
    where: { formId_userId: { formId: ctx.formId, userId: user.id } },
    select: { status: true },
  });
  if (!attempt || attempt.status !== "IN_PROGRESS")
    return errorResponse("ATTEMPT_ALREADY_SUBMITTED", 409);

  const body = await req.json().catch(() => null);
  const htmlRaw = typeof body?.html === "string" ? body.html : "";
  if (!htmlRaw.trim()) return errorResponse("FRAME_REQUIRED", 400);
  // Status wajah PiP (kamera rekaman) — dikirim bersama frame oleh
  // client setelah izin kamera settle; undefined = tanpa info.
  const faceOk = typeof body?.faceOk === "boolean" ? body.faceOk : undefined;
  const camOff = typeof body?.camOff === "boolean" ? body.camOff : undefined;

  const html = sanitizeRecordingHtml(htmlRaw);
  if (html.length > MAX_FRAME_HTML)
    return errorResponse("FRAME_TOO_LARGE", 413);

  // Batas jumlah frame: rekaman panjang berhenti diam-diam (client tak
  // perlu error — pengerjaan jalan normal, hanya tidak terekam lagi).
  if (rec.frameCount >= MAX_FRAMES)
    return Response.json({ ok: true, seq: null, capped: true });

  const seq = rec.lastSeq + 1;
  await db.formRecordingFrame.create({
    data: { recordingId: rec.id, seq, html },
  });
  const updated = await db.formRecording.update({
    where: { id: rec.id },
    data: {
      frameCount: { increment: 1 },
      lastSeq: seq,
      lastFrameAt: new Date(),
      ...(faceOk !== undefined || camOff !== undefined
        ? { faceOk: faceOk ?? false, camOff: camOff ?? false }
        : {}),
    },
  });

  return Response.json({
    ok: true,
    seq,
    frameCount: updated.frameCount,
    capped: updated.frameCount >= MAX_FRAMES,
  });
}

export async function PATCH(
  _req: NextRequest,
  { params }: { params: Promise<{ folderId: string; recordingId: string }> }
) {
  const user = await requireUser().catch(() => null);
  if (!user) return errorResponse("UNAUTHORIZED", 401);

  const { folderId, recordingId } = await params;
  const ctx = await loadContext(folderId);
  if ("error" in ctx) return errorResponse(ctx.error, 404);
  const { classroomId } = ctx;

  if (user.role !== "ADMIN" && !(await isClassroomMember(classroomId, user.id)))
    return errorResponse("FORBIDDEN", 403);

  const rec = await db.formRecording.findUnique({ where: { id: recordingId } });
  if (!rec || rec.formId !== ctx.formId)
    return errorResponse("RECORDING_NOT_FOUND", 404);
  if (rec.userId !== user.id) return errorResponse("FORBIDDEN", 403);
  if (rec.status !== "LIVE") return Response.json({ ok: true, recording: recordingDto(rec) });

  const updated = await db.formRecording.update({
    where: { id: rec.id },
    data: { status: "SAVED", finishedAt: new Date() },
  });
  return Response.json({ ok: true, recording: recordingDto(updated) });
}
