// ─────────────────────────────────────────────────────────────────────
// ai-tts.ts — Suara AI untuk fitur "Bacakan" Aula Reader (Task 31).
//
// Dua jalur sintesis (dipakai berurutan — provider dulu, lalu lokal):
//   1. PROVIDER Cloud  — kategori config AI "tts" (rantai fallback):
//      POST <baseUrl>/audio/speech  (kompatibel OpenAI TTS:
//      { model, input, voice, response_format: "mp3" })
//      → audio/mpeg. Contoh: OpenAI gpt-4o-mini-tts / tts-1.
//   2. PIPER LOKAL     — bila chain kosong / semua gagal: model TTS
//      offline (Piper, lisasi MIT) DIUNDUH OTOMATIS oleh server SEKALI
//      (biner ±30 MB + voice Indonesia id_ID-news_tts ±60 MB) lalu
//      dipakai selamanya tanpa internet. "Kalo yg model bikin lokal jadi
//      harus didownload." (Ganti voice via AI_TTS_PIPER_VOICE — daftar
//      nama di huggingface.co/rhasspy/piper-voices.)
//
// Env:
//   AI_TTS_PIPER_DISABLE=1      — matikan jalur Piper (hanya provider).
//   AI_TTS_PIPER_DIR            — dir aset Piper (default .tts-piper).
//   AI_TTS_PIPER_VOICE          — voice Piper (default id_ID-arifi-medium;
//                                 nama lain: lihat rhasspy/piper-voices).
//   AI_TTS_PIPER_BIN_URL        — override URL tar.gz biner Piper.
//   AI_TTS_PIPER_MODEL_URL      — override URL .onnx voice.
//   AI_TTS_PIPER_MODEL_URL_JSON — override URL .onnx.json (config voice).
//   AI_TTS_CACHE_DIR            — dir cache audio (default .tts-cache).
// ─────────────────────────────────────────────────────────────────────

import { createWriteStream, promises as fsp } from "fs";
import { execFile } from "child_process";
import { createHash } from "crypto";
import path from "path";
import { Readable } from "stream";
import { pipeline } from "stream/promises";

import { resolveChain } from "@/lib/ai-config-chain";
import { PROVIDERS, ttsEndpoint, type ResolvedAiConfig } from "@/lib/ai-providers";

export const MAX_TTS_TEXT = 3000;
export const DEFAULT_TTS_VOICE = "alloy";

// ── Direktori ─────────────────────────────────────────────────────────

function piperDir(): string {
  return process.env.AI_TTS_PIPER_DIR || path.join(process.cwd(), ".tts-piper");
}
function cacheDir(): string {
  return process.env.AI_TTS_CACHE_DIR || path.join(process.cwd(), ".tts-cache");
}

// ── Status unduhan Piper (dibagikan ke route /prepare) ────────────────

export interface PiperStatus {
  disabled: boolean;
  ready: boolean;
  downloading: boolean;
  /** 0..100 (estimasi dari Content-Length bila tersedia). */
  pct: number;
  stage: string;
  voice: string;
  error: string | null;
}

const piperState: PiperStatus = {
  disabled: process.env.AI_TTS_PIPER_DISABLE === "1",
  ready: false,
  downloading: false,
  pct: 0,
  stage: "belum diperiksa",
  // Voice Indonesia resmi piper-voices (id/id_ID/news_tts/medium).
  voice: process.env.AI_TTS_PIPER_VOICE || "id_ID-news_tts-medium",
  error: null,
};

export function getPiperStatus(): PiperStatus {
  return { ...piperState, voice: piperState.voice };
}

// ── Unduh file dengan progres (tanpa dependensi) ─────────────────────

async function downloadToFile(url: string, dest: string, label: string): Promise<void> {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok || !res.body) {
    throw new Error(`Gagal mengunduh ${label} (HTTP ${res.status})`);
  }
  const total = Number(res.headers.get("content-length")) || 0;
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  let received = 0;
  const t0 = Date.now();
  const body = Readable.fromWeb(res.body as never);
  body.on("data", (chunk: Buffer) => {
    received += chunk.length;
    if (total > 0) {
      piperState.pct = Math.min(99, Math.round((received / total) * 100));
    } else {
      piperState.pct = Math.min(95, Math.round(received / 1_000_000)); // ±MB
    }
    // Laporan stage ringkas tiap ±3 dtk.
    const secs = (Date.now() - t0) / 1000;
    if (secs > 3) {
      piperState.stage = `mengunduh ${label} — ${(received / 1_048_576).toFixed(1)} MB`;
    }
  });
  await pipeline(body, createWriteStream(dest));
}

