"use client";

// ─────────────────────────────────────────────────────────────────────────
// Folder upload (Task 38) — kumpulkan & validasi isi folder di sisi KLIEN.
//
// Dua sumber entry:
// 1. Input <input webkitdirectory> → FileList yang tiap File-nya membawa
//    `webkitRelativePath` ("Materi/bab 1/a.pdf").
// 2. Tarik-lepas folder ke zona drop → walker FileSystemEntry (Chrome/
//    Edge/Firefox; `webkitGetAsEntry` HARUS dipanggil sinkron di handler
//    drop — setelah handler kembali, entry-nya kadaluarsa di Chromium).
//
// Batas (dipakai di validasi): per berkas 1 GB (MAX_FILE_SIZE_MB), total
// folder 2 GB, maks 500 berkas, kedalaman relatif maks 30. Pemenuhan batas
// total dilakukan KLIEN saat antrean dibuat — server tetap menjaga batas
// per berkas di tiap request upload (jalur lama tidak berubah).
// ─────────────────────────────────────────────────────────────────────────

import {
  MAX_FILE_SIZE_MB,
  MAX_FOLDER_UPLOAD_FILES,
  MAX_FOLDER_UPLOAD_TOTAL_BYTES,
  MAX_FOLDER_PATH_DEPTH,
} from "@/lib/constants";

/** Satu berkas dalam unggahan folder + jalur relatifnya ("root/sub/a.pdf"). */
export interface FolderEntry {
  file: File;
  relPath: string;
}

/** Hasil validasi satu batch unggahan folder. */
export interface FolderValidation {
  /** false bila batch DITOLAK seluruhnya (total melebihi batas / kosong). */
  ok: boolean;
  /** alasan penolakan batch: "TOO_LARGE_TOTAL" | "TOO_MANY_FILES" | "EMPTY" */
  code?: "TOO_LARGE_TOTAL" | "TOO_MANY_FILES" | "EMPTY";
  /** berkas sah yang boleh masuk antrean */
  valid: FolderEntry[];
  /** berkas yang DILEWATI (> 1 GB, atau kosong 0 byte) — tidak membatalkan sisanya */
  skipped: { name: string; size: number; reason: "LARGE" | "EMPTY" }[];
  /** total byte berkas sah */
  totalBytes: number;
  /** nama folder akar (segmen pertama relPath; "" bila file tanpa folder) */
  rootName: string;
}

/** Pisahkan direktori dari jalur relatif ("a/b/c.txt" → "a/b"). */
export function dirOf(relPath: string): string {
  const i = relPath.lastIndexOf("/");
  return i === -1 ? "" : relPath.slice(0, i);
}

/** Nama folder akar ("Materi/sub/x.pdf" → "Materi"; file lepas → ""). */
export function rootNameOf(entries: FolderEntry[]): string {
  for (const e of entries) {
    const i = e.relPath.indexOf("/");
    if (i > 0) return e.relPath.slice(0, i);
  }
  return "";
}

/** Kedalaman maksimum jalur relatif dalam batch ("a/b/c.txt" → 3). */
export function maxDepthOf(entries: FolderEntry[]): number {
  let max = 0;
  for (const e of entries) {
    const d = e.relPath.split("/").filter(Boolean).length;
    if (d > max) max = d;
  }
  return max;
}

/** Pecah jalur relatif menjadi segmen folder bersih (["a","b"]). */
export function pathSegments(dir: string): string[] {
  return dir
    .split("/")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s !== "." && s !== "..");
}

/** Entry dari FileList input webkitdirectory (fallback: nama file saja). */
export function entriesFromFileList(
  files: FileList | File[] | null | undefined
): FolderEntry[] {
  if (!files) return [];
  return Array.from(files).map((file) => {
    const rel =
      (file as File & { webkitRelativePath?: string }).webkitRelativePath ||
      "";
    return { file, relPath: rel || file.name };
  });
}

// ── Walker tarik-lepas folder (FileSystemEntry) ──

type FsEntry = {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  fullPath: string;
  file?: (cb: (f: File) => void, err: (e: unknown) => void) => void;
  createReader?: () => {
    readEntries: (cb: (es: FsEntry[]) => void, err: (e: unknown) => void) => void;
  };
};

/**
 * Ambil referensi entry dari DataTransfer SECARA SINKRON (di dalam handler
 * drop). Setelah handler drop kembali, Chromium membatalkan entry — jadi
 * langkah ini tidak boleh ada `await` di tengahnya.
 */
