// ── Import lampiran materi dari CLOUD (URL) & MOUNT (path server) ──────
// Melengkapi upload berkas (Task 24): materi juga bisa diambil dari
//   • CLOUD — tautan http/https apa pun, termasuk tautan berbagi populer
//     (Google Drive / Dropbox / OneDrive / GitHub) yang dinormalisasi
//     menjadi tautan unduh-langsung sebelum diambil server-side.
//   • MOUNT — berkas di folder server yang di-mount (NAS/drive bersama),
//     dibatasi ke root yang dikonfigurasi lewat env AI_MOUNT_ROOTS
//     (dipisah ":", path absolut). Bila env tidak diisi → fitur mati
//     dengan pesan jelas (mis. deploy serverless tanpa volume).
// Hasil impor masuk pipeline yang sama dengan upload: extractText()
// lalu disimpan ke AiAttachment dengan source "cloud" / "mount".

import { promises as fs } from "fs";
import path from "path";

const MAX_IMPORT_SIZE = 4 * 1024 * 1024; // 4 MB — sama dengan upload
const CLOUD_TIMEOUT_MS = 20_000;

/** Galat impor dengan kode HTTP untuk endpoint. */
export class ImportError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

/** Root folder server yang boleh dibaca untuk impor mount. */
export function mountRoots(): string[] {
  return (process.env.AI_MOUNT_ROOTS || "")
    .split(":")
    .map((s) => s.trim())
    .filter((s) => s.startsWith("/"));
}

// ── Normalisasi tautan cloud populer → unduh langsung ─────────────────

/**
 * Tautan berbagi → tautan unduh langsung (best-effort):
 *   drive.google.com/file/d/{id}/…   → drive.google.com/uc?export=download&id={id}
 *   dropbox.com/…                    → paksa ?dl=1
 *   1drv.ms / onedrive.live.com      → paksa ?download=1
 *   github.com/u/r/blob/…            → raw.githubusercontent.com/u/r/…
 * Tautan lain dikembalikan apa adanya.
 */
export function normalizeCloudUrl(input: string): string {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    throw new ImportError("URL tidak valid");
  }
  const host = u.hostname.toLowerCase().replace(/^www\./, "");

  if (host === "drive.google.com" || host === "docs.google.com") {
    let id: string | null = u.searchParams.get("id");
    if (!id) {
      const m = u.pathname.match(/\/(?:file|document)\/d\/([a-zA-Z0-9_-]{10,})/);
      id = m?.[1] ?? null;
    }
    if (id) return `https://drive.google.com/uc?export=download&id=${id}`;
  }

  if (host.endsWith("dropbox.com")) {
    u.searchParams.set("dl", "1");
    return u.toString();
  }

  if (
    host === "1drv.ms" ||
    host.endsWith("onedrive.live.com") ||
    host.endsWith("sharepoint.com")
  ) {
    u.searchParams.set("download", "1");
    return u.toString();
  }

  if (host === "github.com") {
    const m = u.pathname.match(/^\/([^/]+)\/([^/]+)\/blob\/(.+)$/);
    if (m) return `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}`;
  }

  return u.toString();
}

/** Guard SSRF dasar: hanya http/https publik (kecuali diizinkan env). */
function assertFetchable(u: URL): void {
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new ImportError("Hanya tautan http/https yang didukung");
  }
  if (process.env.AI_CLOUD_ALLOW_PRIVATE === "1") return; // E2E/localhost
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const priv =
    h === "localhost" ||
    h === "127.0.0.1" ||
    h === "0.0.0.0" ||
    h === "::1" ||
    /^127\./.test(h) ||
    /^10\./.test(h) ||
    /^192\.168\./.test(h) ||
    /^169\.254\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h);
  if (priv) {
    throw new ImportError("Tautan ke jaringan internal tidak diizinkan", 403);
  }
}

function nameFromResponse(res: Response, u: URL): string {
  const cd = res.headers.get("content-disposition") || "";
  const m = cd.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
  if (m?.[1]) {
    try {
      return decodeURIComponent(m[1]).slice(0, 120);
    } catch {
      return m[1].slice(0, 120);
    }
  }
  const base = u.pathname.split("/").filter(Boolean).pop();
  if (base) {
    try {
      return decodeURIComponent(base).slice(0, 120);
    } catch {
      return base.slice(0, 120);
    }
  }
  return `materi-${u.hostname}`;
}