/** Ekstrak tar.gz dengan perintah `tar` sistem (tersedia di Linux/macOS). */
function extractTarGz(tarPath: string, destDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("tar", ["-xzf", tarPath, "-C", destDir], { timeout: 120_000 }, (err) => {
      if (err) reject(new Error(`Gagal mengekstrak arsip Piper: ${String(err)}`));
      else resolve();
    });
  });
}

// ── Pastikan aset Piper ada (single-flight) ───────────────────────────

let preparePromise: Promise<void> | null = null;

const PIPER_BIN_URL =
  process.env.AI_TTS_PIPER_BIN_URL ||
  "https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_linux_x86_64.tar.gz";

function piperVoiceUrls(voice: string): { onnx: string; json: string } {
  if (process.env.AI_TTS_PIPER_MODEL_URL) {
    return {
      onnx: process.env.AI_TTS_PIPER_MODEL_URL,
      json:
        process.env.AI_TTS_PIPER_MODEL_URL_JSON ||
        process.env.AI_TTS_PIPER_MODEL_URL + ".json",
    };
  }
  // "id_ID-news_tts-medium" → id/id_ID/news_tts/medium/id_ID-news_tts-medium.onnx
  // (repo rhasspy/piper-voices, cabang "main").
  const m = /^([a-z]{2}(?:_[A-Z]{2})?)-([a-z0-9_]+)-(medium|low|x_low|high)$/i.exec(voice);
  const parts = m
    ? [m[1].split("_")[0], m[1], m[2], m[3]]
    : ["id", "id_ID", "news_tts", "medium"];
  const base = `https://huggingface.co/rhasspy/piper-voices/resolve/main/${parts.join("/")}/${voice}`;
  return { onnx: base + ".onnx", json: base + ".onnx.json" };
}

async function ensurePiperAssetsInner(): Promise<void> {
  const dir = piperDir();
  const binPath = path.join(dir, "piper", "piper");
  const voice = piperState.voice;
  const voiceDir = path.join(dir, "voice");
  const modelPath = path.join(voiceDir, "model.onnx");
  const modelJsonPath = path.join(voiceDir, "model.onnx.json");

  const needBin = await fsp
    .access(binPath)
    .then(() => false)
    .catch(() => true);
  const needVoice = await fsp
    .access(modelPath)
    .then(() => false)
    .catch(() => true);

  if (!needBin && !needVoice) {
    piperState.ready = true;
    piperState.pct = 100;
    piperState.stage = "siap";
    return;
  }

  piperState.downloading = true;
  piperState.error = null;
  piperState.pct = 0;
  try {
    if (needBin) {
      piperState.stage = "mengunduh mesin suara Piper (±30 MB)…";
      const tarPath = path.join(dir, "piper.tar.gz");
      await downloadToFile(PIPER_BIN_URL, tarPath, "mesin Piper");
      await fsp.mkdir(dir, { recursive: true });
      piperState.stage = "mengekstrak mesin Piper…";
      await extractTarGz(tarPath, dir);
      await fsp.rm(tarPath, { force: true });
    }
    if (needVoice) {
      piperState.pct = Math.min(piperState.pct, 45);
      piperState.stage = `mengunduh voice ${voice} (±60 MB)…`;
      const urls = piperVoiceUrls(voice);
      await downloadToFile(urls.onnx, modelPath, `voice ${voice}`);
      piperState.stage = "mengunduh konfigurasi voice…";
      await downloadToFile(urls.json, modelJsonPath, "konfigurasi voice");
    }
    piperState.ready = true;
    piperState.pct = 100;
    piperState.stage = "siap";
  } catch (e) {
    piperState.error = String((e as Error)?.message ?? e);
    piperState.ready = false;
    throw e;
  } finally {
    piperState.downloading = false;
  }
}

/** Pastikan biner + voice Piper siap (idempoten; dipanggil route prepare). */
export function ensurePiperAssets(): Promise<void> {
  if (piperState.disabled) {
    return Promise.reject(new Error("Suara AI lokal dimatikan (AI_TTS_PIPER_DISABLE=1)."));
  }
  if (preparePromise) return preparePromise;
  preparePromise = ensurePiperAssetsInner().finally(() => {
    preparePromise = null;
  });
  return preparePromise;
}

