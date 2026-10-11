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
//   AI_TTS_PIPER_DIR            — dir aset Piper (default: dir writable
//                                 pertama dari <cwd>/.tts-piper lalu
//                                 <tmpdir>/.tts-piper — Task 32: cwd di
//                                 hosting serverless = /var/task read-only,
//                                 fallback ke /tmp WAJIB, tanpa ENOENT mentah).
//   AI_TTS_PIPER_VOICE          — voice Piper (default id_ID-arifi-medium;
//                                 nama lain: lihat rhasspy/piper-voices).
//   AI_TTS_PIPER_BIN_URL        — override URL tar.gz biner Piper.
//   AI_TTS_PIPER_MODEL_URL      — override URL .onnx voice.
//   AI_TTS_PIPER_MODEL_URL_JSON — override URL .onnx.json (config voice).
//   AI_TTS_PIPER_TIMEOUT_MS     — batas unduh per berkas (default 90 dtk).
//   AI_TTS_CACHE_DIR            — dir cache audio (default .tts-cache,
//                                 resolusi writable sama seperti Piper).
// ─────────────────────────────────────────────────────────────────────

import { createWriteStream, promises as fsp } from "fs";
import { execFile } from "child_process";
import { createHash } from "crypto";
import path from "path";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import * as tar from "tar";

import { resolveChain } from "@/lib/ai-config-chain";
import { PROVIDERS, ttsEndpoint, type ResolvedAiConfig } from "@/lib/ai-providers";
import {
  NO_WRITABLE_DIR_MESSAGE,
  friendlyPiperError,
  piperExecErrorMessage,
  resolveWritableBase,
  type ResolvedWritableDir,
} from "@/lib/tts-piper-paths";

export const MAX_TTS_TEXT = 3000;
export const DEFAULT_TTS_VOICE = "alloy";

// ── Direktori (Task 32: resolusi WRITABLE dgn fallback) ──────────────
// Urutan: env eksplisit → <cwd>/<nama> (self-host) → <tmpdir>/<nama>
// (serverless). Setiap kandidat lolos UJI TULIS sebelum dipakai, jadi
// hosting read-only (/var/task) tidak pernah lagi menghasilkan ENOENT.

let piperDirMemo: ResolvedWritableDir | null | undefined;
let cacheDirMemo: ResolvedWritableDir | null | undefined;

function piperDirInfo(): ResolvedWritableDir | null {
  if (piperDirMemo === undefined) {
    piperDirMemo = resolveWritableBase(process.env.AI_TTS_PIPER_DIR, ".tts-piper");
  }
  return piperDirMemo;
}
function cacheDirInfo(): ResolvedWritableDir | null {
  if (cacheDirMemo === undefined) {
    cacheDirMemo = resolveWritableBase(process.env.AI_TTS_CACHE_DIR, ".tts-cache");
  }
  return cacheDirMemo;
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
  /** Direktori aset yang DIPILIH (null = tak ada yang writable). */
  dir: string | null;
  /** Asal direktori: env | app (cwd) | tmp (fallback serverless). */
  dirSource: "env" | "app" | "tmp" | null;
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
  dir: null,
  dirSource: null,
};

export function getPiperStatus(): PiperStatus {
  const info = piperDirInfo();
  return {
    ...piperState,
    voice: piperState.voice,
    dir: info?.dir ?? null,
    dirSource: info?.source ?? null,
  };
}

// ── Unduh file dengan progres (tanpa dependensi) ─────────────────────

async function downloadToFile(url: string, dest: string, label: string): Promise<void> {
  const timeoutMs = Math.max(5_000, Number(process.env.AI_TTS_PIPER_TIMEOUT_MS) || 90_000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, { redirect: "follow", signal: controller.signal });
  } catch (e) {
    clearTimeout(timer);
    const cause = (e as Error & { cause?: { message?: string } })?.cause?.message;
    throw new Error(
      `Gagal terhubung saat mengunduh ${label}: ${String(cause ?? (e as Error)?.message ?? e).slice(0, 120)}`
    );
  }
  if (!res.ok || !res.body) {
    clearTimeout(timer);
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
  try {
    await pipeline(body, createWriteStream(dest));
  } finally {
    clearTimeout(timer);
  }
}

/** Ekstrak tar.gz lewat pustaka `tar` npm — TANPA perintah sistem (Task 32:
 * runtime serverless minimalis bisa saja tanpa biner `tar`). */
