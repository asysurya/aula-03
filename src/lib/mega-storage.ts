import { Storage, type MutableFile } from "megajs";
import { randomBytes } from "crypto";

// ─────────────────────────────────────────────────────────────────────────
// MEGA storage adapter — server-only.
//
// Wraps the callback/event-based `megajs` SDK in promises with hard timeouts.
// Used by `src/lib/storage.ts` when an active MEGA CloudAccount is configured.
// In the dev sandbox there are typically NO MEGA credentials configured, so
// the caller falls back to local filesystem storage (see lib/storage.ts).
//
// storageKey format for MEGA-backed files: `mega:<accountId>:<nodeId>`
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

function openStorage(account: MegaAccountLike): Promise<Storage> {
  if (!account.email || !account.password) {
    return Promise.reject(new Error("MEGA_NO_CREDENTIALS"));
  }
  const storage = new Storage({
    email: account.email,
    password: account.password,
    autologin: true,
    autoload: true,
    keepalive: false,
  });
  // `ready` is a native Promise on the Storage instance.
  return withTimeout(
    storage.ready as unknown as Promise<Storage>,
    DEFAULT_TIMEOUT_MS
  ).then(() => storage);
}

/**
 * Test a MEGA account by logging in and reading account info.
 * Returns ok=true with quota info on success; ok=false with `error` on failure.
 */
export async function testMegaAccount(
  email: string,
  password: string
): Promise<MegaTestResult> {
  let storage: Storage | null = null;
  try {
    storage = await openStorage({ id: "test", email, password });
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
  } finally {
    if (storage) {
      try {
        await storage.close();
      } catch {
        /* ignore close errors */
      }
    }
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
  let storage: Storage | null = null;
  try {
    storage = await openStorage(account);
    // Upload to the account's root. `complete` Promise on UploadStream
    // resolves with the MutableFile that has the nodeId we persist.
    const stream = storage.upload({ name, size: bytes.length });
    // `complete` resolves with the uploaded MutableFile.
    const donePromise = stream.complete as Promise<MutableFile>;
    // Write the buffer into the writable stream (megajs UploadStream
    // extends Writable but its bundled type defs are deno-shaped, so cast).
    await new Promise<void>((resolve, reject) => {
      const w = stream as unknown as NodeJS.WritableStream & {
        on: (e: string, cb: (...args: unknown[]) => void) => void;
      };
      w.on("error", reject);
      // NodeJS Writable.end(chunk, cb) writes the final chunk then signals
      // finish.
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
  } finally {
    if (storage) {
      try {
        await storage.close();
      } catch {
        /* ignore */
      }
    }
  }
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

/**
 * Download a buffer from MEGA. Caller must pass the owning account.
 * Returns null on any failure (caller can treat as "file not found").
 */
export async function megaDownload(
  account: MegaAccountLike,
  nodeId: string
): Promise<Buffer | null> {
  let storage: Storage | null = null;
  try {
    storage = await openStorage(account);
    // Reload storage tree so find() can locate the node.
    await storage.reload();
    const file = storage.find((f) => f.nodeId === nodeId, true);
    if (!file) return null;
    const buf = await withTimeout(
      file.downloadBuffer({}),
      UPLOAD_TIMEOUT_MS
    );
    return buf;
  } catch {
    return null;
  } finally {
    if (storage) {
      try {
        await storage.close();
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * Delete a file from MEGA by node id.
 */
export async function megaDelete(
  account: MegaAccountLike,
  nodeId: string
): Promise<void> {
  let storage: Storage | null = null;
  try {
    storage = await openStorage(account);
    await storage.reload();
    const file = storage.find((f) => f.nodeId === nodeId, true);
    if (!file) return;
    await withTimeout(file.delete(true), DEFAULT_TIMEOUT_MS);
  } catch {
    /* swallow — caller already deletes the DB row */
  } finally {
    if (storage) {
      try {
        await storage.close();
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * Generate a unique node-id placeholder for a local-side lookup key.
 * (Used by lib/storage.ts when constructing keys for fallback.)
 */
export function randomId(): string {
  return randomBytes(12).toString("hex");
}
