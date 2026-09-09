import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/session";
import { db } from "@/lib/db";
import { testMegaAccount } from "@/lib/mega-storage";
import { testS3Account } from "@/lib/s3-storage";
import { serializeCloudAccount } from "@/lib/cloud-account-serialize";

const createSchema = z
  .object({
    name: z.string().min(1).max(120),
    provider: z.enum(["mega", "s3"]).default("mega"),
    // Lenient email validation — accept any non-empty string with "@".
    // MEGA emails can have various formats; zod's strict .email() rejects some valid ones.
    email: z
      .string()
      .max(200)
      .optional()
      .refine((v) => !v || v.includes("@"), "Email tidak valid"),
    password: z.string().max(500).optional(),
    key: z.string().max(500).optional(),
    // ── S3-compatible ──
    endpoint: z.string().max(300).optional(),
    region: z.string().max(60).optional(),
    bucket: z.string().max(120).optional(),
    accessKeyId: z.string().max(200).optional(),
    secretAccessKey: z.string().max(200).optional(),
    testNow: z.boolean().optional(),
  })
  .refine(
    (v) =>
      v.provider !== "s3" ||
      (!!v.bucket && !!v.accessKeyId && !!v.secretAccessKey),
    {
      message: "Akun S3 wajib punya bucket, access key, dan secret key",
      path: ["bucket"],
    }
  )
  .refine((v) => v.provider !== "mega" || !!v.email || !!v.key, {
    message: "Akun MEGA wajib punya email",
    path: ["email"],
  });

export async function GET() {
  await requireAdmin();
  const rows = await db.cloudAccount.findMany({
    orderBy: [{ createdAt: "desc" }],
  });
  const accounts = rows.map((r) => serializeCloudAccount(r));
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
  const d = parsed.data;
  const { name, provider, testNow } = d;

  // Check if an account with the same email already exists.
  // If it does AND it's already connected, skip the login test (prevents MEGA rate-limit / EBLOCKED).
  if (d.email) {
    const existing = await db.cloudAccount.findFirst({
      where: { email: d.email, provider },
      select: { id: true, lastStatus: true, name: true },
    });
    if (existing) {
      return NextResponse.json(
        {
          error: `Akun dengan email ini sudah ada: "${existing.name}" (status: ${existing.lastStatus}). Hapus akun lama dulu kalau mau menambah ulang.`,
        },
        { status: 409 }
      );
    }
  }

  const row = await db.cloudAccount.create({
    data: {
      name,
      provider,
      email: d.email && d.email.length > 0 ? d.email : null,
      password: d.password && d.password.length > 0 ? d.password : null,
      key: d.key && d.key.length > 0 ? d.key : null,
      endpoint: d.endpoint && d.endpoint.length > 0 ? d.endpoint : null,
      region: d.region && d.region.length > 0 ? d.region : null,
      bucket: d.bucket && d.bucket.length > 0 ? d.bucket : null,
      accessKeyId:
        d.accessKeyId && d.accessKeyId.length > 0 ? d.accessKeyId : null,
      secretAccessKey:
        d.secretAccessKey && d.secretAccessKey.length > 0
          ? d.secretAccessKey
          : null,
      lastStatus: testNow ? "checking" : "unknown",
    },
  });

  // Optionally test the account immediately (best-effort) — status di-update
  // jujur baik sukses maupun gagal.
  if (testNow) {
    if (row.provider === "s3") {
      const result = await testS3Account({
        id: row.id,
        endpoint: row.endpoint,
        region: row.region,
        bucket: row.bucket,
        accessKeyId: row.accessKeyId,
        secretAccessKey: row.secretAccessKey,
      });
      await db.cloudAccount.update({
        where: { id: row.id },
        data: {
          lastStatus: result.ok ? "connected" : "error",
          lastError: result.ok ? null : result.error ?? null,
          lastCheckedAt: new Date(),
        },
      });
    } else if (row.email && row.password) {
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
  }

  const fresh = await db.cloudAccount.findUnique({ where: { id: row.id } });
  return NextResponse.json(
    {
      account: fresh ? serializeCloudAccount(fresh) : null,
    },
    { status: 201 }
  );
}
