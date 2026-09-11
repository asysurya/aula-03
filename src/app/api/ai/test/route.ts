import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/session";
import { db } from "@/lib/db";
import { decryptSecret } from "@/lib/crypto";
import { chatEndpoint, cleanUpstreamDetail, resolveAiConfig, type AiSettingInput } from "@/lib/ai-providers";

export const runtime = "nodejs";
export const maxDuration = 30;

// ── Rate limit sederhana per user (mencegah pembakaran kuota/kredit
//    lewat spam tombol tes) ──
const RATE_LIMIT = 10; // maksimal percobaan
const RATE_WINDOW_MS = 60_000; // per menit
const rateHits = new Map<string, { n: number; reset: number }>();

function rateLimited(userId: string): boolean {
  const now = Date.now();
  const h = rateHits.get(userId);
  if (!h || h.reset < now) {
    rateHits.set(userId, { n: 1, reset: now + RATE_WINDOW_MS });
    return false;
  }
  h.n += 1;
  return h.n > RATE_LIMIT;
}

// Bersihkan entri basi sesekali (anti pertumbuhan tanpa batas).
if (typeof setInterval === "function") {
  const t = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of rateHits) if (v.reset < now) rateHits.delete(k);
  }, RATE_WINDOW_MS);
  // Node: jangan tahan event loop tetap hidup khusus untuk timer ini.
  (t as unknown as { unref?: () => void }).unref?.();
}

/** Blokir target internal (anti-SSRF utk tes form dengan baseUrl bebas). */
function isInternalHost(url: string): boolean {
  try {
    const u = new URL(url);
    const h = u.hostname.toLowerCase();
    if (
      h === "localhost" ||
      h === "::1" ||
      h.endsWith(".internal") ||
      h === "metadata.google.internal"
    )
      return true;
    if (
      /^127\./.test(h) ||
      /^10\./.test(h) ||
      /^192\.168\./.test(h) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
      /^169\.254\./.test(h)
    )
      return true;
    return false;
  } catch {
    return true;
  }
}

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

  if (rateLimited(user.id)) {
    return NextResponse.json(
      { ok: false, error: "Terlalu banyak percobaan — tunggu sebentar lalu coba lagi." },
      { status: 429 }
    );
  }

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
    // ⚠ scope "admin" = membaca kunci default admin → hanya ADMIN boleh.
    // (Dulu: user biasa bisa mengarahkan kunci admin ke baseUrl attackernya
    // dan mencegatnya — eksfiltrasi kunci.)
    if (!d.apiKey) {
      if (d.scope === "admin") {
        if (user.role !== "ADMIN") {
          return NextResponse.json(
            { ok: false, error: "Hanya admin yang boleh menguji default admin." },
            { status: 403 }
          );
        }
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
                  // Pakai baseUrl TERSIMPAN saja — baseUrl dari klien TIDAK
                  // dipercaya saat memakai kunci tersimpan (anti eksfiltrasi).
                  baseUrl: raw.baseUrl ?? null,
                  apiKey: savedKey,
                  model: raw.model ?? null,
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
              // baseUrl tersimpan saja (anti eksfiltrasi kunci sendiri ke
              // URL pihak lain yang diketik ulang).
              baseUrl: row.baseUrl,
              apiKey: savedKey,
              model: d.model ?? row.model,
            },
            null
          );
        }
      }
    } else if (d.baseUrl && isInternalHost(d.baseUrl)) {
      // Tes form dengan kunci yang diketik sendiri + baseUrl internal →
      // tolak (SSRF ke jaringan dalam server).
      return NextResponse.json(
        { ok: false, error: "Base URL ke jaringan internal tidak diizinkan." },
        { status: 400 }
      );
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
