import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/session";
import { db } from "@/lib/db";
import { decryptSecret } from "@/lib/crypto";
import { chatEndpoint, cleanUpstreamDetail, resolveAiConfig, type AiSettingInput } from "@/lib/ai-providers";

export const runtime = "nodejs";
export const maxDuration = 30;

// ─────────────────────────────────────────────────────────────────────
// POST /api/ai/test — tes sambungan Teman AI.
// Body opsional (untuk tes form BELUM disimpan):
//   { provider, baseUrl?, apiKey?, model? }
// Tanpa body → tes config aktif (user → default admin).
// Balasan: { ok: true, reply, model } | { ok: false, error }
// ─────────────────────────────────────────────────────────────────────

const testSchema = z.object({
  provider: z.string().trim().max(40).optional(),
  baseUrl: z.string().trim().max(300).optional().nullable(),
  apiKey: z.string().max(400).optional().nullable(),
  model: z.string().trim().max(200).optional().nullable(),
  // "admin" = tes default admin (panel Admin) — fallback kunci dari ai.default.
  scope: z.enum(["user", "admin"]).optional(),
});

function testErrorMessage(status: number, detailRaw: string | null): string {
  const detail = cleanUpstreamDetail(detailRaw);
  if (status === 401 || status === 403) {
    return "API key ditolak provider (401/403) — periksa kuncinya." + (detail ? ` Detail: ${detail.slice(0, 160)}` : "");
  }
  if (status === 429) {
    return (
      "Key VALID, tapi model kena limit (429). Model ‘:free’ berbagi kuota publik yang sering penuh — " +
      "tunggu beberapa menit atau ganti model lain." +
      (detail ? ` Detail: ${detail.slice(0, 160)}` : "")
    );
  }
  if (status === 402) {
    return "Kredit provider tidak cukup (402). Tambah kredit atau pilih model :free." + (detail ? ` Detail: ${detail.slice(0, 160)}` : "");
  }
  if (status === 404) {
    return "Endpoint/model tidak ditemukan (404) — periksa Base URL dan nama model." + (detail ? ` Detail: ${detail.slice(0, 160)}` : "");
  }
  if (detail && /location is not supported|blokir wilayah/i.test(detail)) {
    return "Model ini menolak permintaan dari lokasi server (pembatasan wilayah provider). Ganti model lain — API key kamu tidak bermasalah.";
  }
  return `Provider menjawab error HTTP ${status}.` + (detail ? ` Detail: ${detail.slice(0, 160)}` : "");
}

export async function POST(req: NextRequest) {
  const user = await requireUser().catch(() => null);
  if (!user) return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });

  let body: unknown = {};
  try {
    body = await req.json().catch(() => ({}));
  } catch {
    body = {};
  }
  const parsed = testSchema.safeParse(body ?? {});
  const d = parsed.success ? parsed.data : {};

  // ── Susun config yang mau dites ──
  let config: ReturnType<typeof resolveAiConfig> = null;
  let tested = "config aktif";

  if (d.provider) {
    // Tes form (belum tentu disimpan).
    tested = "form";
    config = resolveAiConfig(
      { provider: d.provider, baseUrl: d.baseUrl ?? null, apiKey: d.apiKey ?? null, model: d.model ?? null },
      null
    );
    // ApiKey kosong di form → fallback ke kunci TERSIMPAN sesuai scope:
    // user → AiUserSetting; admin → AppSetting "ai.default".
    if (!d.apiKey) {
      if (d.scope === "admin") {
        const adminRow = await db.appSetting.findUnique({ where: { key: "ai.default" } });
        if (adminRow) {
          try {
            const raw = JSON.parse(adminRow.value) as {
              provider?: string;
              baseUrl?: string | null;
              apiKeyEnc?: string | null;
              model?: string | null;
            };
            const savedKey = decryptSecret(raw.apiKeyEnc ?? null);
            if (savedKey && raw.provider === d.provider) {
              config = resolveAiConfig(
                {
                  provider: d.provider,
                  baseUrl: d.baseUrl ?? raw.baseUrl ?? null,
                  apiKey: savedKey,
                  model: d.model ?? raw.model ?? null,
                },
                null
              );
            }
          } catch {
            /* biarkan config sebelumnya */
          }
        }
      } else {
        const row = await db.aiUserSetting.findUnique({ where: { userId: user.id } });
        const savedKey = decryptSecret(row?.apiKeyEnc ?? null);
        if (savedKey && row?.provider === d.provider) {
          config = resolveAiConfig(
            {
              provider: d.provider,
              baseUrl: d.baseUrl ?? row.baseUrl,
              apiKey: savedKey,
              model: d.model ?? row.model,
            },
            null
          );
        }
      }
    }
  } else {
    // Tes config aktif: milik user → default admin.
    const [userRow, adminRow] = await Promise.all([
      db.aiUserSetting.findUnique({ where: { userId: user.id } }),
      db.appSetting.findUnique({ where: { key: "ai.default" } }),
    ]);
    let adminDefault: AiSettingInput | null = null;
    if (adminRow) {
      try {
        const raw = JSON.parse(adminRow.value) as {
          provider?: string;
          baseUrl?: string | null;
          apiKeyEnc?: string | null;
          model?: string | null;
        };
        adminDefault = {
          provider: raw.provider ?? "",
          baseUrl: raw.baseUrl ?? null,
          apiKey: decryptSecret(raw.apiKeyEnc ?? null),
          model: raw.model ?? null,
        };
      } catch {
        adminDefault = null;
      }
    }
    const userSetting: AiSettingInput | null = userRow
      ? {
          provider: userRow.provider,
          baseUrl: userRow.baseUrl,
          apiKey: decryptSecret(userRow.apiKeyEnc),
          model: userRow.model,
        }
      : null;
    config = resolveAiConfig(userSetting, adminDefault);
  }

  if (!config) {
    return NextResponse.json({
      ok: false,
      error:
        tested === "form"
          ? "Belum lengkap — provider, base URL, dan API key perlu diisi dulu (atau simpan dulu, lalu tes config aktif)."
          : "Belum ada AI terpasang — isi pengaturan dulu.",
    });
  }

  // ── Ping provider dengan pesan mini (non-streaming, murah) ──
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await fetch(chatEndpoint(config.baseUrl), {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: config.model,
        messages: [{ role: "user", content: 'Balas hanya dengan satu kata: "siap"' }],
        max_tokens: 10,
        stream: false,
      }),
    });
    clearTimeout(timer);

    if (!res.ok) {
      let detail: string | null = null;
      try {
        const errJson = await res.json().catch(() => null);
        detail =
          errJson?.error?.metadata?.raw ?? errJson?.error?.message ?? errJson?.message ?? null;
        if (typeof detail !== "string") detail = null;
      } catch {
        /* abaikan */
      }
      return NextResponse.json({ ok: false, error: testErrorMessage(res.status, detail) });
    }

    const data = await res.json().catch(() => null);
    const reply: unknown = data?.choices?.[0]?.message?.content;
    return NextResponse.json({
      ok: true,
      model: config.model,
      source: config.source,
      reply: typeof reply === "string" ? reply.trim().slice(0, 60) : "",
    });
  } catch {
    clearTimeout(timer);
    return NextResponse.json({
      ok: false,
      error: "Gagal menghubungi server AI — periksa Base URL / koneksi internet (timeout 20 detik).",
    });
  }
}
