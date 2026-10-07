import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/session";
import { db } from "@/lib/db";
import { encryptSecret, decryptSecret } from "@/lib/crypto";
import { PROVIDER_IDS, maskKey, resolveAiConfig } from "@/lib/ai-providers";
import { FALLBACKS_KEY } from "@/lib/ai-config-chain";

// ─────────────────────────────────────────────────────────────────────
// GET/PUT /api/admin/ai-builder — default provider AI BUILDER (Pusat
// Belajar → tab AI Builder). Provider ini DIPISAH dari Teman AI.
// Disimpan di AppSetting key "ai.builder":
//   { provider, baseUrl, apiKeyEnc (AES-256-GCM), model }
// Task 29: panel admin baru memakai /api/admin/ai dengan { category,
// entries } (AppSetting "ai.fallbacks"). Route LEGACY ini tetap berfungsi
// dan MENYINGKIRKAN fallbacks.builder supaya tidak saling menaungi
// (fallbacks dibaca lebih dulu oleh resolveChain).
// Kunci asli tidak pernah dikirim balik — hanya hasKey + keyMask.
// ─────────────────────────────────────────────────────────────────────

const SETTING_KEY = "ai.builder";

/** Hapus kategori <cat> dari AppSetting ai.fallbacks (bila ada). */
async function clearFallbackCategory(cat: "chat" | "builder" | "vision") {
  const row = await db.appSetting.findUnique({ where: { key: FALLBACKS_KEY } });
  if (!row) return;
  try {
    const parsed = JSON.parse(row.value) as Record<string, unknown>;
    if (!(cat in parsed)) return;
    delete parsed[cat];
    await db.appSetting.update({
      where: { key: FALLBACKS_KEY },
      data: { value: JSON.stringify(parsed) },
    });
  } catch {
    /* biarkan */
  }
}

async function readDefault() {
  const row = await db.appSetting.findUnique({ where: { key: SETTING_KEY } });
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.value) as {
      provider?: string;
      baseUrl?: string | null;
      apiKeyEnc?: string | null;
      model?: string | null;
    };
    return {
      provider: parsed.provider ?? "",
      baseUrl: parsed.baseUrl ?? null,
      apiKeyEnc: parsed.apiKeyEnc ?? null,
      model: parsed.model ?? null,
    };
  } catch {
    return null;
  }
}

export async function GET() {
  const admin = await requireAdmin().catch(() => null);
  if (!admin) return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });

  const def = await readDefault();
  const key = decryptSecret(def?.apiKeyEnc ?? null);
  const usable = !!resolveAiConfig(
    null,
    def
      ? {
          provider: def.provider,
          baseUrl: def.baseUrl,
          apiKey: key,
          model: def.model,
        }
      : null
  );

  return NextResponse.json({
    provider: def?.provider ?? "",
    baseUrl: def?.baseUrl ?? null,
    model: def?.model ?? null,
    hasKey: !!key,
    keyMask: maskKey(key),
    usable,
  });
}

const putSchema = z.object({
  provider: z.enum(["", ...PROVIDER_IDS] as [string, ...string[]]),
  baseUrl: z
    .string()
    .trim()
    .max(300)
    .refine((v) => v === "" || /^https?:\/\/.+/i.test(v), "Base URL harus mulai http:// atau https://")
    .optional()
    .nullable(),
  model: z.string().trim().max(200).optional().nullable(),
  apiKey: z.string().max(400).optional().nullable(),
  clearKey: z.boolean().optional(),
});

export async function PUT(req: NextRequest) {
  const admin = await requireAdmin().catch(() => null);
  if (!admin) return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Data tidak valid" }, { status: 400 });
  }
  const parsed = putSchema.safeParse(body);
  if (!parsed.success) {
    const first = parsed.error.issues[0]?.message ?? "Data tidak valid";
    return NextResponse.json({ error: first }, { status: 400 });
  }
  const d = parsed.data;

  const existing = await readDefault();

  // provider "" → default dinonaktifkan (AI Builder tidak bisa dipakai).
  if (!d.provider) {
    await db.appSetting.deleteMany({ where: { key: SETTING_KEY } });
    await clearFallbackCategory("builder");
    return NextResponse.json({ ok: true, disabled: true });
  }

  let apiKeyEnc: string | null = existing?.apiKeyEnc ?? null;
  if (d.clearKey) {
    apiKeyEnc = null;
  } else if (d.apiKey && d.apiKey.length > 0) {
    apiKeyEnc = encryptSecret(d.apiKey);
  }
  // apiKey kosong & tidak clearKey → pertahankan kunci lama.

  const value = JSON.stringify({
    provider: d.provider,
    baseUrl: d.baseUrl && d.baseUrl.length > 0 ? d.baseUrl : null,
    model: d.model && d.model.length > 0 ? d.model : null,
    apiKeyEnc,
  });

  await db.appSetting.upsert({
    where: { key: SETTING_KEY },
    update: { value, updatedAt: new Date() },
    create: { key: SETTING_KEY, value },
  });
  // Legacy kembali jadi sumber tunggal utk builder — bersihkan fallbacks.
  await clearFallbackCategory("builder");

  const key = decryptSecret(apiKeyEnc);
  return NextResponse.json({
    ok: true,
    provider: d.provider,
    baseUrl: d.baseUrl && d.baseUrl.length > 0 ? d.baseUrl : null,
    model: d.model && d.model.length > 0 ? d.model : null,
    hasKey: !!key,
    keyMask: maskKey(key),
  });
}
