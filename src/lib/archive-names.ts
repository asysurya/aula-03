// ── Deteksi nama arsip (murni, tanpa dependensi — dipakai UI + server) ──
// Dipisah dari archive.ts (yang mengimpor fflate) supaya komponen client
// tidak ikut mem-bundle pustaka dekompresi.

/** Ekstensi arsip yang BISA dibuka/diekstrak langsung di aplikasi. */
export const SUPPORTED_ARCHIVE_EXTS = [
  "zip",
  "epub", // zip dengan isi xhtml
  "tar",
  "tgz",
  "gz", // termasuk tar.gz
] as const;

/** Ekstensi arsip yang DIKENAL tapi tidak didukung (pesan ramah, bukan
 *  "berkas biner" generik). */
export const UNSUPPORTED_ARCHIVE_EXTS = [
  "rar",
  "7z",
  "bz2",
  "xz",
  "zst",
  "cab",
  "iso",
  "arj",
  "lzh",
] as const;

export function extOf(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const i = base.lastIndexOf(".");
  return i < 0 ? "" : base.slice(i + 1).toLowerCase();
}

/** Nama berkas yang mengarah ke arsip (didukung MAUPUN tidak). */
export function isArchiveName(name: string): boolean {
  const e = extOf(name);
  return (
    (SUPPORTED_ARCHIVE_EXTS as readonly string[]).includes(e) ||
    (UNSUPPORTED_ARCHIVE_EXTS as readonly string[]).includes(e)
  );
}

/** Nama berkas yang bisa dibuka/diekstrak aplikasi. */
export function isSupportedArchiveName(name: string): boolean {
  const e = extOf(name);
  return (SUPPORTED_ARCHIVE_EXTS as readonly string[]).includes(e);
}

/** Nama arsip tanpa ekstensi terakhir (untuk nama folder hasil ekstraksi). */
export function stripArchiveExt(name: string): string {
  const e = extOf(name);
  if (!e) return name;
  // "paket.tar.gz" → "paket" (buang .tar.gz sekaligus bila polanya ketemu)
  if (e === "gz") {
    const withoutGz = name.slice(0, name.length - 3); // buang ".gz"
    if (extOf(withoutGz) === "tar") return withoutGz.slice(0, withoutGz.length - 4);
  }
  const i = name.lastIndexOf(".", name.length - e.length - 1);
  return i > 0 ? name.slice(0, i) : name.slice(0, name.length - e.length - 1);
}

/** Label format arsip untuk ditampilkan ke user. */
export function archiveFormatLabel(name: string): string {
  const e = extOf(name);
  if (e === "zip") return "ZIP";
  if (e === "epub") return "EPUB";
  if (e === "tar") return "TAR";
  if (e === "tgz") return "TAR.GZ";
  if (e === "gz") return "GZ";
  return e ? e.toUpperCase() : "?";
}
