import { Storage, type MutableFile } from "megajs";
import { createHash, randomBytes } from "crypto";

// ─────────────────────────────────────────────────────────────────────────
// MEGA storage adapter — server-only.
//
// IMPORTANT (rate-limit fix): setiap operasi TIDAK lagi login baru.
// Session Storage di-cache di level module dan dipakai ulang — MEGA membatasi
// login berulang dari IP yang sama (terutama IP datacenter seperti Vercel),
// dan pola "login → operasi → close" yang lama memicu block berkepanjangan.
//
// storageKey format untuk file MEGA: `mega:<accountId>:<nodeId>`
// ─────────────────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 30_000;
// 5 minutes for uploads — large files (up to 100MB) take time over slow connections.
const UPLOAD_TIMEOUT_MS = 5 * 60_000;

export interface MegaAccountLike {
  id: string;
  email: string | null;
  password: string | null;
}

export interface MegaTestResult {
  ok: boolean;
  error?: string;
  spaceTotal?: number;
  spaceUsed?: number;
}

export interface MegaUploadResult {
  storageKey: string;
  size: number;
  nodeId: string;
}

export interface MegaListEntry {
  nodeId: string;
  name: string;
  isFolder: boolean;
  size: number;
  timestamp: number | null;
}

export interface MegaListResult {
  nodeId: string;
  path: { id: string; name: string }[];
  entries: MegaListEntry[];
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("MEGA_TIMEOUT")),
      ms
    );
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

// ───────────────────────── Session cache ─────────────────────────
// Keyed by `<accountId>:<sha1(email+password)>` supaya perubahan kredensial
// otomatis membuat session baru. Module-level: bertahan selama proses server
// hidup (warm lambda / dev server).

const sessionCache = new Map<string, Storage>();
const sessionOpening = new Map<string, Promise<Storage>>();

function cacheKey(account: MegaAccountLike): string {
  const cred = `${account.email ?? ""}:${account.password ?? ""}`;
  const hash = createHash("sha1").update(cred).digest("hex").slice(0, 10);
  return `${account.id}:${hash}`;
}

function isRetryable(err: unknown): boolean {
  // Jangan pernah retry saat akun kena rate-limit/block — retry berarti
  // login lagi dan memperparah blokir.
  const msg = err instanceof Error ? err.message : String(err);
  if (/blocked|rate|EBLOCKED|OVERQUOTA|EMFILE|MEGA_TIMEOUT/i.test(msg)) {
    return false;
  }
  return true;
}

function evictSession(key: string): void {
  const cached = sessionCache.get(key);
  if (cached) {
    sessionCache.delete(key);
    try {
      void cached.close().catch(() => {});
    } catch {
      /* ignore */
    }
  }
}

async function loginOnce(account: MegaAccountLike): Promise<Storage> {
  if (!account.email || !account.password) {
    throw new Error("MEGA_NO_CREDENTIALS");
  }
  const storage = new Storage({
    email: account.email,
    password: account.password,
    autologin: true,
    autoload: true,
    keepalive: true,
  });
  await withTimeout(
    storage.ready as unknown as Promise<Storage>,
    DEFAULT_TIMEOUT_MS
  );
  return storage;
}

/**
 * Ambil (atau buat sekali) session MEGA untuk sebuah akun. Session di-cache
 * dan dipakai ulang untuk SEMUA operasi berikutnya — hanya login bila belum
 * ada session untuk kombinasi akun+kredensial ini.
 */
export async function getMegaSession(
  account: MegaAccountLike
): Promise<Storage> {
  if (!account.email || !account.password) {
    throw new Error("MEGA_NO_CREDENTIALS");
  }
  const key = cacheKey(account);
  const cached = sessionCache.get(key);
  if (cached) return cached;

  let opening = sessionOpening.get(key);
  if (!opening) {
    opening = loginOnce(account);
    sessionOpening.set(key, opening);
    opening
      .then((s) => {
        sessionCache.set(key, s);
      })
      .catch(() => {
        /* handled by caller */
      })
      .finally(() => {
        sessionOpening.delete(key);
      });
  }
  return opening;
}