// ── Sintesis Piper ────────────────────────────────────────────────────

function piperBinPath(): string {
  return path.join(piperDir(), "piper", "piper");
}

async function synthesizePiper(text: string): Promise<{ buffer: Buffer; mime: string }> {
  const bin = piperBinPath();
  const modelPath = path.join(piperDir(), "voice", "model.onnx");
  const modelJsonPath = path.join(piperDir(), "voice", "model.onnx.json");
  await fsp.access(bin);
  await fsp.access(modelPath);

  const outPath = path.join(cacheDir(), `piper-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.wav`);
  await fsp.mkdir(path.dirname(outPath), { recursive: true });

  // Piper membaca stdin baris-per-baris → satu utas kalimat.
  const input = text.replace(/\s+/g, " ").trim() + "\n";
  await new Promise<void>((resolve, reject) => {
    const child = execFile(
      bin,
      ["-m", modelPath, "-c", modelJsonPath, "-f", outPath],
      { timeout: 60_000, maxBuffer: 1024 * 1024 },
      (err) => (err ? reject(new Error(`Piper gagal: ${String(err)}`)) : resolve())
    );
    if (child.stdin) {
      child.stdin.on("error", () => undefined); // EPIPE bila piper mati lebih dulu
      child.stdin.write(input);
      child.stdin.end();
    }
  });

  const buffer = await fsp.readFile(outPath);
  await fsp.rm(outPath, { force: true }).catch(() => undefined);
  if (!buffer.length || buffer.length < 44) {
    throw new Error("Piper menghasilkan audio kosong");
  }
  return { buffer, mime: "audio/wav" };
}

// ── Sintesis via provider cloud (/audio/speech) ──────────────────────

export interface TtsSynthesis {
  buffer: Buffer;
  mime: string;
  /** "provider" | "piper" */
  source: "provider" | "piper";
  provider: string;
  model: string;
  voice: string;
  /** Kegagalan entri provider sebelum sukses (utk pesan). */
  failures: Array<{ provider: string; model: string; detail: string }>;
}

/** Model TTS efektif untuk entri chain kategori tts. */
function effectiveTtsModel(cfg: ResolvedAiConfig): string {
  const preset = PROVIDERS[cfg.provider as keyof typeof PROVIDERS];
  const ttsDefault = preset?.ttsModels?.[0];
  if (ttsDefault && (!cfg.model || preset?.models?.includes(cfg.model))) {
    // Model tidak diisi / masih model chat preset → pakai model TTS preset.
    return ttsDefault;
  }
  return cfg.model;
}

async function ttsViaProvider(
  cfg: ResolvedAiConfig,
  text: string,
  voice: string
): Promise<{ buffer: Buffer; mime: string; model: string }> {
  const model = effectiveTtsModel(cfg);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const res = await fetch(ttsEndpoint(cfg.baseUrl), {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model,
        input: text,
        voice,
        response_format: "mp3",
        speed: 1,
      }),
    });
    if (!res.ok) {
      let detail = "";
      try {
        const j = await res.json().catch(() => null);
        detail = String(j?.error?.message ?? j?.message ?? "").slice(0, 160);
      } catch {
        /* abaikan */
      }
      throw new Error(`HTTP ${res.status}${detail ? `: ${detail}` : ""}`);
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    if (!buffer.length) throw new Error("respons audio kosong");
    const mime = res.headers.get("content-type") || "audio/mpeg";
    return { buffer, mime: mime.split(";")[0], model };
  } finally {
    clearTimeout(timer);
  }
}

// ── Cache audio ───────────────────────────────────────────────────────

function cacheKey(source: string, model: string, voice: string, text: string): string {
  return createHash("sha1").update(`${source}|${model}|${voice}|${text}`).digest("hex");
}

interface CacheMeta {
  mime: string;
  source: "provider" | "piper";
  provider: string;
  model: string;
  voice: string;
}

async function readCache(
  key: string
): Promise<{ buffer: Buffer; meta: CacheMeta } | null> {
  try {
    const [buffer, metaRaw] = await Promise.all([
      fsp.readFile(path.join(cacheDir(), `${key}.bin`)),
      fsp.readFile(path.join(cacheDir(), `${key}.json`), "utf8"),
    ]);
    if (!buffer.length) return null;
    return { buffer, meta: JSON.parse(metaRaw) as CacheMeta };
  } catch {
    return null;
  }
}

