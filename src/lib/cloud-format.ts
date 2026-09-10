// Cloud module client-side helpers: size formatting, mimetype icon mapping.

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const value = n / Math.pow(1024, i);
  const digits = i === 0 ? 0 : value < 10 ? 1 : 0;
  return `${value.toFixed(digits)} ${units[i]}`;
}

// Map mimetype → lucide icon name. We return a string key; the component
// renders the matching Lucide component to keep this file pure (no JSX).
export type FileIconName =
  | "FileText"
  | "FileImage"
  | "FileSpreadsheet"
  | "MonitorPlay"
  | "FileArchive"
  | "FileVideo"
  | "FileAudio"
  | "FileCode"
  | "File";

export function mimeToIcon(mime: string): FileIconName {
  if (mime.startsWith("image/")) return "FileImage";
  if (mime.startsWith("video/")) return "FileVideo";
  if (mime.startsWith("audio/")) return "FileAudio";
  if (
    mime === "application/zip" ||
    mime === "application/x-zip-compressed" ||
    mime === "application/x-rar-compressed" ||
    mime === "application/x-7z-compressed" ||
    mime === "application/x-tar" ||
    mime === "application/gzip"
  )
    return "FileArchive";
  if (
    mime === "application/vnd.ms-excel" ||
    mime === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    mime === "text/csv"
  )
    return "FileSpreadsheet";
  if (
    mime === "application/vnd.ms-powerpoint" ||
    mime === "application/vnd.openxmlformats-officedocument.presentationml.presentation"
  )
    return "MonitorPlay";
  if (
    mime === "application/json" ||
    mime === "text/markdown" ||
    mime.startsWith("text/")
  )
    return "FileCode";
  if (
    mime === "application/pdf" ||
    mime === "application/msword" ||
    mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  )
    return "FileText";
  return "File";
}

// Shared response types for the cloud API.

export type Visibility = "ALL" | "TEACHERS" | "PRIVATE";

export interface CloudFolderItem {
  id: string;
  name: string;
  type: "FOLDER" | "ASSIGNMENT";
  classroomId: string | null;
  createdAt: string;
  createdBy: string;
  visibility: Visibility;
}

export interface CloudFileItem {
  id: string;
  name: string;
  size: number;
  mimetype: string;
  storageKey: string;
  cloudAccountId: string | null;
  createdAt: string;
  uploadedBy: string;
  uploader?: { id: string; name: string; username: string };
  visibility: Visibility;
  // true untuk file MEGA mentah dari mount MEGA Cloud (tanpa baris
  // CloudFile di DB) — URL preview perlu parameter ?name=.
  raw?: boolean;
}

// Granted-user entry returned by the permissions endpoints.
export interface GrantedUser {
  id: string;
  name: string;
  username: string;
  avatarColor: string;
}

export interface FolderPermissionInfo {
  id: string;
  kind: "folder";
  visibility: Visibility;
  createdBy: string;
  canManage: boolean;
  grantedUsers: GrantedUser[];
}

export interface FilePermissionInfo {
  id: string;
  kind: "file";
  visibility: Visibility;
  uploadedBy: string;
  canManage: boolean;
  grantedUsers: GrantedUser[];
}

// Classroom member for the multi-select picker.
export interface ClassroomMemberOption {
  id: string;
  name: string;
  username: string;
  avatarColor: string;
  role: "TEACHER" | "STUDENT";
}

// Tree node for the folder picker (move/copy target).
export interface FolderTreeNode {
  id: string;
  name: string;
  type: "FOLDER" | "ASSIGNMENT";
  children: FolderTreeNode[];
}

export interface CloudDocItem {
  id: string;
  title: string;
  updatedAt: string;
  createdBy: string;
  creator?: { id: string; name: string; username: string };
}

export interface AssignmentInfo {
  id: string;
  folderId: string;
  title: string;
  description: string | null;
  deadline: string;
  maxScore: number | null;
  createdAt: string;
  createdBy: string;
}

