import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/session";
import { db } from "@/lib/db";
import { encryptSecret, decryptSecret } from "@/lib/crypto";
import {
  PROVIDER_IDS,
  maskKey,
  providerLabel,
  resolveAiConfig,
  type AiSettingInput,
} from "@/lib/ai-providers";

// ─────────────────────────────────────────────────────────────────────
// GET /api/ai/settings
// Status pengaturan Teman AI milik user + info default admin.
// Kunci asli TIDAK PERNAH dikirim — hanya hasKey + keyMask.
// ─────────────────────────────────────────────────────────────────────

async function loadUserSetting(userId: string) {
  return db.aiUserSetting.findUnique({ where: { userId } });
}

async function loadAdminDefault(): Promise<AiSettingInput | null> {
  const row = await db.appSetting.findUnique({ where: { key: "ai.default" } });
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
      apiKey: decryptSecret(parsed.apiKeyEnc ?? null),
      model: parsed.model ?? null,
    };
  } catch {
    return null;
  }
}

export async function GET() {
  const user = await requireUser().catch(() => null);
  if (!user) return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });

  const [row, adminDefault] = await Promise.all([
    loadUserSetting(user.id),
    loadAdminDefault(),
  ]);

  const userKey = decryptSecret(row?.apiKeyEnc ?? null);

  const userSetting: AiSettingInput | null = row
    ? {
        provider: row.provider,
        baseUrl: row.baseUrl,
        apiKey: userKey,
        model: row.model,
      }
    : null;
  const active = resolveAiConfig(userSetting, adminDefault);

  return NextResponse.json({
    user: {
      provider: row?.provider ?? "",
      baseUrl: row?.baseUrl ?? null,
      model: row?.model ?? null,
      hasKey: !!userKey,
      keyMask: maskKey(userKey),
    },
    default: {
      available: !!resolveAiConfig(null, adminDefault),
      provider: adminDefault?.provider ?? "",
      model: adminDefault?.model ?? null,
      sourceLabel: adminDefault?.provider
        ? `default admin (${providerLabel(adminDefault.provider)})`
        : "",
    },
    // Config yang benar-benar aktif (untuk badge di UI).
    active: active
      ? {
          provider: active.provider,
          baseUrl: active.baseUrl,
          model: active.model,
          source: active.source,
        }
      : null,
  });
}

// ─────────────────────────────────────────────────────────────────────
// PUT /api/ai/settings — simpan pengaturan milik user (BYOK).
//   provider ""  = kembali ikut default admin (row dihapus).
//   apiKey kosong/undefined = pertahankan kunci lama.
//   clearKey = true → hapus kunci tersimpan.
// ─────────────────────────────────────────────────────────────────────

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
  const user = await requireUser().catch(() => null);
  if (!user) return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });

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

  // Provider "" → ikut default admin: hapus row user.
  if (!d.provider) {
    await db.aiUserSetting.deleteMany({ where: { userId: user.id } });
    return NextResponse.json({ ok: true, followsDefault: true });
  }

  const existing = await loadUserSetting(user.id);

  // ── Resolusi kunci ──
  let apiKeyEnc: string | null = existing?.apiKeyEnc ?? null;
  if (d.clearKey) {
    apiKeyEnc = null;
  } else if (d.apiKey && d.apiKey.length > 0) {
    apiKeyEnc = encryptSecret(d.apiKey);
  }
  // apiKey kosong & tidak clearKey → pertahankan lama (apiKeyEnc tidak di-update).

  const row = await db.aiUserSetting.upsert({
    where: { userId: user.id },
    update: {
      provider: d.provider,
      baseUrl: d.baseUrl && d.baseUrl.length > 0 ? d.baseUrl : null,
      model: d.model && d.model.length > 0 ? d.model : null,
      ...(d.clearKey || (d.apiKey && d.apiKey.length > 0) ? { apiKeyEnc } : {}),
    },
    create: {
      userId: user.id,
      provider: d.provider,
      baseUrl: d.baseUrl && d.baseUrl.length > 0 ? d.baseUrl : null,
      model: d.model && d.model.length > 0 ? d.model : null,
      apiKeyEnc,
    },
  });

  const key = decryptSecret(row.apiKeyEnc);
  return NextResponse.json({
    ok: true,
    user: {
      provider: row.provider,
      baseUrl: row.baseUrl,
      model: row.model,
      hasKey: !!key,
      keyMask: maskKey(key),
    },
  });
}