export function snapEntriesFromDataTransfer(
  dt: DataTransfer
): { entries: FsEntry[]; hasDirectory: boolean } {
  const entries: FsEntry[] = [];
  let hasDirectory = false;
  const items = dt.items ? Array.from(dt.items) : [];
  for (const item of items) {
    if (item.kind !== "file") continue;
    const getter = (
      item as DataTransferItem & {
        webkitGetAsEntry?: () => FsEntry | null;
      }
    ).webkitGetAsEntry;
    if (typeof getter !== "function") continue;
    let entry: FsEntry | null = null;
    try {
      entry = getter.call(item);
    } catch {
      entry = null;
    }
    if (!entry) continue;
    if (entry.isDirectory) hasDirectory = true;
    entries.push(entry);
  }
  return { entries, hasDirectory };
}

/** Baca seluruh isi sebuah directory entry (readEntries maks ±100/call). */
async function readAllDir(dir: FsEntry): Promise<FsEntry[]> {
  const reader = dir.createReader?.();
  if (!reader) return [];
  const out: FsEntry[] = [];
  for (;;) {
    const batch = await new Promise<FsEntry[]>((resolve) => {
      try {
        reader.readEntries(
          (es) => resolve(es ?? []),
          () => resolve([])
        );
      } catch {
        resolve([]);
      }
    });
    if (batch.length === 0) return out;
    out.push(...batch);
    if (out.length > 5000) return out; // guard loop tak berujung
  }
}

async function walkEntry(
  entry: FsEntry,
  prefix: string,
  out: FolderEntry[],
  depth: number
): Promise<void> {
  if (depth > MAX_FOLDER_PATH_DEPTH + 2) return; // guard kedalaman
  const name = entry.name || "";
  if (entry.isFile) {
    const file = await new Promise<File | null>((resolve) => {
      try {
        entry.file?.(
          (f) => resolve(f),
          () => resolve(null)
        );
      } catch {
        resolve(null);
      }
    });
    if (!file) return;
    out.push({ file, relPath: prefix ? `${prefix}/${name}` : name });
    return;
  }
  if (entry.isDirectory) {
    const children = await readAllDir(entry);
    for (const child of children) {
      await walkEntry(child, prefix ? `${prefix}/${name}` : name, out, depth + 1);
    }
  }
}

/**
 * Jalan semua entry hasil snap (file lepas + folder rekursif) → daftar
 * FolderEntry dengan relPath relatif terhadap item yang dilepas.
 */
export async function walkSnappedEntries(
  snapped: FsEntry[]
): Promise<FolderEntry[]> {
  const out: FolderEntry[] = [];
  for (const entry of snapped) {
    await walkEntry(entry, "", out, 0);
  }
  return out;
}

// ── Validasi batas ──

/**
 * Validasi batch folder: berkas > 1 GB dan berkas kosong 0 byte DILEWATI
 * (toast per berkas oleh pemanggil), total berkas sah ≤ 2 GB, jumlah ≤ 500.
 * Bila total melebihi 2 GB → seluruh batch ditolak (fisika: batas total
 * tidak bisa "sebagian").
 */
export function validateFolderUpload(
  entries: FolderEntry[]
): FolderValidation {
  const valid: FolderEntry[] = [];
  const skipped: { name: string; size: number; reason: "LARGE" | "EMPTY" }[] = [];
  const maxFileBytes = MAX_FILE_SIZE_MB * 1024 * 1024;
  for (const e of entries) {
    if (e.file.size > maxFileBytes) {
      skipped.push({ name: e.relPath, size: e.file.size, reason: "LARGE" });
      continue;
    }
    if (e.file.size === 0) {
      // Server menolak berkas kosong (FILE_EMPTY) — lewati sejak dari sini.
      skipped.push({ name: e.relPath, size: 0, reason: "EMPTY" });
      continue;
    }
    valid.push(e);
  }
  if (valid.length === 0) {
    return {
      ok: false,
      code: "EMPTY",
      valid,
      skipped,
      totalBytes: 0,
      rootName: rootNameOf(entries),
    };
  }
  if (valid.length > MAX_FOLDER_UPLOAD_FILES) {
    return {
      ok: false,
      code: "TOO_MANY_FILES",
      valid,
      skipped,
      totalBytes: valid.reduce((a, e) => a + e.file.size, 0),
      rootName: rootNameOf(entries),
    };
  }
  const totalBytes = valid.reduce((a, e) => a + e.file.size, 0);
  if (totalBytes > MAX_FOLDER_UPLOAD_TOTAL_BYTES) {
    return {
      ok: false,
      code: "TOO_LARGE_TOTAL",
      valid,
      skipped,
      totalBytes,
      rootName: rootNameOf(entries),
    };
  }
  return {
    ok: true,
    valid,
    skipped,
    totalBytes,
    rootName: rootNameOf(entries),
  };
}