export interface FoldersListResponse {
  folder: { id: string; classroomId: string } | null;
  classroomId: string;
  folders: CloudFolderItem[];
  files: CloudFileItem[];
  docs: CloudDocItem[];
  assignment: AssignmentInfo | null;
  ancestors: { id: string; name: string; classroomId: string | null }[];
}

export interface SubmissionFile {
  id: string;
  name: string;
  size: number;
  mimetype: string;
  storageKey: string;
}

export interface SubmissionInfo {
  id: string;
  assignmentId: string;
  userId: string;
  fileId: string | null;
  note: string | null;
  submittedAt: string;
  file: SubmissionFile | null;
}

export interface AssignmentRosterItem {
  user: { id: string; name: string; username: string };
  role: "TEACHER" | "STUDENT";
  submitted: boolean;
  submittedAt: string | null;
  note: string | null;
  file: SubmissionFile | null;
}

export interface AssignmentDetailResponse {
  assignment: AssignmentInfo;
  classroomId: string;
  referenceFiles: CloudFileItem[];
  myRole: "TEACHER" | "STUDENT";
  mySubmission: SubmissionInfo | null;
  roster: AssignmentRosterItem[] | null;
  summary: {
    submittedCount: number;
    studentCount: number;
    total: number;
  } | null;
}

// Infer mimetype dari ekstensi nama file — dipakai saat menampilkan file
// MEGA mentah (mount MEGA Cloud) yang tidak punya baris CloudFile di DB.
const EXT_MIME: Record<string, string> = {
  // ── Gambar ──
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  jpe: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  ico: "image/x-icon",
  tif: "image/tiff",
  tiff: "image/tiff",
  heic: "image/heic",
  avif: "image/avif",
  // ── Dokumen & PDF ──
  pdf: "application/pdf",
  txt: "text/plain",
  log: "text/plain",
  ini: "text/plain",
  cfg: "text/plain",
  conf: "text/plain",
  env: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  json: "application/json",
  jsonl: "application/json",
  ndjson: "application/json",
  geojson: "application/geo+json",
  xml: "application/xml",
  yaml: "text/yaml",
  yml: "text/yaml",
  toml: "text/plain",
  rtf: "application/rtf",
  epub: "application/epub+zip",
  // ── Kode (pratinjau teks) ──
  html: "text/html",
  htm: "text/html",
  css: "text/css",
  js: "text/javascript",
  mjs: "text/javascript",
  cjs: "text/javascript",
  ts: "text/plain",
  tsx: "text/plain",
  jsx: "text/plain",
  py: "text/plain",
  rb: "text/plain",
  php: "text/plain",
  java: "text/plain",
  c: "text/plain",
  h: "text/plain",
  cpp: "text/plain",
  cs: "text/plain",
  go: "text/plain",
  rs: "text/plain",
  sh: "text/x-shellscript",
  bat: "text/plain",
  sql: "text/plain",
  // ── Audio ──
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  m4a: "audio/mp4",
  flac: "audio/flac",
  aac: "audio/aac",
  opus: "audio/ogg",
  // ── Video ──
  mp4: "video/mp4",
  m4v: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mkv: "video/x-matroska",
  avi: "video/x-msvideo",
  wmv: "video/x-ms-wmv",
  flv: "video/x-flv",
  // ── Office ──
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  docm: "application/vnd.ms-word.document.macroEnabled.12",
  odt: "application/vnd.oasis.opendocument.text",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xlsm: "application/vnd.ms-excel.sheet.macroEnabled.12",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  pptm: "application/vnd.ms-powerpoint.presentation.macroEnabled.12",
  odp: "application/vnd.oasis.opendocument.presentation",
  // ── Arsip ──
  zip: "application/zip",
  rar: "application/vnd.rar",
  "7z": "application/x-7z-compressed",
  tar: "application/x-tar",
  gz: "application/gzip",
  bz2: "application/x-bzip2",
  xz: "application/x-xz",
  // ── Lainnya ──
  eml: "message/rfc822",
  ics: "text/calendar",
  vcf: "text/vcard",
};

export function mimetypeFromName(name: string): string {
  const ext = (name.split(".").pop() ?? "").toLowerCase();
  return EXT_MIME[ext] ?? "application/octet-stream";
}
