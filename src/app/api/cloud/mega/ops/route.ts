import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import {
  megaMkdir,
  megaRename,
  megaMove,
  megaDeleteNode,
  megaCollectDescendantKeys,
  describeMegaError,
  type MegaAccountLike,
} from "@/lib/mega-storage";
import { hardDeleteCloudFilesByIds } from "@/lib/hard-delete";

// POST /api/cloud/mega/ops
//
// Operasi full-akses pada mount MEGA Cloud (guru/admin):
//   { action: "mkdir",  accountId?, parentNodeId?, name }
//   { action: "rename", accountId?, nodeId, name }
//   { action: "move",   accountId?, nodeId, targetParentId }
//   { action: "delete", accountId?, nodeId }
//
// "delete" bersifat PERMANEN (hard delete): node MEGA dihapus + semua baris
// CloudFile yang menunjuk node itu (atau turunannya) ikut dihapus bersama
// referensinya (MessageAttachment, FormAnswer, Submission, FileAccess…).

const nameSchema = z
  .string()
  .trim()
  .min(1, "Nama tidak boleh kosong")
  .max(120, "Nama maksimal 120 karakter")
  .refine((v) => !/[\r\n\0]/.test(v), "Nama mengandung karakter terlarang");

const opsSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("mkdir"),
    accountId: z.string().optional(),
    parentNodeId: z.string().nullable().optional(),
    name: nameSchema,
  }),
  z.object({
    action: z.literal("rename"),
    accountId: z.string().optional(),
    nodeId: z.string().min(1),
    name: nameSchema,
  }),
  z.object({
    action: z.literal("move"),
    accountId: z.string().optional(),
    nodeId: z.string().min(1),
    targetParentId: z.string().nullable().optional(),
  }),
  z.object({
    action: z.literal("delete"),
    accountId: z.string().optional(),
    nodeId: z.string().min(1),
  }),
]);

async function pickAccount(
  accountId?: string
): Promise<MegaAccountLike | null> {
  const account = accountId
    ? await db.cloudAccount.findFirst({
        where: { id: accountId, provider: "mega", email: { not: null } },
        select: {
          id: true,
          email: true,
          password: true,
          sessionData: true,
        },
      })
    : await db.cloudAccount.findFirst({
        where: {
          provider: "mega",
          active: true,
          email: { not: null },
          lastStatus: { not: "error" },
        },
        orderBy: { fileCount: "asc" },
        select: {
          id: true,
          email: true,
          password: true,
          sessionData: true,
        },
      });
  return account;
}

export async function POST(req: NextRequest) {
  const user = await requireUser().catch(() => null);
  if (!user) {
    return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
  }
  const role = (user as { role?: string }).role;
  if (role !== "ADMIN" && role !== "GURU") {
    return NextResponse.json(
      { error: "FORBIDDEN — hanya guru/admin yang dapat mengelola MEGA Cloud" },
      { status: 403 }
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "INVALID_JSON" }, { status: 400 });
  }
  const parsed = opsSchema.safeParse(body);
  if (!parsed.success) {
    const first =
      parsed.error.issues[0]?.message ?? "Data operasi tidak valid";
    return NextResponse.json({ error: first }, { status: 400 });
  }
  const op = parsed.data;

  const account = await pickAccount("accountId" in op ? op.accountId : undefined);
  if (!account || !account.email) {
    return NextResponse.json(
      { error: "Belum ada akun MEGA aktif." },
      { status: 404 }
    );
  }

  try {
    switch (op.action) {
      case "mkdir": {
        const res = await megaMkdir(
          account,
          op.parentNodeId ?? null,
          op.name
        );
        return NextResponse.json({ ok: true, nodeId: res.nodeId });
      }
      case "rename": {
        await megaRename(account, op.nodeId, op.name);
        return NextResponse.json({ ok: true });
      }
      case "move": {
        await megaMove(account, op.nodeId, op.targetParentId ?? null);
        return NextResponse.json({ ok: true });
      }
      case "delete": {
        // Kumpulkan semua storageKey yang akan mati (node + turunan)
        // SEBELUM node dihapus, lalu bersihkan baris CloudFile terkait.
        const keys = await megaCollectDescendantKeys(account, op.nodeId);
        await megaDeleteNode(account, op.nodeId);
        if (keys.length > 0) {
          const rows = await db.cloudFile.findMany({
            where: { storageKey: { in: keys } },
            select: { id: true },
          });
          if (rows.length > 0) {
            await hardDeleteCloudFilesByIds(rows.map((r) => r.id));
          }
        }
        return NextResponse.json({ ok: true, cleanedFiles: keys.length });
      }
    }
  } catch (e) {
    return NextResponse.json(
      { error: `Operasi MEGA gagal: ${describeMegaError(e)}` },
      { status: 502 }
    );
  }
}
