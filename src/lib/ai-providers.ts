// ─────────────────────────────────────────────────────────────────────
// Preset provider Teman AI (BYOK — bawa kunci sendiri).
// Aman dipakai di client & server: TIDAK ada import node / db / crypto.
// Semua provider memakai API kompatibel OpenAI Chat Completions
// (POST <baseUrl>/chat/completions, SSE streaming).
// ─────────────────────────────────────────────────────────────────────

export type AiProviderId =
  | "openai"
  | "deepseek"
  | "openrouter"
  | "gemini"
  | "ollama"
  | "custom";

export interface AiProviderPreset {
  id: AiProviderId;
  /** Label ramah (Bahasa Indonesia) untuk ditampilkan di UI. */
  label: string;
  /** Base URL default; "" berarti wajib diisi user (custom). */
  baseUrl: string;
  /** Daftar model yang disarankan (bisa diisi bebas). */
  models: string[];
  /** Provider ini tidak butuh API key (lokal). */
  noKeyNeeded?: boolean;
  /** Catatan singkat untuk user. */
  hint: string;
}

export const PROVIDERS: Record<AiProviderId, AiProviderPreset> = {
  openai: {
    id: "openai",
    label: "ChatGPT (OpenAI)",
    baseUrl: "https://api.openai.com/v1",
    models: ["gpt-4o-mini", "gpt-4o", "gpt-4.1-mini"],
    hint: "Butuh API key dari platform.openai.com.",
  },
  deepseek: {
    id: "deepseek",
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    models: ["deepseek-chat", "deepseek-reasoner"],
    hint: "Murah & jago matematika. API key dari platform.deepseek.com.",
  },
  openrouter: {
    id: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    models: [
      "google/gemma-3-27b-it",
      "google/gemma-3-12b-it",
      "google/gemma-4-31b-it",
      "meta-llama/llama-3.3-70b-instruct",
      "openai/gpt-4o-mini",
    ],
    hint: "Satu kunci untuk banyak model. Catatan: varian berakhiran ‘:free’ berbagi kuota publik dan sering penuh (error 429) — kalau terus error, pakai model tanpa ‘:free’ (butuh kredit).",
  },
  gemini: {
    id: "gemini",
    label: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    models: ["gemini-2.0-flash", "gemini-2.5-flash"],
    hint: "API key dari aistudio.google.com (tetap butuh kunci).",
  },
  ollama: {
    id: "ollama",
    label: "Ollama (komputer sendiri)",
    baseUrl: "http://localhost:11434/v1",
    models: ["llama3.1", "qwen2.5"],
    noKeyNeeded: true,
    hint: "Gratis & tanpa kunci. Edit Base URL kalau Ollama jalan di komputer lain.",
  },
  custom: {
    id: "custom",
    label: "Kustom (base URL sendiri)",
    baseUrl: "",
    models: [],
    hint: "Server API apa pun yang kompatibel OpenAI (/chat/completions).",
  },
};

export const PROVIDER_IDS = Object.keys(PROVIDERS) as AiProviderId[];

/** Bentuk ringkas setting — sudah dalam plaintext (apiKey sudah didekripsi server). */
export interface AiSettingInput {
  provider: string;
  baseUrl?: string | null;
  apiKey?: string | null;
  model?: string | null;
}

export interface ResolvedAiConfig {
  provider: string;
  baseUrl: string;
  apiKey: string | null;
  model: string;
  source: "user" | "admin";
}

function isKnownProvider(p: string): p is AiProviderId {
  return p in PROVIDERS;
}

/** Setting dianggap valid bila provider diisi dan punya kunci (kecuali ollama). */
function settingUsable(s: AiSettingInput | null | undefined): boolean {
  if (!s || !s.provider) return false;
  if (isKnownProvider(s.provider) && PROVIDERS[s.provider].noKeyNeeded) {
    return true; // ollama — bebas kunci
  }
  return !!s.apiKey && s.apiKey.length > 0;
}

function materialize(s: AiSettingInput, source: "user" | "admin"): ResolvedAiConfig | null {
  const provider = isKnownProvider(s.provider) ? s.provider : "custom";
  const preset = PROVIDERS[provider];
  const baseUrl = (s.baseUrl && s.baseUrl.trim()) || preset.baseUrl;
  // custom tanpa baseUrl tidak bisa dipakai.
  if (!baseUrl) return null;
  const model = (s.model && s.model.trim()) || preset.models[0] || "";
  return { provider, baseUrl: baseUrl.replace(/\/+$/, ""), apiKey: s.apiKey || null, model, source };
}