export interface ImportedFile {
  name: string;
  mime: string;
  buf: Buffer;
  /** URL/path asal yang dikirim user (untuk ditampilkan di chip). */
  origin: string;
}

/** Ambil berkas dari tautan cloud → buffer + nama + mime. */
export async function importFromCloud(rawUrl: string): Promise<ImportedFile> {
  const direct = normalizeCloudUrl(rawUrl);
  let u: URL;
  try {
    u = new URL(direct);
  } catch {
    throw new ImportError("URL tidak valid");
  }
  assertFetchable(u);

  let res: Response;
  try {
    res = await fetch(u, {
      redirect: "follow",
      signal: AbortSignal.timeout(CLOUD_TIMEOUT_MS),
      headers: { "user-agent": "Aula-LMS/1.0 (impor materi)" },
    });
  } catch {
    throw new ImportError(
      "Gagal mengunduh dari tautan — periksa alamat & izin berbagi (harus 'siapa saja yang punya tautan')",
      502
    );
  }
  if (!res.ok) {
    throw new ImportError(`Sumber menjawab ${res.status} ${res.statusText}`, 502);
  }
  const declared = Number(res.headers.get("content-length") || 0);
  if (declared > MAX_IMPORT_SIZE) {
    throw new ImportError("Berkas terlalu besar (maks 4 MB)", 413);
  }
  const ab = await res.arrayBuffer().catch(() => null);
  if (!ab || ab.byteLength === 0) {
    throw new ImportError("Sumber kosong / tidak terbaca", 502);
  }
  if (ab.byteLength > MAX_IMPORT_SIZE) {
    throw new ImportError("Berkas terlalu besar (maks 4 MB)", 413);
  }
  const mime = (res.headers.get("content-type") || "").split(";")[0].trim();
  return {
    name: nameFromResponse(res, u),
    mime,
    buf: Buffer.from(ab),
    origin: rawUrl.trim().slice(0, 500),
  };
}

// ── Mount (path server) ───────────────────────────────────────────────

const MOUNT_MIME: Record<string, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  zip: "application/zip",
  epub: "application/epub+zip",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
};

/** Baca berkas dari folder mount yang diizinkan → buffer + nama + mime. */
export async function importFromMount(rawPath: string): Promise<ImportedFile> {
  const roots = mountRoots();
  if (!roots.length) {
    throw new ImportError(
      "Impor dari mount belum dikonfigurasi di server (AI_MOUNT_ROOTS)",
      501
    );
  }
  const p = (rawPath || "").trim();
  if (!p.startsWith("/")) {
    throw new ImportError("Gunakan path absolut, mis. /mnt/aula-materi/modul.pdf");
  }
  if (p.split("/").includes("..")) {
    // percobaan kabur dari root → tolak sebagai pelanggaran akses
    throw new ImportError("Path tidak boleh memuat '..'", 403);
  }

  // realpath menyelesaikan symlink & ".." — hasil HARUS di dalam root.
  let real: string;
  try {
    real = await fs.realpath(p);
  } catch {
    throw new ImportError(`Berkas tidak ditemukan di server: ${p}`, 404);
  }
  let ok = false;
  for (const r of roots) {
    let rr: string;
    try {
      rr = await fs.realpath(r);
    } catch {
      continue;
    }
    if (real === rr || real.startsWith(rr + "/")) {
      ok = true;
      break;
    }
  }
  if (!ok) {
    throw new ImportError(
      `Di luar folder materi yang diizinkan (${roots.join(", ")})`,
      403
    );
  }

  const st = await fs.stat(real).catch(() => null);
  if (!st || !st.isFile()) {
    throw new ImportError(`Bukan berkas biasa / tidak ditemukan: ${p}`, 404);
  }
  if (st.size > MAX_IMPORT_SIZE) {
    throw new ImportError("Berkas terlalu besar (maks 4 MB)", 413);
  }
  if (st.size === 0) {
    throw new ImportError("Berkas kosong", 400);
  }
  const buf = await fs.readFile(real);
  const name = path.basename(real);
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  return {
    name,
    mime: MOUNT_MIME[ext] ?? "application/octet-stream",
    buf,
    origin: p,
  };
}