/**
 * Jalankan operasi dengan session ter-cache. Bila session rusak (bukan
 * rate-limit), buang cache dan coba sekali lagi dengan login baru.
 */
async function withSession<T>(
  account: MegaAccountLike,
  op: (storage: Storage) => Promise<T>
): Promise<T> {
  const key = cacheKey(account);
  let storage: Storage;
  try {
    storage = await getMegaSession(account);
  } catch (e) {
    // Login failure — biarkan error naik (mis. EBLOCKED/rate limit).
    throw e;
  }
  try {
    return await op(storage);
  } catch (e) {
    if (!isRetryable(e)) throw e;
    // Session mungkin basi — login ulang sekali.
    evictSession(key);
    storage = await getMegaSession(account);
    return await op(storage);
  }
}

// ───────────────────────── Public API ─────────────────────────

/**
 * Test a MEGA account by logging in and reading account info.
 * Menggunakan cache session — menekan tombol "Tes Akun" berkali-kali
 * tidak memicu login berulang (anti rate-limit).
 */
export async function testMegaAccount(
  email: string,
  password: string
): Promise<MegaTestResult> {
  try {
    const storage = await getMegaSession({ id: "test", email, password });
    const info = await withTimeout(
      storage.getAccountInfo(),
      DEFAULT_TIMEOUT_MS
    );
    return {
      ok: true,
      spaceTotal: info.spaceTotal,
      spaceUsed: info.spaceUsed,
    };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "MEGA_ERROR",
    };
  }
}

/**
 * Info akun (kuota) dari session ter-cache — murah, tanpa login baru.
 */
export async function megaAccountInfo(
  account: MegaAccountLike
): Promise<{ spaceTotal: number; spaceUsed: number } | null> {
  try {
    return await withSession(account, (s) =>
      withTimeout(s.getAccountInfo(), DEFAULT_TIMEOUT_MS)
    );
  } catch {
    return null;
  }
}

/**
 * Upload a buffer to MEGA under the account's root folder.
 * Returns storageKey `mega:<accountId>:<nodeId>` and the byte size.
 */
export async function megaUpload(
  account: MegaAccountLike,
  name: string,
  bytes: Buffer,
  _mimetype: string
): Promise<MegaUploadResult> {
  if (!account.email || !account.password) {
    throw new Error("MEGA_NO_CREDENTIALS");
  }
  return withSession(account, async (storage) => {
    // Upload to the account's root. `complete` Promise on UploadStream
    // resolves with the MutableFile that has the nodeId we persist.
    const stream = storage.upload({ name, size: bytes.length });
    const donePromise = stream.complete as Promise<MutableFile>;
    await new Promise<void>((resolve, reject) => {
      const w = stream as unknown as NodeJS.WritableStream & {
        on: (e: string, cb: (...args: unknown[]) => void) => void;
      };
      w.on("error", reject);
      (w as unknown as { end: (chunk: Buffer, cb: () => void) => void }).end(
        bytes,
        () => resolve()
      );
    });
    const file = await withTimeout(donePromise, UPLOAD_TIMEOUT_MS);
    if (!file.nodeId) {
      throw new Error("MEGA_NO_NODE_ID");
    }
    return {
      storageKey: `mega:${account.id}:${file.nodeId}`,
      size: bytes.length,
      nodeId: file.nodeId,
    };
  });
}

/**
 * Parse a `mega:<accountId>:<nodeId>` storage key.
 */
export function parseMegaKey(
  storageKey: string
): { accountId: string; nodeId: string } | null {
  const parts = storageKey.split(":");
  if (parts.length !== 3 || parts[0] !== "mega") return null;
  const [, accountId, nodeId] = parts;
  if (!accountId || !nodeId) return null;
  return { accountId, nodeId };
}

