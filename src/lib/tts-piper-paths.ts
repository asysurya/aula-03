// ─────────────────────────────────────────────────────────────────────
// tts-piper-paths.ts — resolusi direktori WRITABLE utk aset TTS lokal
// (Task 32). Modul MURNI (fs/path/os saja) supaya bisa diuji unit.
//
// MASALAH yang diperbaiki (laporan user produksi):
//   "Suara AI gagal — melanjutkan dengan suara perangkat.
//    ENOENT: no such file or directory, mkdir '/var/task/.tts-piper'"
// Default lama `<cwd>/.tts-piper` — di hosting serverless (Vercel /
// AWS Lambda) cwd = /var/task yang READ-ONLY → mkdir melempar galat
// mentah yang bocor sampai ke toast pengguna.
//
// Urutan kandidat (yang pertama lolos UJI TULIS dipakai):
//   1. env eksplisit  — AI_TTS_PIPER_DIR / AI_TTS_CACHE_DIR
//   2. <cwd>/<nama>   — self-host: aset bertahan sebelah aplikasi
//   3. <tmpdir>/<nama>— serverless: /tmp (Lambda/Vercel) selalu writable
// Uji tulis = mkdir -p + tulis berkas probe + hapus (FS read-only gagal,
// termasuk FS yang mengizinkan mkdir tapi menolak tulis berkas).
// Bila SEMUA kandidat gagal → null; pemanggil wajib menampilkan pesan
// ramah (NO_WRITABLE_DIR_MESSAGE), BUKAN galat mentah.
// ─────────────────────────────────────────────────────────────────────

import { mkdirSync, rmSync, writeFileSync } from "fs";
import os from "os";
import path from "path";

export type WritableDirSource = "env" | "app" | "tmp";

export interface ResolvedWritableDir {
  dir: string;
  source: WritableDirSource;
}

/** Apakah `dir` benar-benar bisa dibuat & ditulis (uji tulis nyata). */
export function probeWritableDir(dir: string): boolean {
  try {
    mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, ".uji-tulis-tts");
    writeFileSync(probe, "ok");
    rmSync(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Pilih direktori writable pertama dari kandidat:
 * env (bila diisi) → <cwd>/<nama> → <tmpdir>/<nama>.
 * `probe` bisa disuntikkan utk pengujian unit (urutan & fallback).
 */
export function resolveWritableBase(
  envDir: string | undefined,
  name: string,
  probe: (dir: string) => boolean = probeWritableDir
): ResolvedWritableDir | null {
  const seen = new Set<string>();
  const candidates: Array<{ dir: string; source: WritableDirSource }> = [];
  if (envDir && envDir.trim()) candidates.push({ dir: envDir, source: "env" });
  candidates.push({ dir: path.join(process.cwd(), name), source: "app" });
  candidates.push({ dir: path.join(os.tmpdir(), name), source: "tmp" });
  for (const c of candidates) {
    if (seen.has(c.dir)) continue;
    seen.add(c.dir);
    if (probe(c.dir)) return { dir: c.dir, source: c.source };
  }
  return null;
}

/** Pesan ramah saat TIDAK ADA direktori writable sama sekali. */
export const NO_WRITABLE_DIR_MESSAGE =
  "Hosting ini tidak menyediakan penyimpanan yang bisa ditulis untuk aset suara AI lokal (Piper). " +
  "Untuk hosting serverless (Vercel dsb.), isi kategori Suara di Pengaturan AI dengan provider TTS cloud " +
  "(kompatibel /audio/speech), atau set env AI_TTS_PIPER_DIR ke direktori yang bisa ditulis. " +
  "Mode suara perangkat tetap bisa dipakai.";

/** Panduan umum saat jalur Piper gagal (apa pun sebabnya). */
export const PIPER_GUIDANCE =
  "Bila berulang: isi kategori Suara di Pengaturan AI dengan provider TTS cloud, " +
  "atau jalankan Aula di server sendiri (self-host). Mode suara perangkat tetap bisa dipakai.";

/** Rangkai galat unduh/dir mentah jadi pesan yang bisa ditindaklanjuti. */
export function friendlyPiperError(raw: unknown): string {
  const s = String((raw as Error)?.message ?? raw ?? "");
  if (/ENOSPC/i.test(s)) {
    return "Penyimpanan server penuh (ENOSPC) — bersihkan direktori aset suara AI lokal.";
  }
  if (/fetch failed|ECONNREFUSED|ETIMEDOUT|ECONNRESET|UND_ERR|EAI_AGAIN/i.test(s)) {
    return "Server tidak bisa mengunduh aset suara AI (koneksi gagal). " + PIPER_GUIDANCE;
  }
  if (/abort/i.test(s)) {
    return "Unduhan aset suara AI kehabisan waktu. " + PIPER_GUIDANCE;
  }
  if (/ENOENT|ENOTDIR|EROFS|EACCES|EPERM/i.test(s)) {
    return NO_WRITABLE_DIR_MESSAGE;
  }
  return `Suara AI lokal gagal: ${s.slice(0, 140)}. ${PIPER_GUIDANCE}`;
}

/** Pesan khusus kegagalan MENJALANKAN biner Piper (spawn/exec). */
export function piperExecErrorMessage(raw: unknown): string {
  const s = String((raw as Error)?.message ?? raw ?? "");
  if (/EACCES|EPERM/i.test(s)) {
    return "Hosting ini memblokir jalannya mesin suara lokal (Piper). " + PIPER_GUIDANCE;
  }
  if (/ENOENT|ENOTDIR/i.test(s)) {
    return "Biner Piper tidak ditemukan — unduhan mungkin tidak lengkap. " + PIPER_GUIDANCE;
  }
  return `Piper gagal dijalankan: ${s.slice(0, 140)}. ${PIPER_GUIDANCE}`;
}
