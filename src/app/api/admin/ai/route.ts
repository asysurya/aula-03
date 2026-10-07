import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/session";
import { db } from "@/lib/db";
import { encryptSecret, decryptSecret } from "@/lib/crypto";
import { PROVIDER_IDS, maskKey } from "@/lib/ai-providers";
import {
  AI_CATEGORIES,
  FALLBACKS_KEY,
  isAiCategory,
  MAX_CHAIN_ENTRIES,
  type AiCategory,
  type ChainEntryStored,
} from "@/lib/ai-config-chain";

// ─────────────────────────────────────────────────────────────────────
// GET/PUT /api/admin/ai — default provider AI untuk semua user,
// PER KATEGORI (chat / builder / vision) dengan rantai fallback
// berurutan (Task 29). Disimpan di AppSetting key "ai.fallbacks":
//   { "chat":   [ { provider, baseUrl, apiKeyEnc, model }, … ],
//     "builder": [ … ], "vision": [ … ] }
// Urutan array = prioritas fallback (entri #1 dipakai duluan).
//
// Format LAMA tetap didukung (kompatibilitas):
//   GET → field legacy (provider/model/hasKey/…) = kategori chat.
//   PUT { provider, baseUrl?, model?, apiKey?, clearKey? } → menulis
//   "ai.default" persis perilaku lama (dan membersihkan fallbacks.chat
//   supaya tidak saling menaungi).
// Kunci asli tidak pernah dikirim balik — hanya hasKey + keyMask.
// ─────────────────────────────────────────────────────────────────────

type FallbacksShape = Partial<Record<AiCategory, ChainEntryStored[]>>;

async function readFallbacks(): Promise<FallbacksShape> {
  const row = await db.appSetting.findUnique({ where: { key: FALLBACKS_KEY } });
  if (!row) return {};
  try {
    const parsed = JSON.parse(row.value) as FallbacksShape;
    const out: FallbacksShape = {};
    for (const cat of AI_CATEGORIES) {
      const arr = parsed[cat];
      if (Array.isArray(arr)) {
        const list = arr
          .filter(
            (e): e is ChainEntryStored =>
              !!e && typeof e === "object" && typeof (e as ChainEntryStored).provider === "string"
          )
          .slice(0, MAX_CHAIN_ENTRIES);
        if (list.length) out[cat] = list;
      }
    }
    return out;
  } catch {
    return {};
  }
}

async function writeFallbacks(next: FallbacksShape) {
  const clean: FallbacksShape = {};
  for (const cat of AI_CATEGORIES) {
    if (next[cat]?.length) clean[cat] = next[cat]!.slice(0, MAX_CHAIN_ENTRIES);
  }
  const value = JSON.stringify(clean);
  await db.appSetting.upsert({
    where: { key: FALLBACKS_KEY },
    update: { value, updatedAt: new Date() },
    create: { key: FALLBACKS_KEY, value },
  });
}

/** Legacy: default chat tunggal di "ai.default". */
async function readLegacyDefault(key: "ai.default" | "ai.builder") {
  const row = await db.appSetting.findUnique({ where: { key } });
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.value) as {
      provider?: string;
      baseUrl?: string | null;
      apiKeyEnc?: string | null;
      model?: string | null;
    };
    if (!parsed.provider) return null;
    return {
      provider: parsed.provider,
      baseUrl: parsed.baseUrl ?? null,
      apiKeyEnc: parsed.apiKeyEnc ?? null,
      model: parsed.model ?? null,
    };
  } catch {
    return null;
  }
}

