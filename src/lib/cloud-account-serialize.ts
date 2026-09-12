// Serializer bersama untuk CloudAccount (dipakai route admin cloud-accounts).
// Next.js route.ts hanya boleh mengekspor handler HTTP — helper ditaruh di sini.

export interface SerializedCloudAccount {
  id: string;
  name: string;
  provider: string;
  email: string | null;
  hasPassword: boolean;
  hasKey: boolean;
  hasSession: boolean;
  active: boolean;
  lastStatus: string;
  lastCheckedAt: Date | null;
  lastError: string | null;
  spaceTotal: number | null;
  spaceUsed: number | null;
  fileCount: number;
  createdAt: Date;
  updatedAt: Date;
  // Hak akses mount
  mountVisibleTo: string;
  mountMode: string;
  // Izin khusus per-orang (id user; dipakai editor Admin Panel)
  mountUserIds: string[];
  mountUserWriteIds: string[];
  // S3-compatible
  endpoint: string | null;
  region: string | null;
  bucket: string | null;
  hasSecret: boolean;
}

export function serializeCloudAccount(r: {
  id: string;
  name: string;
  provider: string;
  email: string | null;
  password: string | null;
  key: string | null;
  sessionData: string | null;
  active: boolean;
  lastStatus: string;
  lastCheckedAt: Date | null;
  lastError: string | null;
  spaceTotal: number | null;
  spaceUsed: number | null;
  fileCount: number;
  createdAt: Date;
  updatedAt: Date;
  mountVisibleTo?: string | null;
  mountMode?: string | null;
  mountUserIds?: string[] | null;
  mountUserWriteIds?: string[] | null;
  endpoint: string | null;
  region: string | null;
  bucket: string | null;
  accessKeyId: string | null;
  secretAccessKey: string | null;
}): SerializedCloudAccount {
  return {
    id: r.id,
    name: r.name,
    provider: r.provider,
    email: r.email,
    hasPassword: !!r.password,
    hasKey: !!r.key,
    hasSession: !!r.sessionData,
    active: r.active,
    lastStatus: r.lastStatus,
    lastCheckedAt: r.lastCheckedAt,
    lastError: r.lastError,
    spaceTotal: r.spaceTotal,
    spaceUsed: r.spaceUsed,
    fileCount: r.fileCount,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    mountVisibleTo: r.mountVisibleTo === "ADMIN" || r.mountVisibleTo === "ALL" ? r.mountVisibleTo : "GURU",
    mountMode: r.mountMode === "READ" ? "READ" : "WRITE",
    mountUserIds: Array.isArray(r.mountUserIds) ? r.mountUserIds : [],
    mountUserWriteIds: Array.isArray(r.mountUserWriteIds) ? r.mountUserWriteIds : [],
    endpoint: r.endpoint,
    region: r.region,
    bucket: r.bucket,
    hasSecret: !!r.secretAccessKey,
  };
}
