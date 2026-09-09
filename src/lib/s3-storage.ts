import { randomBytes } from "crypto";

// ─────────────────────────────────────────────────────────────────────────
// S3-compatible storage adapter — server-only.
//
// "Metode lain" selain MEGA: provider S3-compatible TIDAK pernah memblokir
// login dari IP datacenter (Vercel), jadi cocok sebagai cadangan / pengganti
// ketika akun MEGA kena EBLOCKED. Yang didukung:
//   - Cloudflare R2  (https://<accountid>.r2.cloudflarestorage.com, gratis 10GB)
//   - Backblaze B2   (s3.<region>.backblazeb2.com)
//   - DigitalOcean Spaces, Wasabi, MinIO, AWS S3 standard.
//
// storageKey format: `s3:<accountId>:<objectKey>` (objectKey TANPA "/" agar
// aman dipakai sebagai path segment di /api/storage/[key]).
// ─────────────────────────────────────────────────────────────────────────

const OP_TIMEOUT_MS = 30_000;

export interface S3AccountLike {
  id: string;
  endpoint: string | null;
  region: string | null;
  bucket: string | null;
  accessKeyId: string | null;
  secretAccessKey: string | null;
}

export interface S3TestResult {
  ok: boolean;
  error?: string;
}

export interface S3UploadResult {
  storageKey: string;
  size: number;
  objectKey: string;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("S3_TIMEOUT")), ms);
    promise.then(
      (val) => {
        clearTimeout(timer);
        resolve(val);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

// Lazy import SDK — hanya route yang benar-benar memakai S3 yang menanggung
// bundlenya; route lain tetap ringan.
type S3Module = typeof import("@aws-sdk/client-s3");
let s3mod: S3Module | null = null;
async function sdk(): Promise<S3Module> {
  if (!s3mod) {
    s3mod = await import("@aws-sdk/client-s3");
  }
  return s3mod;
}

const clientCache = new Map<string, InstanceType<S3Module["S3Client"]>>();

function buildClient(account: S3AccountLike): InstanceType<S3Module["S3Client"]> {
  const { S3Client } = s3mod!;
  return new S3Client({
    region: account.region || "auto",
    ...(account.endpoint
      ? { endpoint: account.endpoint, forcePathStyle: true }
      : {}),
    credentials: {
      accessKeyId: account.accessKeyId ?? "",
      secretAccessKey: account.secretAccessKey ?? "",
    },
  });
}

function getS3Client(account: S3AccountLike): InstanceType<S3Module["S3Client"]> {
  const cached = clientCache.get(account.id);
  if (cached) return cached;
  const client = buildClient(account);
  clientCache.set(account.id, client);
  return client;
}

function requireConfig(account: S3AccountLike): void {
  if (!account.bucket) throw new Error("S3_BUCKET_MISSING");
  if (!account.accessKeyId || !account.secretAccessKey) {
    throw new Error("S3_CREDENTIALS_MISSING");
  }
}

/** Pesan error S3 yang ramah untuk user. */
export function describeS3Error(err: unknown): string {
  const e = err as { name?: string; message?: string; Code?: string; $metadata?: { httpStatusCode?: number } };
  const name = e?.name ?? "";
  const msg = e?.message ?? String(err);
  const status = e?.$metadata?.httpStatusCode;
  if (status === 403 || /AccessDenied|SignatureDoesNotMatch|InvalidAccessKeyId/i.test(name + msg)) {
    return "Akses ditolak (403) — Access Key / Secret Key salah, atau key tidak punya izin pada bucket ini.";
  }
  if (status === 404 || /NoSuchBucket/i.test(name + msg)) {
    return "Bucket tidak ditemukan (404) — cek nama bucket & endpoint.";
  }
  if (/S3_TIMEOUT/.test(msg)) {
    return "Koneksi ke S3 timeout — cek alamat endpoint (harus https:// dan benar).";
  }
  if (/S3_BUCKET_MISSING|S3_CREDENTIALS_MISSING/.test(msg)) {
    return "Konfigurasi S3 belum lengkap (bucket / access key / secret key).";
  }
  if (/ENOTFOUND|ECONNREFUSED|getaddrinfo/i.test(msg)) {
    return "Endpoint S3 tidak bisa dihubungi — cek alamat endpoint (mis. https://<id>.r2.cloudflarestorage.com).";
  }
  return msg;
}

/**
 * Parse `s3:<accountId>:<objectKey>`.
 */
export function parseS3Key(
  storageKey: string
): { accountId: string; objectKey: string } | null {
  const parts = storageKey.split(":");
  if (parts.length < 3 || parts[0] !== "s3") return null;
  const accountId = parts[1];
  const objectKey = parts.slice(2).join(":");
  if (!accountId || !objectKey) return null;
  return { accountId, objectKey };
}

/** Sanitasi nama file → objectKey datar yang aman untuk path segment. */
function safeObjectKey(name: string): string {
  const base = (name || "file")
    .normalize("NFKD")
    .replace(/[^\w.\-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(-120);
  return `${randomBytes(10).toString("hex")}-${base || "file"}`;
}

/**
 * Test koneksi + kredensial + bucket (HeadBucket).
 */
export async function testS3Account(
  account: S3AccountLike
): Promise<S3TestResult> {
  try {
    requireConfig(account);
    const { HeadBucketCommand } = await sdk();
    const client = getS3Client(account);
    await withTimeout(
      client.send(new HeadBucketCommand({ Bucket: account.bucket! })),
      OP_TIMEOUT_MS
    );
    return { ok: true };
  } catch (err) {
    return { ok: false, error: describeS3Error(err) };
  }
}

/**
 * Upload bytes → object baru. Return storageKey `s3:<accountId>:<objectKey>`.
 */
export async function s3Upload(
  account: S3AccountLike,
  name: string,
  bytes: Buffer,
  mimetype: string
): Promise<S3UploadResult> {
  requireConfig(account);
  const { PutObjectCommand } = await sdk();
  const client = getS3Client(account);
  const objectKey = safeObjectKey(name);
  await withTimeout(
    client.send(
      new PutObjectCommand({
        Bucket: account.bucket!,
        Key: objectKey,
        Body: bytes,
        ContentType: mimetype || "application/octet-stream",
      })
    ),
    OP_TIMEOUT_MS
  );
  return {
    storageKey: `s3:${account.id}:${objectKey}`,
    size: bytes.length,
    objectKey,
  };
}

/**
 * Download bytes berdasarkan objectKey. Null bila tidak ada.
 */
export async function s3Download(
  account: S3AccountLike,
  objectKey: string
): Promise<Buffer | null> {
  try {
    requireConfig(account);
    const { GetObjectCommand } = await sdk();
    const client = getS3Client(account);
    const res = await withTimeout(
      client.send(
        new GetObjectCommand({ Bucket: account.bucket!, Key: objectKey })
      ),
      OP_TIMEOUT_MS
    );
    if (!res.Body) return null;
    const chunks: Buffer[] = [];
    // S3 v3 Body adalah stream async-iterable di runtime Node.
    for await (const chunk of res.Body as unknown as AsyncIterable<unknown>) {
      chunks.push(Buffer.from(chunk as Uint8Array));
    }
    return Buffer.concat(chunks);
  } catch {
    return null;
  }
}

/**
 * Hapus object. Best-effort.
 */
export async function s3Delete(
  account: S3AccountLike,
  objectKey: string
): Promise<void> {
  try {
    requireConfig(account);
    const { DeleteObjectCommand } = await sdk();
    const client = getS3Client(account);
    await withTimeout(
      client.send(
        new DeleteObjectCommand({ Bucket: account.bucket!, Key: objectKey })
      ),
      OP_TIMEOUT_MS
    );
  } catch {
    /* swallow — caller already deletes the DB row */
  }
}
