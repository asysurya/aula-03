import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/session";
import { db } from "@/lib/db";
import { megaUpload, testMegaAccount, type MegaAccountLike } from "@/lib/mega-storage";
import { getFile, deleteLocal } from "@/lib/storage";

// POST /api/admin/cloud-accounts/sync-all
// Migrate ALL local-stored CloudFiles to MEGA, distributed across all active
// MEGA accounts (round-robin by lowest fileCount). This is the bulk "sync"
// operation: ensures every local file is moved to the cloud.
//
// Body: { limit?: number }  (default 100 per call)
export async function POST(req: Request) {
  await requireAdmin();

  let limit = 100;
  try {
    const body = await req.json().catch(() => ({}));
    if (typeof body?.limit === "number" && body.limit > 0 && body.limit <= 500) {
      limit = body.limit;
    }
  } catch {
    /* ignore */
  }

  const accounts = await db.cloudAccount.findMany({
    where: {
      provider: "mega",
      active: true,
      email: { not: null },
      password: { not: null },
      lastStatus: { not: "error" },
    },
    orderBy: { fileCount: "asc" },
    select: { id: true, email: true, password: true, fileCount: true },
  });

  if (accounts.length === 0) {
    return NextResponse.json({
      synced: 0,
      failed: 0,
      message: "Tidak ada akun MEGA aktif. Tambahkan akun MEGA dulu.",
    });
  }

  const localFiles = await db.cloudFile.findMany({
    where: {
      cloudAccountId: null,
      storageKey: { not: { startsWith: "mega:" } },
    },
    take: limit,
    orderBy: { createdAt: "asc" },
    select: { id: true, name: true, storageKey: true, mimetype: true, size: true },
  });

  if (localFiles.length === 0) {
    return NextResponse.json({
      synced: 0,
      failed: 0,
      message: "Tidak ada file lokal untuk disinkronkan.",
    });
  }

  let synced = 0;
  let failed = 0;
  const perAccount: Record<string, number> = {};

  for (let i = 0; i < localFiles.length; i++) {
    const file = localFiles[i];
    const account = accounts[i % accounts.length];
    const accountLike: MegaAccountLike = {
      id: account.id,
      email: account.email!,
      password: account.password!,
    };
    try {
      const data = await getFile(file.storageKey);
      if (!data) {
        failed++;
        continue;
      }
      const result = await megaUpload(accountLike, file.name, data.bytes, file.mimetype);
      await db.cloudFile.update({
        where: { id: file.id },
        data: { storageKey: result.storageKey, cloudAccountId: account.id },
      });
      await deleteLocal(file.storageKey).catch(() => {});
      perAccount[account.id] = (perAccount[account.id] ?? 0) + 1;
      synced++;
    } catch {
      failed++;
    }
  }

  // Bump fileCount per account.
  for (const accId of Object.keys(perAccount)) {
    try {
      await db.cloudAccount.update({
        where: { id: accId },
        data: { fileCount: { increment: perAccount[accId] } },
      });
    } catch {
      /* ignore */
    }
  }

  // Refresh quota for all accounts (best-effort).
  for (const account of accounts) {
    try {
      const result = await testMegaAccount(account.email!, account.password!);
      if (result.ok) {
        await db.cloudAccount.update({
          where: { id: account.id },
          data: {
            lastStatus: "connected",
            lastError: null,
            lastCheckedAt: new Date(),
            spaceTotal: result.spaceTotal ?? null,
            spaceUsed: result.spaceUsed ?? null,
          },
        });
      }
    } catch {
      /* ignore */
    }
  }

  return NextResponse.json({
    synced,
    failed,
    total: localFiles.length,
    accountsUsed: accounts.length,
    perAccount,
  });
}
