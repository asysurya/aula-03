import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/session";
import { db } from "@/lib/db";
import { megaUpload } from "@/lib/mega-storage";
import { deleteLocal } from "@/lib/storage";
import type { MegaAccountLike } from "@/lib/mega-storage";

// POST /api/admin/cloud-accounts/[id]/sync
// Migrate local-stored CloudFiles (storageKey without "mega:" prefix,
// cloudAccountId === null) to this MEGA account. Walks all local files,
// uploads each to MEGA, updates the CloudFile row (storageKey → mega:...,
// cloudAccountId → this account), then deletes the local blob.
//
// This is the "sync" feature: ensures files are moved from local (z.ai space)
// to the configured MEGA cloud account.
//
// Body: { limit?: number }  (default 50 per call to avoid timeouts)
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  await requireAdmin();
  const { id } = await params;

  const account = await db.cloudAccount.findUnique({ where: { id } });
  if (!account) {
    return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
  }
  if (account.provider !== "mega") {
    return NextResponse.json(
      { error: "Sync hanya untuk akun MEGA" },
      { status: 400 }
    );
  }
  if (!account.email || !account.password) {
    return NextResponse.json(
      { error: "Email/password MEGA belum diisi" },
      { status: 400 }
    );
  }

  let limit = 50;
  try {
    const body = await req.json().catch(() => ({}));
    if (typeof body?.limit === "number" && body.limit > 0 && body.limit <= 200) {
      limit = body.limit;
    }
  } catch {
    /* ignore */
  }

  // Find local-stored CloudFiles (not already on MEGA, no expiry pending).
  const localFiles = await db.cloudFile.findMany({
    where: {
      cloudAccountId: null,
      storageKey: { not: { startsWith: "mega:" } },
    },
    take: limit,
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      name: true,
      storageKey: true,
      mimetype: true,
      size: true,
    },
  });

  if (localFiles.length === 0) {
    return NextResponse.json({
      synced: 0,
      skipped: 0,
      failed: 0,
      message: "Tidak ada file lokal untuk disinkronkan.",
    });
  }

  const accountLike: MegaAccountLike = {
    id: account.id,
    email: account.email,
    password: account.password,
    sessionData: account.sessionData,
  };

  let synced = 0;
  let failed = 0;
  const failedIds: string[] = [];

  for (const file of localFiles) {
    try {
      // Read local bytes.
      const { getFile } = await import("@/lib/storage");
      const data = await getFile(file.storageKey);
      if (!data) {
        // Local file missing — mark as failed, skip.
        failed++;
        failedIds.push(file.id);
        continue;
      }
      // Upload to MEGA.
      const result = await megaUpload(
        accountLike,
        file.name,
        data.bytes,
        file.mimetype
      );
      // Update CloudFile row: storageKey → mega:..., cloudAccountId → this.
      await db.cloudFile.update({
        where: { id: file.id },
        data: {
          storageKey: result.storageKey,
          cloudAccountId: account.id,
        },
      });
      // Delete local blob (best-effort).
      await deleteLocal(file.storageKey).catch(() => {});
      synced++;
    } catch {
      failed++;
      failedIds.push(file.id);
      // Continue with next file.
    }
  }

  // Bump fileCount + refresh space info (best-effort, non-blocking).
  try {
    await db.cloudAccount.update({
      where: { id: account.id },
      data: { fileCount: { increment: synced } },
    });
  } catch {
    /* ignore */
  }

  // Re-test quota after sync (best-effort) — status di-update jujur
  // (sukses ATAU gagal) supaya panel tidak menampilkan status basi.
  try {
    const { testMegaAccount } = await import("@/lib/mega-storage");
    const result = await testMegaAccount(account.email, account.password);
    await db.cloudAccount.update({
      where: { id: account.id },
      data: {
        lastStatus: result.ok ? "connected" : "error",
        lastError: result.ok ? null : result.error ?? null,
        lastCheckedAt: new Date(),
        spaceTotal: result.ok ? result.spaceTotal ?? null : null,
        spaceUsed: result.ok ? result.spaceUsed ?? null : null,
      },
    });
  } catch {
    /* ignore */
  }

  return NextResponse.json({
    synced,
    skipped: 0,
    failed,
    failedIds,
    total: localFiles.length,
  });
}