async function writeCache(key: string, buffer: Buffer, meta: CacheMeta): Promise<void> {
  try {
    const dir = cacheDir();
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, `${key}.bin`), buffer);
    await fsp.writeFile(path.join(dir, `${key}.json`), JSON.stringify(meta));
  } catch {
    /* cache gagal bukan fatal */
  }
}

// ── Sintesis utama (dipakai route) ────────────────────────────────────

export interface TtsOptions {
  voice?: string;
  /** true = boleh mengunduh aset Piper (menunggu menit pertama kali). */
  waitDownload?: boolean;
  userId: string | null;
}

/**
 * Sintesis suara AI: chain provider kategori "tts" → fallback Piper lokal.
 * TIDAK melempar untuk kegagalan provider (dicatat di failures); melempar
 * hanya bila keduanya gagal (pesan siap tampil).
 */
export async function synthesizeSpeech(
  text: string,
  opts: TtsOptions
): Promise<TtsSynthesis> {
  const clean = String(text ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_TTS_TEXT);
  if (!clean) throw new Error("Teks kosong — tidak ada yang bisa dibacakan.");
  const voice = opts.voice || DEFAULT_TTS_VOICE;
  const failures: TtsSynthesis["failures"] = [];

  // 1) Chain provider kategori tts.
  const chain = await resolveChain(opts.userId, "tts");
  for (const cfg of chain) {
    try {
      const model = effectiveTtsModel(cfg);
      const key = cacheKey("provider", `${cfg.provider}/${model}`, voice, clean);
      const hit = await readCache(key);
      if (hit) return { buffer: hit.buffer, ...hit.meta, source: "provider", failures };
      const r = await ttsViaProvider(cfg, clean, voice);
      const out: TtsSynthesis = {
        buffer: r.buffer,
        mime: r.mime,
        source: "provider",
        provider: cfg.provider,
        model: r.model,
        voice,
        failures,
      };
      await writeCache(key, r.buffer, {
        mime: r.mime,
        source: "provider",
        provider: cfg.provider,
        model: r.model,
        voice,
      });
      return out;
    } catch (e) {
      failures.push({
        provider: cfg.provider,
        model: effectiveTtsModel(cfg),
        detail: String((e as Error)?.message ?? e).slice(0, 160),
      });
    }
  }

  // 2) Piper lokal — unduh aset bila perlu.
  if (!piperState.disabled) {
    const piperReady = await fsp
      .access(piperBinPath())
      .then(() => true)
      .catch(() => false);
    if (!piperReady && opts.waitDownload) {
      await ensurePiperAssets();
    }
    if (piperReady || opts.waitDownload) {
      const key = cacheKey("piper", piperState.voice, "-", clean);
      const hit = await readCache(key);
      if (hit) return { buffer: hit.buffer, ...hit.meta, source: "piper", failures };
      const r = await synthesizePiper(clean);
      const out: TtsSynthesis = {
        buffer: r.buffer,
        mime: r.mime,
        source: "piper",
        provider: "piper",
        model: `piper/${piperState.voice}`,
        voice: piperState.voice,
        failures,
      };
      await writeCache(key, r.buffer, {
        mime: r.mime,
        source: "piper",
        provider: "piper",
        model: `piper/${piperState.voice}`,
        voice: piperState.voice,
      });
      return out;
    }
    // Aset belum ada & tidak boleh menunggu unduhan → sinyal 423.
    const err = new Error(
      "Suara AI lokal belum terunduh — ketuk sekali lagi untuk mengunduh (±90 MB, sekali saja)."
    ) as Error & { needDownload?: boolean };
    err.needDownload = true;
    throw err;
  }

  throw new Error(
    "Tidak ada AI suara yang bisa dipakai" +
      (failures.length
        ? ` — ${failures.map((f) => `${f.provider}: ${f.detail}`).join("; ")}`
        : " — isi kategori Suara AI di pengaturan AI, atau aktifkan suara lokal.") +
      ". Mode suara perangkat tetap bisa dipakai."
  );
}

/** Info konfigurasi utk UI (apakah provider tts terpasang). */
export async function ttsProviderConfigured(userId: string | null): Promise<boolean> {
  const chain = await resolveChain(userId, "tts");
  return chain.length > 0;
}