/**
 * Tentukan config aktif: punya user menang, sisanya fallback ke default
 * admin (jika ada). Return null bila tidak ada yang bisa dipakai.
 */
export function resolveAiConfig(
  userSetting: AiSettingInput | null,
  adminDefault: AiSettingInput | null
): ResolvedAiConfig | null {
  if (userSetting && settingUsable(userSetting)) return materialize(userSetting, "user");
  if (adminDefault && settingUsable(adminDefault)) return materialize(adminDefault, "admin");
  return null;
}

/** URL chat completions dari base URL (trailing slash dibuang). */
export function chatEndpoint(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "") + "/chat/completions";
}

/**
 * Rapikan detail error upstream utk ditampilkan ke user.
 * OpenRouter menaruh respons mentah provider di error.metadata.raw (string
 * JSON bertingkat) — coba ambil pesan terdalam yang paling manusiawi.
 */
export function cleanUpstreamDetail(detail: string | null | undefined): string | null {
  if (!detail) return null;
  let cur: unknown = detail;
  for (let i = 0; i < 3; i++) {
    if (typeof cur === "string") {
      const t = cur.trim();
      if (t.startsWith("{") || t.startsWith("[")) {
        try {
          cur = JSON.parse(t);
          continue;
        } catch {
          /* bukan JSON */
        }
      }
      return t.length > 0 ? t : null;
    }
    if (cur && typeof cur === "object") {
      const o = cur as Record<string, unknown>;
      const next = (o.error ?? o) as Record<string, unknown>;
      if (next && typeof next === "object" && "message" in next) {
        const m = next.message;
        if (typeof m === "string" && m.trim()) return m.trim();
      }
      if (typeof o.message === "string" && o.message.trim()) return o.message.trim();
      return JSON.stringify(o).slice(0, 200);
    }
    return null;
  }
  return null;
}

/** Mask kunci untuk ditampilkan, mis. "sk-…abcd" (4 char terakhir). */
export function maskKey(key: string | null | undefined): string | null {
  if (!key) return null;
  if (key.length <= 8) return "••••";
  return `${key.slice(0, 3)}…${key.slice(-4)}`;
}

/**
 * Pesan error provider dalam Bahasa Indonesia untuk status HTTP upstream —
 * dipakai bersama oleh /api/ai/chat (Teman AI) dan /api/ai/study (Pusat
 * Belajar) agar pengalamannya konsisten.
 */
export function providerErrorMessage(status: number, detailRaw: string | null): string {
  const detail = cleanUpstreamDetail(detailRaw);
  if (status === 401 || status === 403) {
    return "API key tidak valid/ditolak provider. Periksa kunci API di pengaturan Teman AI" +
      (detail ? ` (${detail.slice(0, 160)})` : "") +
      ".";
  }
  if (status === 429) {
    return (
      "Model sedang kena limit (429) — API key kamu tidak bermasalah. " +
      "Model berakhiran ‘:free’ berbagi kuota publik yang sering penuh; " +
      "tunggu beberapa menit, atau ganti ke model lain di pengaturan (mis. tanpa ‘:free’)." +
      (detail ? ` (${detail.slice(0, 160)})` : "")
    );
  }
  if (status === 402) {
    return "Kredit provider tidak cukup (402). Tambah kredit akun provider, atau pilih model gratis (:free) di pengaturan.";
  }
  if (status === 404) {
    return "Endpoint/model tidak ditemukan di provider (404). Periksa Base URL dan nama model di pengaturan.";
  }
  if (detail && /location is not supported|blokir wilayah/i.test(detail)) {
    return "Model ini menolak permintaan dari lokasi server (pembatasan wilayah provider). Ganti ke model lain di pengaturan — API key kamu tidak bermasalah.";
  }
  return `Provider AI menjawab error (HTTP ${status})${detail ? `: ${detail.slice(0, 160)}` : ""}.`;
}

/** Label Indonesia untuk id provider (aman utk id tak dikenal). */
export function providerLabel(provider: string | null | undefined): string {
  if (!provider) return "—";
  if (isKnownProvider(provider)) return PROVIDERS[provider].label;
  return provider;
}