function findNode(storage: Storage, nodeId: string): MutableFile | null {
  return (
    storage.find((f) => f.nodeId === nodeId, true) ??
    (storage.root.nodeId === nodeId ? storage.root : null) ??
    (storage.trash.nodeId === nodeId ? storage.trash : null)
  );
}

/**
 * Download a buffer from MEGA. Caller must pass the owning account.
 * Returns null on any failure (caller can treat as "file not found").
 */
export async function megaDownload(
  account: MegaAccountLike,
  nodeId: string
): Promise<Buffer | null> {
  try {
    return await withSession(account, async (storage) => {
      let file = findNode(storage, nodeId);
      if (!file) {
        // Node mungkin dibuat setelah session dibuka — reload tree sekali.
        await withTimeout(storage.reload(), DEFAULT_TIMEOUT_MS);
        file = findNode(storage, nodeId);
      }
      if (!file || file.directory) return null;
      return await withTimeout(
        file.downloadBuffer({}),
        UPLOAD_TIMEOUT_MS
      );
    });
  } catch {
    return null;
  }
}

/**
 * Delete a file from MEGA by node id — PERMANEN (bukan pindah ke trash).
 */
export async function megaDelete(
  account: MegaAccountLike,
  nodeId: string
): Promise<void> {
  try {
    await withSession(account, async (storage) => {
      let file = findNode(storage, nodeId);
      if (!file) {
        await withTimeout(storage.reload(), DEFAULT_TIMEOUT_MS);
        file = findNode(storage, nodeId);
      }
      if (!file) return;
      await withTimeout(file.delete(true), DEFAULT_TIMEOUT_MS);
    });
  } catch {
    /* swallow — caller already deletes the DB row */
  }
}

/**
 * List isi sebuah folder MEGA (default: root) untuk fitur "mount"
 * di file browser. Termasuk breadcrumb path.
 */
export async function megaList(
  account: MegaAccountLike,
  nodeId?: string | null
): Promise<MegaListResult | null> {
  try {
    return await withSession(account, async (storage) => {
      let folder: MutableFile | null = null;
      if (nodeId) {
        folder = findNode(storage, nodeId);
        if (!folder) {
          await withTimeout(storage.reload(), DEFAULT_TIMEOUT_MS);
          folder = findNode(storage, nodeId);
        }
        if (!folder || !folder.directory) return null;
      }
      const target = folder ?? storage.root;

      // Breadcrumb: naik dari folder ke root.
      const path: { id: string; name: string }[] = [];
      let cur: MutableFile | undefined = target;
      while (cur) {
        path.unshift({
          id: cur.nodeId ?? "root",
          name: cur === storage.root ? "MEGA" : cur.name ?? "",
        });
        if (cur === storage.root) break;
        cur = cur.parent;
      }

      const children = target.children ?? [];
      const entries: MegaListEntry[] = children
        .map((c) => ({
          nodeId: c.nodeId ?? "",
          name: c.name ?? "(tanpa nama)",
          isFolder: !!c.directory,
          size: c.directory ? 0 : c.size ?? 0,
          // megajs timestamps are epoch SECONDS
          timestamp: c.timestamp ? c.timestamp * 1000 : null,
        }))
        .filter((e) => e.nodeId)
        .sort((a, b) => {
          if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1;
          return a.name.localeCompare(b.name);
        });

      return {
        nodeId: target.nodeId ?? "root",
        path: path.length ? path : [{ id: "root", name: "MEGA" }],
        entries,
      };
    });
  } catch {
    return null;
  }
}

/**
 * Generate a unique node-id placeholder for a local-side lookup key.
 * (Used by lib/storage.ts when constructing keys for fallback.)
 */
export function randomId(): string {
  return randomBytes(12).toString("hex");
}
