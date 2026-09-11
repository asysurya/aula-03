import { MongoClient } from "mongodb";
import type { DatabaseConnection as DbConnRow } from "@prisma/client";

// ─────────────────────────────────────────────────────────────────────────
// Multi-MongoDB connection chain — helper terpusat.
//
// Konsep "failover" untuk database APLIKASI (Prisma + satu DATABASE_URL)
// tidak bisa dipindah panas antar cluster: data fisiknya tinggal di satu
// cluster dan setiap query/join harus satu database. Yang benar dan aman:
// rantai prioritas URI + pemantauan usage live + migrasi terpandu saat
// database aktif mendekati kuota (mis. Atlas free tier 512 MB).
//
// File ini dipakai route API admin saja (server-side; mengimpor driver
// mongodb — JANGAN diimpor dari komponen client).
// ─────────────────────────────────────────────────────────────────────────

export const DEFAULT_QUOTA_BYTES = 512 * 1024 * 1024; // 512 MB (Atlas free)

/** Batas level pemakaian (persen terhadap kuota). */
export const USAGE_WARN_PERCENT = 70;
export const USAGE_FULL_PERCENT = 90;

/** Mask URI untuk tampilan aman (skema + 8 karakter terakhir). */
export function maskUri(uri: string): string {
  if (!uri) return "";
  try {
    const tail = uri.slice(-8);
    const schemeMatch = uri.match(/^([a-z+]+:\/\/)/i);
    const scheme = schemeMatch ? schemeMatch[1] : "";
    return `${scheme}…${tail}`;
  } catch {
    return "••••";
  }
}

// ── Identitas URI (untuk mencocokkan dengan DATABASE_URL aktif) ──

/**
 * Identitas "host/dbname" sebuah MongoDB URI — mengabaikan skema
 * (mongodb vs mongodb+srv), kredensial, dan query params. Dipakai untuk
 * menandai koneksi mana yang SEDANG dipakai aplikasi (badge "LIVE").
 */