function extractTarGz(tarPath: string, destDir: string): Promise<void> {
  return tar.x({ file: tarPath, cwd: destDir, strict: true });
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
  // Task 32: pastikan ada direktori WRITABLE sebelum menyentuh jaringan —
  // hosting read-only (/var/task) harus gagal dengan pesan ramah, bukan
  // ENOENT mentah dari mkdir di tengah unduhan.
  const info = piperDirInfo();
  if (!info) {
    piperState.error = NO_WRITABLE_DIR_MESSAGE;
    piperState.stage = "tidak ada direktori writable";
    throw new Error(NO_WRITABLE_DIR_MESSAGE);
  }
  const dir = info.dir;
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
  const needJson = await fsp
    .access(modelJsonPath)
    .then(() => false)
    .catch(() => true);

  if (!needBin && !needVoice && !needJson) {
    piperState.ready = true;
    piperState.pct = 100;
    piperState.stage = "siap";
    piperState.error = null;
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
      piperState.stage = "mengekstrak mesin Piper…";
      await extractTarGz(tarPath, dir);
      await fsp.rm(tarPath, { force: true });
    }
    if (needVoice || needJson) {
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
    // Task 32: simpan pesan RAMAH (bukan galat mentah) — status ini yang
    // dibaca polling klien dan ditampilkan di toast pengguna.
    piperState.error = friendlyPiperError(e);
    piperState.ready = false;
    throw new Error(piperState.error);
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

async function synthesizePiper(text: string): Promise<{ buffer: Buffer; mime: string }> {
  const info = piperDirInfo();
  if (!info) {
    // Tak seharusnya sampai sini (aset sudah diverifikasi), tapi tetap aman.
    throw new Error(NO_WRITABLE_DIR_MESSAGE);
  }
  const bin = path.join(info.dir, "piper", "piper");
  const modelPath = path.join(info.dir, "voice", "model.onnx");
  const modelJsonPath = path.join(info.dir, "voice", "model.onnx.json");
  await fsp.access(bin);
  await fsp.access(modelPath);

  // WAV keluaran: pakai cache dir bila writable, selain itu dir Piper
  // (pasti writable — aset barusan diunduh/diextract ke sana).
  const outDir = cacheDirInfo()?.dir ?? info.dir;
  const outPath = path.join(outDir, `piper-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.wav`);
  await fsp.mkdir(path.dirname(outPath), { recursive: true });

  // Piper membaca stdin baris-per-baris → satu utas kalimat.
  const input = text.replace(/\s+/g, " ").trim() + "\n";
  await new Promise<void>((resolve, reject) => {
    const child = execFile(
      bin,
      ["-m", modelPath, "-c", modelJsonPath, "-f", outPath],
      { timeout: 60_000, maxBuffer: 1024 * 1024 },
      (err) => (err ? reject(new Error(piperExecErrorMessage(err))) : resolve())
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
  const dir = cacheDirInfo()?.dir;
  if (!dir) return null;
  try {
    const [buffer, metaRaw] = await Promise.all([
      fsp.readFile(path.join(dir, `${key}.bin`)),
      fsp.readFile(path.join(dir, `${key}.json`), "utf8"),
    ]);
    if (!buffer.length) return null;
    return { buffer, meta: JSON.parse(metaRaw) as CacheMeta };
  } catch {
    return null;
  }
}

async function writeCache(key: string, buffer: Buffer, meta: CacheMeta): Promise<void> {
  try {
    const dir = cacheDirInfo()?.dir;
    if (!dir) return; // tanpa dir writable → cache dilewati (bukan fatal)
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

  // 2) Piper lokal — unduh aset bila perlu. (Task 32: semua kegagalan
  //    Piper dibungkus pesan ramah — tidak ada galat mentah yang bocor.)
  if (!piperState.disabled) {
    try {
      const info = piperDirInfo();
      if (!info) {
        // Hosting tanpa dir writable: langsung pesan ramah (bukan 423 —
        // "ketuk lagi utk unduh" akan menyesatkan di hosting read-only).
        throw new Error(NO_WRITABLE_DIR_MESSAGE);
      }
      // "Siap" = biner + model + konfigurasi LENGKAP (bukan sekadar biner —
      // unduhan yang terputus di tengah harus dicoba ulang, bukan gagal
      // sintesis dengan ENOENT access model.onnx).
      const assetExists = (p: string) =>
        fsp.access(p).then(
          () => true,
          () => false
        );
      const piperReady =
        (await assetExists(path.join(info.dir, "piper", "piper"))) &&
        (await assetExists(path.join(info.dir, "voice", "model.onnx"))) &&
        (await assetExists(path.join(info.dir, "voice", "model.onnx.json")));
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
    } catch (e) {
      const err = e as Error & { needDownload?: boolean };
      if (err.needDownload) throw err; // sinyal 423 — diteruskan apa adanya
      failures.push({
        provider: "piper",
        model: `piper/${piperState.voice}`,
        detail: friendlyPiperError(err).slice(0, 160),
      });
      throw new Error(friendlyPiperError(err));
    }
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
