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