export function mongoUriIdentity(uri: string): string {
  if (!uri) return "";
  try {
    const normalized = uri.replace(/^mongodb(\+srv)?:\/\//i, "http://");
    const u = new URL(normalized);
    const host = (u.host || "").toLowerCase();
    const dbName =
      decodeURIComponent(u.pathname || "/")
        .replace(/^\/+/, "")
        .split("/")[0]
        ?.toLowerCase() ?? "";
    return `${host}/${dbName}`;
  } catch {
    return "";
  }
}

/** Apakah koneksi ini adalah database yang sedang dipakai aplikasi? */
export function connectionIsLive(rowUri: string): boolean {
  const env = mongoUriIdentity(process.env.DATABASE_URL ?? "");
  const row = mongoUriIdentity(rowUri);
  return !!env && !!row && env === row;
}

// ── Rantai prioritas ──

/** Urutkan baris koneksi menjadi rantai: priority asc (null terakhir) → createdAt asc. */
export function chainSort(rows: DbConnRow[]): DbConnRow[] {
  return [...rows].sort((a, b) => {
    const pa = a.priority ?? Number.MAX_SAFE_INTEGER;
    const pb = b.priority ?? Number.MAX_SAFE_INTEGER;
    if (pa !== pb) return pa - pb;
    return a.createdAt.getTime() - b.createdAt.getTime();
  });
}

/** Normalisasi priority semua baris sesuai posisi di rantai (1..N). */
export function chainNormalizePriorities(rows: DbConnRow[]): {
  id: string;
  priority: number;
}[] {
  return chainSort(rows).map((r, i) => ({ id: r.id, priority: i + 1 }));
}

// ── Level pemakaian ──

export type UsageLevel = "ok" | "warn" | "full";

export function usageOf(
  totalBytes: number | null,
  quotaBytes: number | null
): { level: UsageLevel | null; percent: number | null } {
  if (!quotaBytes || quotaBytes <= 0 || totalBytes == null) {
    return { level: null, percent: null };
  }
  const percent = Math.round((totalBytes / quotaBytes) * 100);
  const level: UsageLevel =
    percent >= USAGE_FULL_PERCENT ? "full" : percent >= USAGE_WARN_PERCENT ? "warn" : "ok";
  return { level, percent };
}

// ── dbStats via driver mongodb ──

export interface MongoStats {
  latencyMs: number;
  dataSize: number;
  storageSize: number;
  indexSize: number;
  totalSize: number;
  objects: number;
  collections: number;
}

/** Nama database dari URI (path pertama; fallback "admin"). */
export function dbNameFromUri(uri: string): string {
  try {
    const normalized = uri.replace(/^mongodb(\+srv)?:\/\//i, "http://");
    const u = new URL(normalized);
    const name = decodeURIComponent(u.pathname || "/")
      .replace(/^\/+/, "")
      .split("/")[0];
    return name || "admin";
  } catch {
    return "admin";
  }
}

/**
 * Hubungkan ke URI, ukur latensi, ambil dbStats (usage penyimpanan).
 * Timeout pendek agar panel admin tidak menggantung.
 */
export async function fetchMongoStats(uri: string): Promise<MongoStats> {
  const client = new MongoClient(uri, {
    serverSelectionTimeoutMS: 8_000,
    connectTimeoutMS: 8_000,
    socketTimeoutMS: 20_000,
    maxIdleTimeMS: 10_000,
  });
  try {
    const t0 = Date.now();
    await client.connect();
    const latencyMs = Date.now() - t0;
    const stats = (await client
      .db(dbNameFromUri(uri))
      .command({ dbStats: 1, scale: 1 })) as Record<string, unknown>;
    const num = (v: unknown): number => {
      const n = Number(v ?? 0);
      return Number.isFinite(n) ? n : 0;
    };
    return {
      latencyMs,
      dataSize: num(stats.dataSize),
      storageSize: num(stats.storageSize),
      indexSize: num(stats.indexSize),
      totalSize: num(stats.totalSize) || num(stats.storageSize) + num(stats.indexSize),
      objects: num(stats.objects),
      collections: num(stats.collections),
    };
  } finally {
    await client.close().catch(() => {});
  }
}

// ── Serializer (aman untuk JSON — BigInt → Number) ──

export interface SerializedDbConnection {
  id: string;
  name: string;
  type: string;
  uriMasked: string;
  isPrimary: boolean;
  active: boolean;
  lastStatus: string;
  lastCheckedAt: string | null;
  lastError: string | null;
  latencyMs: number | null;
  priority: number | null;
  chainIndex: number;
  isLive: boolean;
  quotaBytes: number | null;
  dataSize: number | null;
  storageSize: number | null;
  indexSize: number | null;
  objects: number | null;
  usageCheckedAt: string | null;
  usageTotal: number | null;
  usagePercent: number | null;
  usageLevel: UsageLevel | null;
  createdAt: string;
  updatedAt: string;
}

export function serializeConnection(
  row: DbConnRow,
  chainIndex: number
): SerializedDbConnection {
  const quotaBytes = row.quotaBytes != null ? Number(row.quotaBytes) : null;
  const dataSize = row.dataSize != null ? Number(row.dataSize) : null;
  const storageSize = row.storageSize != null ? Number(row.storageSize) : null;
  const indexSize = row.indexSize != null ? Number(row.indexSize) : null;
  const totalSize =
    storageSize != null && indexSize != null ? storageSize + indexSize : null;
  const { level, percent } = usageOf(totalSize, quotaBytes);
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    uriMasked: maskUri(row.uri),
    isPrimary: row.isPrimary,
    active: row.active,
    lastStatus: row.lastStatus,
    lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null,
    lastError: row.lastError,
    latencyMs: row.latencyMs,
    priority: row.priority,
    chainIndex,
    isLive: connectionIsLive(row.uri),
    quotaBytes,
    dataSize,
    storageSize,
    indexSize,
    objects: row.objects,
    usageCheckedAt: row.usageCheckedAt?.toISOString() ?? null,
    usageTotal: totalSize,
    usagePercent: percent,
    usageLevel: level,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
