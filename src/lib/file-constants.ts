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
  "text/plain",
  "text/markdown",
  "application/json",
  // images
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
  // archives
  "application/zip",
  "application/x-zip-compressed",
  // audio/video
  "audio/mpeg",
  "audio/mp4",
  "video/mp4",
  "video/webm",
]);

export const MAX_ATTACHMENTS_PER_MESSAGE = 5;

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
