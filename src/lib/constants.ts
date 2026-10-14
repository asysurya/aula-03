export const APP_NAME = "Aula";
export const APP_TAGLINE = "Ruang diskusi kelas modern";
export const APP_DESCRIPTION =
  "Forum chat, kerja kelompok, dan cloud tugas untuk satu kelas — dengan DM, grup privat, dan pengumpulan tugas.";

// Polling intervals (ms)
export const MESSAGE_POLL_INTERVAL = 2500;
export const PRESENCE_POLL_INTERVAL = 15000;
export const PRESENCE_TIMEOUT = 45000; // online if pinged within last 45s

// File upload
export const MAX_FILE_SIZE_MB = 1024; // 1 GB (Task 34 — naik dari 100 MB)
export const MAX_FILE_SIZE_LABEL = "1 GB";

// Folder upload (Task 38) — unggah satu folder utuh (tombol "Unggah Folder"
// + tarik-lepas folder) ke mount MEGA. Batas:
//   · per BERKAS tetap 1 GB (sama dengan upload file biasa);
//   · TOTAL seluruh berkas dalam satu folder maks 2 GB;
//   · maks 500 berkas per unggahan (guard, samakan batas "salin folder");
//   · kedalaman sub-folder relatif maks 30 (guard abuse path panjang).
export const MAX_FOLDER_UPLOAD_TOTAL_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB
export const MAX_FOLDER_UPLOAD_TOTAL_LABEL = "2 GB";
export const MAX_FOLDER_UPLOAD_FILES = 500;
export const MAX_FOLDER_PATH_DEPTH = 30;

// Avatar fallback color palette (Tailwind classes)
export const AVATAR_COLORS = [
  "bg-emerald-500",
  "bg-amber-500",
  "bg-rose-500",
  "bg-violet-500",
  "bg-cyan-500",
  "bg-orange-500",
  "bg-pink-500",
  "bg-teal-500",
  "bg-fuchsia-500",
  "bg-lime-600",
] as const;

export function colorFromString(input: string): (typeof AVATAR_COLORS)[number] {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = (hash << 5) - hash + input.charCodeAt(i);
    hash |= 0;
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export type UserRole = "ADMIN" | "GURU" | "STUDENT";

export function roleLabel(role: string): string {
  if (role === "ADMIN") return "Admin";
  if (role === "GURU") return "Guru";
  return "Siswa";
}

// Max group creation / join limits (must match server-side constants).
export const MAX_GROUPS_CREATED = 2;
export const MAX_GROUPS_JOINED = 20;
