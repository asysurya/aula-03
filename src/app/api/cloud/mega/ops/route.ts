import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { fileCacheDelete } from "@/lib/file-cache";
import { canWriteMount } from "@/lib/mount-access";
import {
  megaMkdir,
  megaRename,
  megaMove,
  megaDeleteNode,
  megaCollectDescendantKeys,
  megaCopyNode,
  describeMegaError,
} from "@/lib/mega-storage";
import { hardDeleteCloudFilesByIds } from "@/lib/hard-delete";

// POST /api/cloud/mega/ops
//
// Operasi full-akses pada mount MEGA Cloud:
//   { action: "mkdir",  accountId?, parentNodeId?, name }
//   { action: "rename", accountId?, nodeId, name }
//   { action: "move",   accountId?, nodeId, targetParentId }
//   { action: "copy",   accountId?, nodeId, targetParentId, name? }
//   { action: "delete", accountId?, nodeId }
//
// Hak akses: akun harus mountMode=WRITE untuk user ini (diatur di Admin
// Panel). Mount baca-saja (READ) menolak semua operasi tulis.
//
// "delete" bersifat PERMANEN (hard delete): node MEGA dihapus + semua baris
// CloudFile yang menunjuk node itu (atau turunannya) ikut dihapus bersama
// referensinya (MessageAttachment, FormAnswer, Submission, FileAccess…).
// "copy" menyalin file/folder (rekursif) ke folder tujuan — server-side.

export const runtime = "nodejs";
export const maxDuration = 60;

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
    action: z.literal("copy"),
    accountId: z.string().optional(),
    nodeId: z.string().min(1),
    targetParentId: z.string().nullable().optional(),
    name: nameSchema.optional(),
  }),
  z.object({
    action: z.literal("delete"),
    accountId: z.string().optional(),
    nodeId: z.string().min(1),
  }),
]);

/** Ambil akun + field hak akses mount (untuk pengececan mode baca/tulis). */
async function pickAccountWithAccess(accountId?: string) {
  const select = {
    id: true,
    email: true,
    password: true,
    sessionData: true,
    mountVisibleTo: true,
    mountMode: true,
  };
  return accountId
    ? db.cloudAccount.findFirst({
        where: { id: accountId, provider: "mega", email: { not: null } },
        select,
      })
    : db.cloudAccount.findFirst({
        where: {
          provider: "mega",
          active: true,
          email: { not: null },
          lastStatus: { not: "error" },
        },
        orderBy: { fileCount: "asc" },
        select,
      });
}

export async function POST(req: NextRequest) {
  const user = await requireUser().catch(() => null);
  if (!user) {
    return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
  }
  const role = (user as { role?: string }).role;

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

  const account = await pickAccountWithAccess(
    "accountId" in op ? op.accountId : undefined
  );
  if (!account || !account.email) {
    return NextResponse.json(
      { error: "Belum ada akun MEGA aktif." },
      { status: 404 }
    );
  }

  // ── Hak akses mount: operasi tulis hanya untuk mode READ+WRITE ──
  if (!canWriteMount(account, role)) {
    return NextResponse.json(
      {
        error:
          "Mount ini baca-saja untukmu (hak akses diatur admin di Admin Panel → Data & Cloud).",
      },
      { status: 403 }
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
      case "copy": {
        const res = await megaCopyNode(
          account,
          op.nodeId,
          op.targetParentId ?? null,
          op.name ? { name: op.name } : undefined
        );
        return NextResponse.json({
          ok: true,
          nodeId: res.nodeId,
          copiedCount: res.copiedCount,
        });
      }
      case "delete": {
        // Kumpulkan semua storageKey yang akan mati (node + turunan)
        // SEBELUM node dihapus, lalu bersihkan baris CloudFile terkait.
        const keys = await megaCollectDescendantKeys(account, op.nodeId);
        await megaDeleteNode(account, op.nodeId);
        // Evict LRU cache blob untuk node mentah yang dihapus.
        for (const k of keys) fileCacheDelete(k);
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
    const msg = e instanceof Error ? e.message : String(e);
    const friendly = /MEGA_CANNOT_COPY_INTO_SELF/.test(msg)
      ? "Tidak bisa menyalin folder ke dalam dirinya sendiri."
      : /MEGA_CANNOT_COPY_ROOT/.test(msg)
        ? "Folder root MEGA tidak bisa disalin."
        : /MEGA_COPY_TOO_MANY_ITEMS/.test(msg)
          ? "Terlalu banyak item untuk disalin sekaligus (maks 500)."
          : /MEGA_COPY_TOO_LARGE/.test(msg)
            ? "Total ukuran terlalu besar untuk disalin sekaligus (maks 2 GB)."
            : /MEGA_FOLDER_NOT_FOUND/.test(msg)
              ? "Folder tujuan tidak ditemukan di MEGA."
              : /MEGA_NODE_NOT_FOUND/.test(msg)
                ? "Item tidak ditemukan di MEGA (mungkin sudah dihapus). Muat ulang lalu coba lagi."
                : describeMegaError(e);
    return NextResponse.json(
      { error: `Operasi MEGA gagal: ${friendly}` },
      { status: 502 }
    );
  }
}
