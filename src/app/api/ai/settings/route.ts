import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/session";
import { db } from "@/lib/db";
import { encryptSecret, decryptSecret } from "@/lib/crypto";
import {
  PROVIDER_IDS,
  maskKey,
  providerLabel,
} from "@/lib/ai-providers";
import {
  AI_CATEGORIES,
  isAiCategory,
  loadRawChain,
  loadUserChainEntries,
  MAX_CHAIN_ENTRIES,
  resolveChain,
  type AiCategory,
  type ChainEntryStored,
} from "@/lib/ai-config-chain";

// ─────────────────────────────────────────────────────────────────────
// GET /api/ai/settings — status pengaturan AI milik user.
// PUT /api/ai/settings — simpan pengaturan.
//
// Task 29 — format BARU (per kategori + rantai fallback):
//   PUT { category: "chat"|"builder"|"vision",
//        entries: [ { provider, baseUrl?, model?, apiKey?, clearKey? }, … ],
//        followDefault?: boolean }
//   entries kosong / followDefault → kategori ikut default admin.
//   Urutan array = urutan prioritas fallback.
//
// Format LAMA tetap diterima (kompatibilitas UI lama & tes):
//   PUT { provider, baseUrl?, model?, apiKey?, clearKey? }
//   → menulis AiUserSetting kategori "chat" persis perilaku lama
//     (provider "" = hapus row = ikut default admin).
//
// Kunci asli TIDAK PERNAH dikirim — hanya hasKey + keyMask per entri.
// ─────────────────────────────────────────────────────────────────────

function providerEnum() {
  return z.enum(["", ...PROVIDER_IDS] as [string, ...string[]]);
}

const baseUrlSchema = z
  .string()
  .trim()
  .max(300)
  .refine((v) => v === "" || /^https?:\/\/.+/i.test(v), "Base URL harus mulai http:// atau https://");

const entrySchema = z.object({
  provider: providerEnum(),
  baseUrl: baseUrlSchema.optional().nullable(),
  model: z.string().trim().max(200).optional().nullable(),
  apiKey: z.string().max(400).optional().nullable(),
  clearKey: z.boolean().optional(),
});

const putSchema = z.union([
  // Format baru: per kategori.
  z.object({
    category: z.enum(["chat", "builder", "vision"]),
    entries: z.array(entrySchema).max(MAX_CHAIN_ENTRIES).optional(),
    followDefault: z.boolean().optional(),
  }),
  // Format lama: chat tunggal.
  z.object({
    provider: providerEnum(),
    baseUrl: baseUrlSchema.optional().nullable(),
    model: z.string().trim().max(200).optional().nullable(),
    apiKey: z.string().max(400).optional().nullable(),
    clearKey: z.boolean().optional(),
  }),
]);

// ── GET ───────────────────────────────────────────────────────────────

interface EntryView {
  provider: string;
  baseUrl: string | null;
  model: string | null;
  hasKey: boolean;
  keyMask: string | null;
}

function entryView(e: ChainEntryStored): EntryView {
  const key = decryptSecret(e.apiKeyEnc ?? null);
  return {
    provider: e.provider,
    baseUrl: e.baseUrl ?? null,
    model: e.model ?? null,
    hasKey: !!key,
    keyMask: maskKey(key),
  };
}

