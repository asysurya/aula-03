// ─────────────────────────────────────────────────────────────────────
// Config AI per KATEGORI dengan rantai FALLBACK berurutan (Task 29).
//
// Kategori:
//   chat   → Teman AI + Pusat Belajar (study) + Teman Belajar
//   builder→ AI Builder (Pusat Belajar) + generator formulir
//   vision → ekstraksi teks dari gambar / PDF hasil scan (per halaman)
//
// Penyimpanan:
//   USER   : AiCategoryConfig { userId, category, entriesJson }
//            entriesJson = [{"provider","baseUrl?","apiKeyEnc?","model?"},…]
//            (urutan array = urutan prioritas fallback)
//   ADMIN  : AppSetting "ai.fallbacks" = {"chat":[…],"builder":[…],"vision":[…]}
//            Legacy: "ai.default" (→ chat, 1 entri) dan "ai.builder"
//            (→ builder, 1 entri) tetap dibaca bila kunci baru kosong.
//
// Resolusi chain (urutan):
//   1. entri user untuk kategori itu (bila ada & non-kosong)
//   2. entri admin "ai.fallbacks.<kategori>" (legacy: ai.default/ai.builder)
//   3. Kompatibilitas lama: user punya AiUserSetting (tanpa AiCategoryConfig
//      chat) → diperlakukan sebagai rantai 1 entri kategori chat.
//   Kategori vision TIDAK otomatis memakai chain chat — harus diatur
//   eksplisit (per kategori, sesuai permintaan panel config per kategori).
//
// Eksekusi fallback: tryChatCompletion() mencoba entri #1; bila gagal
// (jaringan / HTTP error / timeout) lanjut entri #2, dst. Respons OK pertama
// yang dipakai. Daftar kegagalan dikembalikan untuk pesan error gabungan.
// ─────────────────────────────────────────────────────────────────────

import { db } from "@/lib/db";
import { decryptSecret } from "@/lib/crypto";
import {
  PROVIDERS,
  chatEndpoint,
  isKnownProviderSafe,
  materializeEntry,
  AI_CATEGORIES,
  isAiCategory,
  MAX_CHAIN_ENTRIES,
  CATEGORY_LABELS,
  CATEGORY_HINTS,
  type AiCategory,
  type AiSettingInput,
  type ResolvedAiConfig,
} from "@/lib/ai-providers";

// Re-export konstanta kategori (dipakai route server) — definisi aslinya
// di ai-providers.ts supaya aman diimpor komponen client.
export {
  AI_CATEGORIES,
  isAiCategory,
  MAX_CHAIN_ENTRIES,
  CATEGORY_LABELS,
  CATEGORY_HINTS,
};
export type { AiCategory };

/** Bentuk tersimpan satu entri rantai (kunci masih terenkripsi). */
export interface ChainEntryStored {
  provider: string;
  baseUrl?: string | null;
  apiKeyEnc?: string | null;
  model?: string | null;
}

export const FALLBACKS_KEY = "ai.fallbacks";

// ── Baca penyimpanan ──────────────────────────────────────────────────

function parseEntries(json: string): ChainEntryStored[] {
  try {
    const arr = JSON.parse(json);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter(
        (e): e is ChainEntryStored =>
          !!e && typeof e === "object" && typeof (e as ChainEntryStored).provider === "string"
      )
      .slice(0, MAX_CHAIN_ENTRIES);
  } catch {
    return [];
  }
}

/** Chain milik user untuk satu kategori (dari AiCategoryConfig). */
export async function loadUserChainEntries(
  userId: string,
  category: AiCategory
): Promise<ChainEntryStored[]> {
  const row = await db.aiCategoryConfig.findUnique({
    where: { userId_category: { userId, category } },
  });
  return row ? parseEntries(row.entriesJson) : [];
}

/** Kompabilitas: AiUserSetting lama → rantai 1 entri kategori "chat". */
async function loadLegacyUserEntry(userId: string): Promise<ChainEntryStored | null> {
  const row = await db.aiUserSetting.findUnique({ where: { userId } });
  if (!row || !row.provider) return null;
  return {
    provider: row.provider,
    baseUrl: row.baseUrl,
    apiKeyEnc: row.apiKeyEnc,
    model: row.model,
  };
}

interface AdminFallbacksShape {
  chat?: ChainEntryStored[];
  builder?: ChainEntryStored[];
  vision?: ChainEntryStored[];
}

async function loadAdminFallbacks(): Promise<AdminFallbacksShape> {
  const row = await db.appSetting.findUnique({ where: { key: FALLBACKS_KEY } });
  if (!row) return {};
  try {
    const parsed = JSON.parse(row.value) as AdminFallbacksShape;
    const clean: AdminFallbacksShape = {};
    for (const cat of AI_CATEGORIES) {
      const arr = parsed[cat];
      if (Array.isArray(arr)) {
        const list = arr
          .filter(
            (e): e is ChainEntryStored =>
              !!e && typeof e === "object" && typeof (e as ChainEntryStored).provider === "string"
          )
          .slice(0, MAX_CHAIN_ENTRIES);
        if (list.length) clean[cat] = list;
      }
    }
    return clean;
  } catch {
    return {};
  }
}