function entryView(e: ChainEntryStored) {
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
  const admin = await requireAdmin().catch(() => null);
  if (!admin) return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });

  const fallbacks = await readFallbacks();
  const legacyChat = await readLegacyDefault("ai.default");
  const legacyBuilder = await readLegacyDefault("ai.builder");

  const categories: Record<string, unknown> = {};
  for (const cat of AI_CATEGORIES) {
    // Sumber efektif: fallbacks.<cat> → legacy (chat/builder).
    let entries: ChainEntryStored[] = fallbacks[cat] ?? [];
    if (!entries.length) {
      if (cat === "chat" && legacyChat) entries = [legacyChat];
      else if (cat === "builder" && legacyBuilder) entries = [legacyBuilder];
    }
    categories[cat] = { entries: entries.map(entryView) };
  }

  // Tampilan legacy = kategori chat (sumber efektif).
  const chatEntries = (fallbacks.chat ?? (legacyChat ? [legacyChat] : [])) as ChainEntryStored[];
  const chatFirst = chatEntries[0] ?? null;
  const chatKey = decryptSecret(chatFirst?.apiKeyEnc ?? null);

  return NextResponse.json({
    provider: chatFirst?.provider ?? "",
    baseUrl: chatFirst?.baseUrl ?? null,
    model: chatFirst?.model ?? null,
    hasKey: !!chatKey,
    keyMask: maskKey(chatKey),
    usable: chatEntries.length > 0,
    // Task 29: default per kategori dengan rantai fallback.
    categories,
  });
}

// ── PUT ───────────────────────────────────────────────────────────────

const providerEnum = z.enum([...PROVIDER_IDS] as [string, ...string[]]);
const baseUrlSchema = z
  .string()
  .trim()
  .max(300)
  .refine((v) => v === "" || /^https?:\/\/.+/i.test(v), "Base URL harus mulai http:// atau https://");

const entrySchema = z.object({
  provider: providerEnum,
  baseUrl: baseUrlSchema.optional().nullable(),
  model: z.string().trim().max(200).optional().nullable(),
  apiKey: z.string().max(400).optional().nullable(),
  clearKey: z.boolean().optional(),
});

const putSchema = z.union([
  // Format baru: default per kategori (rantai fallback).
  z.object({
    category: z.enum(["chat", "builder", "vision"]),
    entries: z.array(entrySchema).max(MAX_CHAIN_ENTRIES).optional(),
    disabled: z.boolean().optional(), // true → hapus default kategori ini
  }),
  // Format lama: chat tunggal → "ai.default".
  z.object({
    provider: z.enum(["", ...PROVIDER_IDS] as [string, ...string[]]),
    baseUrl: baseUrlSchema.optional().nullable(),
    model: z.string().trim().max(200).optional().nullable(),
    apiKey: z.string().max(400).optional().nullable(),
    clearKey: z.boolean().optional(),
  }),
]);

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

  // ── Format baru: kategori + rantai fallback ──
  if ("category" in d) {
    const category = d.category as AiCategory;
    if (!isAiCategory(category)) {
      return NextResponse.json({ error: "Kategori tidak dikenal" }, { status: 400 });
    }
    const fallbacks = await readFallbacks();
    const entries = d.entries ?? [];
    if (d.disabled || !entries.length) {
      delete fallbacks[category];
      await writeFallbacks(fallbacks);
      return NextResponse.json({ ok: true, category, disabled: true });
    }
    // Merge kunci lama per indeks (apiKey kosong = pertahankan).
    const existing = fallbacks[category] ?? [];
    const merged: ChainEntryStored[] = entries.slice(0, MAX_CHAIN_ENTRIES).map((e, i) => {
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
    fallbacks[category] = merged;
    await writeFallbacks(fallbacks);
    return NextResponse.json({ ok: true, category, entries: merged.map(entryView) });
  }

  // ── Format LAMA (chat tunggal) — perilaku persis versi sebelumnya ──
  const existing = await readLegacyDefault("ai.default");

  // provider "" → default dinonaktifkan (user harus pasang kunci sendiri).
  if (!d.provider) {
    await db.appSetting.deleteMany({ where: { key: "ai.default" } });
    // Bersihkan fallbacks.chat supaya tidak menaungi hasil legacy.
    const fallbacks = await readFallbacks();
    if (fallbacks.chat) {
      delete fallbacks.chat;
      await writeFallbacks(fallbacks);
    }
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
    where: { key: "ai.default" },
    update: { value, updatedAt: new Date() },
    create: { key: "ai.default", value },
  });
  // Legacy kembali jadi sumber tunggal utk chat — bersihkan fallbacks.chat.
  const fallbacks = await readFallbacks();
  if (fallbacks.chat) {
    delete fallbacks.chat;
    await writeFallbacks(fallbacks);
  }

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