export async function GET() {
  const user = await requireUser().catch(() => null);
  if (!user) return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });

  const categories: Record<string, unknown> = {};
  for (const cat of AI_CATEGORIES) {
    const raw = await loadRawChain(user.id, cat);
    const chain = await resolveChain(user.id, cat);
    categories[cat] = {
      // Enri milik user (kosong = ikut default admin).
      entries: raw.source === "user" ? raw.entries.map(entryView) : [],
      followsDefault: raw.source !== "user",
      // Config yang benar-benar aktif utk kategori ini.
      active: chain.length
        ? {
            provider: chain[0].provider,
            baseUrl: chain[0].baseUrl,
            model: chain[0].model,
            source: chain[0].source,
          }
        : null,
      // Apakah admin punya default utk kategori ini.
      adminAvailable: raw.source === "admin",
    };
  }

  // Tampilan legacy (kompatibilitas UI lama) = kategori chat.
  const chatRaw = await loadRawChain(user.id, "chat");
  const chatChain = await resolveChain(user.id, "chat");
  const firstUserEntry =
    chatRaw.source === "user" ? chatRaw.entries[0] ?? null : null;
  const userKey = decryptSecret(firstUserEntry?.apiKeyEnc ?? null);

  return NextResponse.json({
    user: {
      provider: firstUserEntry?.provider ?? "",
      baseUrl: firstUserEntry?.baseUrl ?? null,
      model: firstUserEntry?.model ?? null,
      hasKey: !!userKey,
      keyMask: maskKey(userKey),
    },
    default: {
      available: chatRaw.source === "admin",
      provider:
        chatRaw.source === "admin" ? chatRaw.entries[0]?.provider ?? "" : "",
      model: chatRaw.source === "admin" ? chatRaw.entries[0]?.model ?? null : null,
      sourceLabel:
        chatRaw.source === "admin"
          ? `default admin (${providerLabel(chatRaw.entries[0]?.provider ?? "")})`
          : "",
    },
    active: chatChain.length
      ? {
          provider: chatChain[0].provider,
          baseUrl: chatChain[0].baseUrl,
          model: chatChain[0].model,
          source: chatChain[0].source,
        }
      : null,
    // Task 29: detail per kategori (chat/builder/vision).
    categories,
  });
}

// ── PUT ───────────────────────────────────────────────────────────────

/** Simpan entri kategori (merge kunci lama per indeks). */
async function saveCategory(
  userId: string,
  category: AiCategory,
  incoming: z.infer<typeof entrySchema>[]
) {
  const existing = await loadUserChainEntries(userId, category);
  const entries: ChainEntryStored[] = incoming.slice(0, MAX_CHAIN_ENTRIES).map((e, i) => {
    let apiKeyEnc: string | null = existing[i]?.apiKeyEnc ?? null;
    if (e.clearKey) apiKeyEnc = null;
    else if (e.apiKey && e.apiKey.length > 0) apiKeyEnc = encryptSecret(e.apiKey);
    return {
      provider: e.provider,
      baseUrl: e.baseUrl && e.baseUrl.length > 0 ? e.baseUrl : null,
      model: e.model && e.model.length > 0 ? e.model : null,
      apiKeyEnc,
    };
  });

  if (!entries.length) {
    await db.aiCategoryConfig.deleteMany({ where: { userId, category } });
    return { ok: true, followsDefault: true };
  }
  await db.aiCategoryConfig.upsert({
    where: { userId_category: { userId, category } },
    update: { entriesJson: JSON.stringify(entries) },
    create: { userId, category, entriesJson: JSON.stringify(entries) },
  });
  return { ok: true, entries: entries.map(entryView) };
}

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

  // ── Format baru: per kategori + rantai fallback ──
  if ("category" in d) {
    const category = d.category as AiCategory;
    if (!isAiCategory(category)) {
      return NextResponse.json({ error: "Kategori tidak dikenal" }, { status: 400 });
    }
    const entries = d.entries ?? [];
    // followDefault eksplisit / entri kosong → hapus row (ikut admin).
    if (d.followDefault || !entries.length) {
      await db.aiCategoryConfig.deleteMany({ where: { userId: user.id, category } });
      return NextResponse.json({ ok: true, followsDefault: true });
    }
    // Validasi: entri wajib punya provider; non-ollama disarankan berkunci.
    for (const e of entries) {
      if (!e.provider) {
        return NextResponse.json(
          { error: "Setiap entri wajib memilih provider." },
          { status: 400 }
        );
      }
    }
    const res = await saveCategory(user.id, category, entries);
    return NextResponse.json(res);
  }

  // ── Format LAMA (chat tunggal) — perilaku persis versi sebelumnya ──
  if (!d.provider) {
    // provider "" → ikut default admin: hapus row user (baru & lama).
    await db.aiCategoryConfig.deleteMany({ where: { userId: user.id, category: "chat" } });
    await db.aiUserSetting.deleteMany({ where: { userId: user.id } });
    return NextResponse.json({ ok: true, followsDefault: true });
  }

  const existing = await db.aiUserSetting.findUnique({ where: { userId: user.id } });

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
  // Row kategori chat baru bisa menaunginya — hapus supaya tidak membayangi.
  await db.aiCategoryConfig.deleteMany({ where: { userId: user.id, category: "chat" } });

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
