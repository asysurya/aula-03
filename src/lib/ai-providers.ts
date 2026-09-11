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
      "openai/gpt-4o-mini",
      "meta-llama/llama-3.3-70b-instruct:free",
      "google/gemini-2.0-flash-exp:free",
    ],
    hint: "Satu kunci untuk banyak model — ada pilihan gratis.",
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

/** Mask kunci untuk ditampilkan, mis. "sk-…abcd" (4 char terakhir). */
export function maskKey(key: string | null | undefined): string | null {
  if (!key) return null;
  if (key.length <= 8) return "••••";
  return `${key.slice(0, 3)}…${key.slice(-4)}`;
}

/** Label Indonesia untuk id provider (aman utk id tak dikenal). */
export function providerLabel(provider: string | null | undefined): string {
  if (!provider) return "—";
  if (isKnownProvider(provider)) return PROVIDERS[provider].label;
  return provider;
}
