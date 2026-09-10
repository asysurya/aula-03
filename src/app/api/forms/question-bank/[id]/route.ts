import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { errorResponse } from "@/lib/cloud-utils";

// DELETE /api/forms/question-bank/[id] — hapus soal dari bank pribadi.
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await requireUser().catch(() => null);
  if (!user) return errorResponse("UNAUTHORIZED", 401);
  if (user.role === "STUDENT") return errorResponse("FORBIDDEN", 403);

  const { id } = await params;

  const existing = await db.questionBank.findUnique({
    where: { id },
    select: { id: true, userId: true },
  });
  if (!existing) return errorResponse("NOT_FOUND", 404);
  if (existing.userId !== user.id) return errorResponse("FORBIDDEN", 403);

  await db.questionBank.delete({ where: { id } });
  return Response.json({ ok: true });
}