/** Legacy admin: "ai.default" (chat) / "ai.builder" (builder) — 1 entri. */
async function loadLegacyAdminEntry(
  key: "ai.default" | "ai.builder"
): Promise<ChainEntryStored | null> {
  const row = await db.appSetting.findUnique({ where: { key } });
  if (!row) return null;
  try {
    const p = JSON.parse(row.value) as {
      provider?: string;
      baseUrl?: string | null;
      apiKeyEnc?: string | null;
      model?: string | null;
    };
    if (!p.provider) return null;
    return {
      provider: p.provider,
      baseUrl: p.baseUrl ?? null,
      apiKeyEnc: p.apiKeyEnc ?? null,
      model: p.model ?? null,
    };
  } catch {
    return null;
  }
}

// ── Resolusi chain aktif ──────────────────────────────────────────────

/**
 * Chain entri TERENKRIPSI untuk kategori (urutan prioritas), TANPA
 * fallback-vision-ke-chat (pemanggil boleh menambahkan sendiri lewat
 * resolveChain yang sudah termasuk aturan itu).
 */
export async function loadRawChain(
  userId: string | null,
  category: AiCategory
): Promise<{ entries: ChainEntryStored[]; source: "user" | "admin" | "none" }> {
  if (userId) {
    const own = await loadUserChainEntries(userId, category);
    if (own.length) return { entries: own, source: "user" };
    // Kompatibilitas lama hanya relevan untuk kategori chat.
    if (category === "chat") {
      const legacy = await loadLegacyUserEntry(userId);
      if (legacy) return { entries: [legacy], source: "user" };
    }
  }
  const admin = await loadAdminFallbacks();
  const adminEntries = admin[category];
  if (adminEntries?.length) return { entries: adminEntries, source: "admin" };
  if (category === "chat") {
    const legacy = await loadLegacyAdminEntry("ai.default");
    if (legacy) return { entries: [legacy], source: "admin" };
  }
  if (category === "builder") {
    const legacy = await loadLegacyAdminEntry("ai.builder");
    if (legacy) return { entries: [legacy], source: "admin" };
  }
  return { entries: [], source: "none" };
}

/** Entri tersimpan → config siap pakai (kunci didekripsi). */
export function storedToInput(e: ChainEntryStored): AiSettingInput {
  return {
    provider: e.provider,
    baseUrl: e.baseUrl ?? null,
    apiKey: decryptSecret(e.apiKeyEnc ?? null),
    model: e.model ?? null,
  };
}

/**
 * Chain config AKTIF siap pakai untuk kategori. Urutan entri = urutan
 * fallback. Vision harus dikonfigurasi eksplisit (tidak memakai chain
 * chat) supaya perilaku per-kategori dapat diprediksi.
 */
export async function resolveChain(
  userId: string | null,
  category: AiCategory
): Promise<ResolvedAiConfig[]> {
  const raw = await loadRawChain(userId, category);
  const source: "user" | "admin" = raw.source === "none" ? "admin" : raw.source;
  const out: ResolvedAiConfig[] = [];
  for (const e of raw.entries) {
    const cfg = materializeEntry(storedToInput(e), source);
    if (cfg) out.push(cfg);
  }
  return out;
}

// ── Eksekusi dengan fallback ─────────────────────────────────────────

export interface ChatAttemptFailure {
  provider: string;
  model: string;
  status: number | null; // null = jaringan/timeout
  detail: string | null;
}

export interface ChatAttemptResult {
  response: Response | null; // null = semua entri gagal
  config: ResolvedAiConfig | null; // config entri yang berhasil
  failures: ChatAttemptFailure[];
}

/**
 * Panggil /chat/completions mencoba tiap entri chain sampai ada yang OK.
 * TIDAK membaca body respons — pemanggil melanjutkan streaming sendiri.
 * response null bila SEMUA entri gagal (failures terisi lengkap).
 */
export async function tryChatCompletion(
  chain: ResolvedAiConfig[],
  body: Record<string, unknown>,
  opts: {
    signal?: AbortSignal;
    timeoutMs?: number;
    /** Header tambahan (mis. HTTP-Referer OpenRouter). */
    extraHeaders?: Record<string, string>;
  } = {}
): Promise<ChatAttemptResult> {
  const failures: ChatAttemptFailure[] = [];
  for (const config of chain) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 55_000);
    const onOuterAbort = () => controller.abort();
    opts.signal?.addEventListener("abort", onOuterAbort);
    try {
      const res = await fetch(chatEndpoint(config.baseUrl), {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
          ...(opts.extraHeaders ?? {}),
        },
        body: JSON.stringify({ model: config.model, ...body }),
      });
      if (res.ok && res.body) {
        return { response: res, config, failures };
      }
      // HTTP error → baca detail ringkas lalu lanjut fallback.
      let detail: string | null = null;
      try {
        const j = await res.json().catch(() => null);
        const raw =
          j?.error?.metadata?.raw ?? j?.error?.message ?? j?.message ?? null;
        detail = typeof raw === "string" ? raw.slice(0, 200) : null;
      } catch {
        /* abaikan */
      }
      failures.push({ provider: config.provider, model: config.model, status: res.status, detail });
    } catch (err) {
      failures.push({
        provider: config.provider,
        model: config.model,
        status: null,
        detail: String((err as Error)?.name ?? "network"),
      });
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onOuterAbort);
    }
  }
  return { response: null, config: null, failures };
}

/** Ringkasan kegagalan untuk ditampilkan ke user (Bahasa Indonesia). */
export function summarizeFailures(failures: ChatAttemptFailure[]): string {
  if (!failures.length) return "";
  return failures
    .map((f) => {
      const label = isKnownProviderSafe(f.provider) ? PROVIDERS[f.provider].label : f.provider;
      const status = f.status ? ` HTTP ${f.status}` : " (tidak terjangkau)";
      return `• ${label}/${f.model}${status}`;
    })
    .join("; ");
}
