import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/session";
import { db } from "@/lib/db";
import { testMegaAccount } from "@/lib/mega-storage";

const createSchema = z.object({
  name: z.string().min(1).max(120),
  provider: z.string().min(1).max(40).default("mega"),
  // Lenient email validation — accept any non-empty string with "@".
  // MEGA emails can have various formats; zod's strict .email() rejects some valid ones.
  email: z
    .string()
    .max(200)
    .optional()
    .refine((v) => !v || v.includes("@"), "Email tidak valid"),
  password: z.string().max(500).optional(),
  key: z.string().max(500).optional(),
  testNow: z.boolean().optional(),
});

function serialize(account: {
  id: string;
  name: string;
  provider: string;
  email: string | null;
  hasPassword: boolean;
  hasKey: boolean;
  active: boolean;
  lastStatus: string;
  lastCheckedAt: Date | null;
  lastError: string | null;
  spaceTotal: number | null;
  spaceUsed: number | null;
  fileCount: number;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: account.id,
    name: account.name,
    provider: account.provider,
    email: account.email,
    hasPassword: account.hasPassword,
    hasKey: account.hasKey,
    active: account.active,
    lastStatus: account.lastStatus,
    lastCheckedAt: account.lastCheckedAt,
    lastError: account.lastError,
    spaceTotal: account.spaceTotal,
    spaceUsed: account.spaceUsed,
    fileCount: account.fileCount,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  };
}

export async function GET() {
  await requireAdmin();
  const rows = await db.cloudAccount.findMany({
    orderBy: [{ createdAt: "desc" }],
  });
  const accounts = rows.map((r) =>
    serialize({
      ...r,
      hasPassword: !!r.password,
      hasKey: !!r.key,
    })
  );
  return NextResponse.json({ accounts });
}

export async function POST(req: NextRequest) {
  await requireAdmin();
  const body = await req.json();
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    // Extract field-level error messages so the frontend can show
    // the user exactly which field is invalid.
    const fieldErrors: Record<string, string[]> = parsed.error.flatten().fieldErrors;
    const firstError =
      Object.values(fieldErrors).flat()[0] || "Data tidak valid";
    return NextResponse.json(
      { error: firstError, details: fieldErrors },
      { status: 400 }
    );
  }
  const { name, provider, email, password, key, testNow } = parsed.data;

  // Check if an account with the same email already exists.
  // If it does AND it's already connected, skip the login test (prevents MEGA rate-limit / EBLOCKED).
  if (email) {
    const existing = await db.cloudAccount.findFirst({
      where: { email, provider },
      select: { id: true, lastStatus: true, name: true },
    });
    if (existing) {
      return NextResponse.json(
        {
          error: `Akun MEGA dengan email ini sudah ada: "${existing.name}" (status: ${existing.lastStatus}). Hapus akun lama dulu kalau mau menambah ulang.`,
        },
        { status: 409 }
      );
    }
  }

  const row = await db.cloudAccount.create({
    data: {
      name,
      provider,
      email: email && email.length > 0 ? email : null,
      password: password && password.length > 0 ? password : null,
      key: key && key.length > 0 ? key : null,
      lastStatus: testNow ? "checking" : "unknown",
    },
  });

  // Optionally test the account immediately (best-effort).
  if (testNow && row.email && row.password) {
    const result = await testMegaAccount(row.email, row.password);
    await db.cloudAccount.update({
      where: { id: row.id },
      data: {
        lastStatus: result.ok ? "connected" : "error",
        lastError: result.ok ? null : result.error ?? null,
        lastCheckedAt: new Date(),
        spaceTotal: result.spaceTotal ?? null,
        spaceUsed: result.spaceUsed ?? null,
      },
    });
  }

  const fresh = await db.cloudAccount.findUnique({ where: { id: row.id } });
  return NextResponse.json(
    {
      account: fresh
        ? serialize({
            ...fresh,
            hasPassword: !!fresh.password,
            hasKey: !!fresh.key,
          })
        : null,
    },
    { status: 201 }
  );
}
