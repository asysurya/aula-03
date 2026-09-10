// Client-safe file constants. Mirror of server-side limits in src/lib/storage.ts.
// Kept in a separate file so client components can import without pulling in
// the Prisma/megajs server-only modules.

export const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100 MB
export const MAX_FILE_SIZE_MB = 100;

// Allowed mimetypes for chat attachments (same as cloud uploads).
export const ALLOWED_MIMES: ReadonlySet<string> = new Set<string>([
  // docs
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/rtf",
  "application/vnd.oasis.opendocument.text",
  "application/vnd.oasis.opendocument.spreadsheet",
  "application/vnd.oasis.opendocument.presentation",
  "application/epub+zip",
  "text/plain",
  "text/markdown",
  "application/json",
  "application/xml",
  "text/csv",
  "text/yaml",
  "text/x-shellscript",
  "text/javascript",
  "text/css",
  "text/html",
  "text/calendar",
  "text/vcard",
  "message/rfc822",
  // images
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
  "image/bmp",
  "image/x-icon",
  "image/tiff",
  "image/heic",
  "image/avif",
  // archives
  "application/zip",
  "application/x-zip-compressed",
  "application/vnd.rar",
  "application/x-7z-compressed",
  "application/x-tar",
  "application/gzip",
  "application/x-bzip2",
  "application/x-xz",
  // audio/video
  "audio/mpeg",
  "audio/mp4",
  "audio/wav",
  "audio/ogg",
  "audio/flac",
  "audio/aac",
  "audio/webm",
  "audio/webm;codecs=opus",
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "video/x-matroska",
  "video/x-msvideo",
  // fallback umum dari OS untuk tipe tak dikenal — tetap lolos,
  // deteksi tipe asli dilakukan server saat serving (magic bytes).
  "application/octet-stream",
]);

export const MAX_ATTACHMENTS_PER_MESSAGE = 5;

// Peta ekstensi → mimetype untuk file yang mimetype OS-nya kosong/aneh
// (sering terjadi di Android & file lama). Dipakai client & server:
// kalau mimetype file tidak lolos ALLOWED_MIMES tapi ekstensinya dikenal,
// gunakan mimetype dari ekstensi.
export const EXT_MIME: Record<string, string> = {
  // documents
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  rtf: "application/rtf",
  odt: "application/vnd.oasis.opendocument.text",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  odp: "application/vnd.oasis.opendocument.presentation",
  epub: "application/epub+zip",
  txt: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
  json: "application/json",
  xml: "application/xml",
  csv: "text/csv",
  yaml: "text/yaml",
  yml: "text/yaml",
  sh: "text/x-shellscript",
  js: "text/javascript",
  mjs: "text/javascript",
  css: "text/css",
  html: "text/html",
  htm: "text/html",
  ics: "text/calendar",
  vcf: "text/vcard",
  eml: "message/rfc822",
  // images
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  ico: "image/x-icon",
  tif: "image/tiff",
  tiff: "image/tiff",
  heic: "image/heic",
  heif: "image/heic",
  avif: "image/avif",
  // archives
  zip: "application/zip",
  rar: "application/vnd.rar",
  "7z": "application/x-7z-compressed",
  tar: "application/x-tar",
  gz: "application/gzip",
  bz2: "application/x-bzip2",
  xz: "application/x-xz",
  // audio
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  wav: "audio/wav",
  webm: "audio/webm",
  ogg: "audio/ogg",
  flac: "audio/flac",
  aac: "audio/aac",
  // video
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mkv: "video/x-matroska",
  avi: "video/x-msvideo",
};

/**
 * Mimetype final untuk sebuah file: pakai mimetype OS kalau valid,
 * kalau tidak → infer dari ekstensi. Mengembalikan "application/octet-stream"
 * bila tidak bisa ditentukan (tetap lolos — tipe asli dideteksi server
 * saat serving via magic bytes).
 */
export function resolveMime(
  filename: string,
  osMime: string | null | undefined
): string {
  const m = (osMime || "").trim().toLowerCase();
  if (m && ALLOWED_MIMES.has(m)) return m;
  const ext = filename.includes(".")
    ? filename.split(".").pop()!.toLowerCase()
    : "";
  const fromExt = ext ? EXT_MIME[ext] : undefined;
  if (fromExt && ALLOWED_MIMES.has(fromExt)) return fromExt;
  return m || fromExt || "application/octet-stream";
}

export function isImageMime(mime: string): boolean {
  return mime.startsWith("image/");
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const value = n / Math.pow(1024, i);
  const digits = i === 0 ? 0 : value < 10 ? 1 : 0;
  return `${value.toFixed(digits)} ${units[i]}`;
}

// Build the public URL that serves a stored file via the auth-gated
// /api/storage/[key] endpoint. Files are served as a stream — the route
// enforces canViewFile permission per request.
export function filePublicUrl(storageKey: string): string {
  return `/api/storage/${storageKey}`;
}
