import { Storage, type MutableFile } from "megajs";
import { createHash, randomBytes } from "crypto";
import { db } from "@/lib/db";

// ─────────────────────────────────────────────────────────────────────────
// MEGA storage adapter — server-only.
//
// Strategi anti rate-limit / EBLOCKED:
// 1. Session Storage di-cache di level module (per proses) — dipakai ulang.
// 2. SETELAH login password berhasil, session disimpan ke DB (CloudAccount.
//    sessionData, berisi sid + masterKey hasil Storage.toJSON()). Proses
//    berikutnya — termasuk lambda Vercel yang baru cold-start — memulihkan
//    session via Storage.fromJSON() TANPA login password lagi. Login penuh
//    cukup sekali seumur session.
// 3. Login yang gagal (blocked/rate-limit) memicu cooldown 60 detik —
//    request berikutnya langsung gagal cepat, tidak menambah beban ke akun.
//
// storageKey format untuk file MEGA: `mega:<accountId>:<nodeId>`
// ─────────────────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 30_000;
// 5 minutes for uploads — large files (up to 100MB) take time over slow connections.
const UPLOAD_TIMEOUT_MS = 5 * 60_000;
// Cooldown setelah login gagal — jangan "palu" akun yang sedang diblokir.
const LOGIN_FAILURE_COOLDOWN_MS = 60_000;

export interface MegaAccountLike {
  id: string;
  email: string | null;
  password: string | null;
  /** JSON Storage.toJSON() yang dipersist ke CloudAccount.sessionData */
  sessionData?: string | null;
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
const loginFailedAt = new Map<string, number>();

function cacheKey(account: MegaAccountLike): string {
  const cred = `${account.email ?? ""}:${account.password ?? ""}`;
  const hash = createHash("sha1").update(cred).digest("hex").slice(0, 10);
  return `${account.id}:${hash}`;
}

function isRetryable(err: unknown): boolean {
  // HANYA error level-akun yang tidak boleh di-retry (retry = login
  // berulang = memperparah blokir). Sisanya (ESID/session kadaluarsa,
  // "storage is not ready", timeout, network) BOLEH di-retry 1x dengan
  // session baru.
  const msg = err instanceof Error ? err.message : String(err);
  if (/EBLOCKED|OVERQUOTA|EMFILE|MEGA_COOLDOWN|MEGA_NO_CREDENTIALS/i.test(msg)) {
    return false;
  }
  if (/ERATELIMIT|rate limit/i.test(msg)) return false;
  return true;
}

/**
 * Error level-akun = akunnya sendiri bermasalah (diblokir / kredensial
 * salah) — pantas dicatat sebagai lastStatus "error" supaya akun
 * otomatis dilewati. Error SESI (ESID / not ready / network) TIDAK
 * boleh menandai akun error — cukup relogin.
 */
export function isAccountLevelMegaError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /EBLOCKED|MEGA_NO_CREDENTIALS|MEGA_COOLDOWN|OVERQUOTA|ERATELIMIT|rate limit|ENoENT|wrong/i.test(msg) && !/ESID|not ready|MEGA_TIMEOUT/i.test(msg);
}

/**
 * Pesan error MEGA yang ramah untuk ditampilkan ke user Indonesia.
 */
export function describeMegaError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/MEGA_COOLDOWN/.test(msg)) {
    return "Login MEGA baru saja gagal — tunggu ±1 menit lalu coba lagi (server sedang mencegah percobaan berulang).";
  }
  if (/EBLOCKED|-16/i.test(msg)) {
    return "Akun MEGA ini DIBLOKIR oleh MEGA (EBLOCKED). Login ke mega.nz lewat browser untuk cek verifikasi/captcha, ganti ke akun MEGA baru, atau pakai provider S3 — semuanya lewat Admin Panel → Data & Cloud.";
  }
  if (/ERATELIMIT|-4/i.test(msg)) {
    return "MEGA menerapkan rate limit. Tunggu 5-10 menit. (Kode sekarang sudah login 1x + session persist, jadi ini seharusnya jarang terjadi.)";
  }
  if (/MEGA_TIMEOUT/i.test(msg)) {
    return "Koneksi ke MEGA timeout. Coba lagi sebentar lagi.";
  }
  if (/MEGA_NO_CREDENTIALS/i.test(msg)) {
    return "Email/password MEGA belum diisi lengkap.";
  }
  if (/ESID/i.test(msg)) {
    return "Session MEGA kadaluarsa — coba lagi (login baru otomatis dilakukan).";
  }
  return msg;
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

/**
 * reload() megajs (1.3.10) mendaftarkan listener event 'sc' BARU pada api
 * TANPA melepas listener lama. Event delete ('d') lalu diproses BERKALI-KALI:
 * setelah splice pertama berhasil menghapus node, pemrosesan ulang menjalankan
 * splice(indexOf(file) = -1, 1) yang justru MENGHAPUS ANAK TERAKHIR folder —
 * inilah akar bug "file mount MEGA menghilang sendiri setelah hapus/salin".
 *
 * safeReload melepas semua listener 'sc' lama sebelum reload supaya selalu
 * ada maksimal SATU listener aktif per session.
 */
async function safeReload(storage: Storage): Promise<void> {
  try {
    const api = storage.api as unknown as {
      removeAllListeners?: (ev: string) => unknown;
    };
    api.removeAllListeners?.("sc");
  } catch {
    /* ignore — struktur api berbeda di versi lain */
  }
  await withTimeout(storage.reload(), DEFAULT_TIMEOUT_MS);
}

/**
 * Jalankan operasi TULIS (mkdir/rename/move/copy/delete/upload) lalu selalu
 * evict session cache di akhir. Pembacaan berikutnya (tree/list) membuat
 * session BARU dari sessionData → tree SEGAR persis kondisi server — tidak
 * pernah memakai tree lama yang mungkin setengah-termutasi.
 */
async function withMutatingSession<T>(
  account: MegaAccountLike,
  op: (storage: Storage) => Promise<T>
): Promise<T> {
  const key = cacheKey(account);
  try {
    return await withSession(account, op);
  } finally {
    evictSession(key);
  }
}

/**
 * Simpan session (sid + masterKey) ke CloudAccount.sessionData supaya
 * proses lain / lambda baru tidak perlu login password lagi.
 */
async function persistSession(accountId: string, storage: Storage): Promise<void> {
  if (accountId === "test") return;
  try {
    const json = storage.toJSON();
    await db.cloudAccount.update({
      where: { id: accountId },
      data: { sessionData: JSON.stringify(json) },
    });
  } catch {
    /* best-effort — jangan gagalkan operasi utama */
  }
}

/**
 * Pulihkan session dari CloudAccount.sessionData (sid + masterKey).
 * Return null bila data tidak ada / tidak valid / sid sudah kadaluarsa.
 */
async function restoreSession(
  account: MegaAccountLike
): Promise<Storage | null> {
  if (!account.sessionData) return null;
  try {
    const json = JSON.parse(account.sessionData) as {
      key?: string;
      sid?: string;
      name?: string;
      user?: unknown;
      options?: Record<string, unknown>;
    };
    if (!json.key || !json.sid) return null;
    const restored = Storage.fromJSON({
      key: json.key,
      sid: json.sid,
      name: json.name ?? "",
      user: (json.user ?? "") as unknown as string,
      options: {
        ...json.options,
        email:
          (json.options?.email as string | undefined) ??
          account.email ??
          "",
        // password tidak dipakai saat restore (autologin: false di fromJSON)
        password: "",
        keepalive: true,
      },
    } as Parameters<typeof Storage.fromJSON>[0]);
    // Muat ulang tree file — ini otomatis memvalidasi sid. Kalau sid
    // kadaluarsa, reload akan error → return null → fallback login password.
    await safeReload(restored);
    return restored;
  } catch {
    return null;
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

function loginCooldownActive(key: string): boolean {
  const t = loginFailedAt.get(key);
  if (!t) return false;
  if (Date.now() - t > LOGIN_FAILURE_COOLDOWN_MS) {
    loginFailedAt.delete(key);
    return false;
  }
  return true;
}

/**
 * Ambil (atau buat sekali) session MEGA untuk sebuah akun.
 * Urutan: (1) cache proses, (2) pulihkan dari sessionData (sid), (3) login
 * password — lalu persist sessionData. Login gagal → cooldown 60 detik.
 * `forceLogin` melewati tahap (2) — dipakai setelah sid terbukti mati (ESID)
 * supaya recovery tidak memulihkan sid yang sama.
 */
export async function getMegaSession(
  account: MegaAccountLike,
  opts?: { forceLogin?: boolean }
): Promise<Storage> {
  if (!account.email && !account.sessionData) {
    throw new Error("MEGA_NO_CREDENTIALS");
  }
  const key = cacheKey(account);
  const cached = sessionCache.get(key);
  if (cached) return cached;

  if (loginCooldownActive(key)) {
    throw new Error("MEGA_COOLDOWN");
  }

  let opening = sessionOpening.get(key);
  if (!opening) {
    opening = (async () => {
      // (2) Coba pulihkan session yang tersimpan — tanpa login password.
      if (!opts?.forceLogin) {
        const restored = await restoreSession(account);
        if (restored) {
          return restored;
        }
      }
      // (3) Login penuh dengan password.
      const storage = await loginOnce(account);
      await persistSession(account.id, storage);
      return storage;
    })();
    sessionOpening.set(key, opening);
    opening
      .then((s) => {
        loginFailedAt.delete(key);
        sessionCache.set(key, s);
      })
      .catch((e) => {
        // Login gagal (termasuk EBLOCKED) → mulai cooldown supaya request
        // berikutnya tidak menambah percobaan login.
        loginFailedAt.set(key, Date.now());
        evictSession(key);
        void e; // ditangani caller
      })
      .finally(() => {
        sessionOpening.delete(key);
      });
  }
  return opening;
}

/**
 * Jalankan operasi dengan session ter-cache. Bila session rusak (ESID /
 * "storage is not ready" / network), buang cache + hapus sessionData mati
 * di DB, lalu coba SEKALI lagi dengan login baru.
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
    // Session basi (ESID / status not-ready / timeout) → bersihkan jejak
    // session mati (DB) supaya proses lain / cold-start tidak memulihkan
    // sid yang sudah mati, lalu PAKSA login baru dan coba sekali lagi.
    const msg = e instanceof Error ? e.message : String(e);
    if (/ESID|not ready/i.test(msg)) {
      try {
        await db.cloudAccount.update({
          where: { id: account.id },
          data: { sessionData: null },
        });
      } catch {
        /* best-effort */
      }
    }
    evictSession(key);
    storage = await getMegaSession(account, { forceLogin: true });
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
    const storage = await getMegaSession({
      id: "test",
      email,
      password,
    });
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
      error: describeMegaError(e),
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
 * Upload a buffer to MEGA. parentId null → root; selain itu node folder.
 * Returns storageKey `mega:<accountId>:<nodeId>` and the byte size.
 */
export async function megaUploadTo(
  account: MegaAccountLike,
  parentId: string | null,
  name: string,
  bytes: Buffer,
  _mimetype: string
): Promise<MegaUploadResult> {
  if (!account.email && !account.sessionData) {
    throw new Error("MEGA_NO_CREDENTIALS");
  }
  return withMutatingSession(account, async (storage) => {
    const parent = await resolveFolder(storage, parentId);
    const stream = parent.upload({ name, size: bytes.length });
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
 * Upload ke root akun MEGA (kompatibilitas — dipakai fitur sync).
 */
export async function megaUpload(
  account: MegaAccountLike,
  name: string,
  bytes: Buffer,
  mimetype: string
): Promise<MegaUploadResult> {
  return megaUploadTo(account, null, name, bytes, mimetype);
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
 * Cari node; bila tidak ada (tree basi), reload sekali lalu cari lagi.
 */
async function resolveNode(
  storage: Storage,
  nodeId: string
): Promise<MutableFile | null> {
  let node = findNode(storage, nodeId);
  if (!node) {
    await safeReload(storage);
    node = findNode(storage, nodeId);
  }
  return node;
}

async function resolveFolder(
  storage: Storage,
  nodeId: string | null
): Promise<MutableFile> {
  if (!nodeId) return storage.root;
  const node = await resolveNode(storage, nodeId);
  if (!node || !node.directory) {
    throw new Error("MEGA_FOLDER_NOT_FOUND");
  }
  return node;
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
      const file = await resolveNode(storage, nodeId);
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
 * Delete node (file ATAU folder — rekursif) dari MEGA. PERMANEN
 * (bukan pindah ke trash).
 */
export async function megaDelete(
  account: MegaAccountLike,
  nodeId: string
): Promise<void> {
  try {
    await withSession(account, async (storage) => {
      const file = await resolveNode(storage, nodeId);
      if (!file) return;
      await withTimeout(file.delete(true), DEFAULT_TIMEOUT_MS);
    });
  } catch {
    /* swallow — caller already deletes the DB row */
  }
}

// ───────────────── Operasi full-akses untuk mount MEGA Cloud ─────────────────

/**
 * Buat folder baru di dalam parentId (null = root).
 */
export async function megaMkdir(
  account: MegaAccountLike,
  parentId: string | null,
  name: string
): Promise<{ nodeId: string }> {
  return withSession(account, async (storage) => {
    const parent = await resolveFolder(storage, parentId);
    const folder = await withTimeout(
      parent.mkdir({ name }) as Promise<MutableFile>,
      DEFAULT_TIMEOUT_MS
    );
    if (!folder.nodeId) throw new Error("MEGA_NO_NODE_ID");
    // Tree disegarkan lewat evict session (withMutatingSession) — reload()
    // di sini justru menambah listener 'sc' ganda yang merusak tree.
    return { nodeId: folder.nodeId };
  });
}

/**
 * Rename node (file / folder).
 */
export async function megaRename(
  account: MegaAccountLike,
  nodeId: string,
  name: string
): Promise<void> {
  await withMutatingSession(account, async (storage) => {
    const node = await resolveNode(storage, nodeId);
    if (!node) throw new Error("MEGA_NODE_NOT_FOUND");
    await withTimeout(node.rename(name), DEFAULT_TIMEOUT_MS);
  });
}

/**
 * Pindahkan node ke folder lain.
 */
export async function megaMove(
  account: MegaAccountLike,
  nodeId: string,
  targetParentId: string | null
): Promise<void> {
  await withMutatingSession(account, async (storage) => {
    const node = await resolveNode(storage, nodeId);
    if (!node) throw new Error("MEGA_NODE_NOT_FOUND");
    const target = await resolveFolder(storage, targetParentId);
    if (node.nodeId === target.nodeId) return;
    await withTimeout(node.moveTo(target), DEFAULT_TIMEOUT_MS);
  });
}

/**
 * Hapus node (file / folder rekursif) — permanen. Sama seperti megaDelete
 * tapi melempar error ke caller (untuk feedback UI di mount).
 */
export async function megaDeleteNode(
  account: MegaAccountLike,
  nodeId: string
): Promise<void> {
  await withMutatingSession(account, async (storage) => {
    const node = await resolveNode(storage, nodeId);
    if (!node) throw new Error("MEGA_NODE_NOT_FOUND");
    await withTimeout(node.delete(true), DEFAULT_TIMEOUT_MS);
  });
}

/**
 * Kumpulkan semua storageKey `mega:<accountId>:<nodeId>` untuk node ini +
 * seluruh turunannya (file di dalam folder, rekursif). Dipakai untuk
 * membersihkan baris CloudFile yang yatim saat node dihapus dari mount.
 */
export async function megaCollectDescendantKeys(
  account: MegaAccountLike,
  nodeId: string
): Promise<string[]> {
  try {
    return await withSession(account, async (storage) => {
      const keys: string[] = [];
      const walk = (node: MutableFile) => {
        if (node.nodeId) {
          keys.push(`mega:${account.id}:${node.nodeId}`);
        }
        for (const child of node.children ?? []) {
          walk(child);
        }
      };
      const node = await resolveNode(storage, nodeId);
      if (node) walk(node);
      return keys;
    });
  } catch {
    return [];
  }
}

// ───────────────── Salin node (file & folder, rekursif) ─────────────────

/**
 * Nama unik bila tujuan sudah berisi nama sama: "file (salinan).ext"
 */
function dedupeName(existing: Set<string>, name: string): string {
  if (!existing.has(name)) return name;
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let i = 1; i < 100; i++) {
    const candidate = `${base} (salinan${i > 1 ? " " + i : ""})${ext}`;
    if (!existing.has(candidate)) return candidate;
  }
  return `${base}-${Date.now()}${ext}`;
}

/**
 * Salin SATU file node ke folder tujuan lewat server-side copy MEGA
 * (copyTo — tanpa re-upload). Node hasil diidentifikasi dengan:
 * nama sama + nodeId yang TIDAK ada sebelum copy (deterministik).
 */
async function copyFileNode(
  storage: Storage,
  file: MutableFile,
  target: MutableFile,
  wantName: string
): Promise<MutableFile> {
  const preIds = new Set(
    (target.children ?? []).map((c) => c.nodeId ?? "")
  );
  await withTimeout(
    file.copyTo(target) as Promise<unknown>,
    UPLOAD_TIMEOUT_MS
  );
  await safeReload(storage);
  const freshTarget = target.nodeId ? findNode(storage, target.nodeId) : storage.root;
  const copy = (freshTarget?.children ?? []).find(
    (c) =>
      !c.directory &&
      c.name === file.name &&
      c.nodeId &&
      !preIds.has(c.nodeId)
  );
  if (!copy) throw new Error("MEGA_COPY_NODE_NOT_FOUND");
  if (wantName && wantName !== copy.name) {
    await withTimeout(copy.rename(wantName), DEFAULT_TIMEOUT_MS);
    await safeReload(storage).catch(() => {});
  }
  return copy;
}

/**
 * Salin node (file ATAU folder rekursif) ke folder tujuan.
 * Folder → mkdir + salin turunannya satu per satu (copyTo per file).
 * Guard: maks 500 node & 2 GB total supaya tidak menggantung lambda.
 * (Diuji empiris vs akun MEGA nyata: copyTo + reload + identifikasi id.)
 */
export async function megaCopyNode(
  account: MegaAccountLike,
  nodeId: string,
  targetParentId: string | null,
  opts?: { name?: string }
): Promise<{ nodeId: string; copiedCount: number }> {
  return withMutatingSession(account, async (storage) => {
    const node = await resolveNode(storage, nodeId);
    if (!node) throw new Error("MEGA_NODE_NOT_FOUND");
    if (node.nodeId === storage.root.nodeId) {
      throw new Error("MEGA_CANNOT_COPY_ROOT");
    }
    const target = await resolveFolder(storage, targetParentId);

    // Jangan salin ke dalam dirinya sendiri (folder → subfolder sendiri).
    let p: MutableFile | undefined = target;
    while (p) {
      if (p.nodeId === node.nodeId) {
        throw new Error("MEGA_CANNOT_COPY_INTO_SELF");
      }
      p = p.parent;
    }

    let copiedCount = 0;
    let totalBytes = 0;
    const guard = (size: number) => {
      copiedCount++;
      totalBytes += size;
      if (copiedCount > 500) throw new Error("MEGA_COPY_TOO_MANY_ITEMS");
      if (totalBytes > 2 * 1024 * 1024 * 1024) {
        throw new Error("MEGA_COPY_TOO_LARGE");
      }
    };

    const existingNames = new Set(
      (target.children ?? []).map((c) => c.name ?? "")
    );

    if (!node.directory) {
      guard(node.size ?? 0);
      const wantName = dedupeName(existingNames, opts?.name ?? node.name ?? "file");
      const copied = await copyFileNode(storage, node, target, wantName);
      if (!copied.nodeId) throw new Error("MEGA_NO_NODE_ID");
      return { nodeId: copied.nodeId, copiedCount: 1 };
    }

    // Folder: mkdir + salin isi rekursif.
    const wantName = dedupeName(existingNames, opts?.name ?? node.name ?? "folder");
    const newRoot = await withTimeout(
      target.mkdir({ name: wantName }) as Promise<MutableFile>,
      DEFAULT_TIMEOUT_MS
    );
    if (!newRoot.nodeId) throw new Error("MEGA_NO_NODE_ID");

    const copyChildren = async (src: MutableFile, dst: MutableFile) => {
      for (const child of src.children ?? []) {
        guard(child.directory ? 0 : child.size ?? 0);
        if (child.directory) {
          const sub = await withTimeout(
            dst.mkdir({ name: child.name ?? "folder" }) as Promise<MutableFile>,
            DEFAULT_TIMEOUT_MS
          );
          if (!sub.nodeId) throw new Error("MEGA_NO_NODE_ID");
          await copyChildren(child, sub);
        } else {
          // dst folder baru → tidak ada konflik nama; copyTo langsung
          // tanpa identifikasi/rename (lebih cepat, reload cukup di akhir).
          await withTimeout(
            child.copyTo(dst) as Promise<unknown>,
            UPLOAD_TIMEOUT_MS
          );
        }
      }
    };
    await copyChildren(node, newRoot);
    // Tree disegarkan lewat evict session (withMutatingSession).
    return { nodeId: newRoot.nodeId, copiedCount };
  });
}

/**
 * List isi sebuah folder MEGA (default: root) untuk fitur "mount"
 * di file browser. Termasuk breadcrumb path. Melempar error dengan
 * pesan asli saat gagal (mis. EBLOCKED).
 */
export async function megaList(
  account: MegaAccountLike,
  nodeId?: string | null
): Promise<MegaListResult> {
  return withSession(account, async (storage) => {
    const target = await resolveFolder(storage, nodeId ?? null);

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
}

/**
 * Generate a unique node-id placeholder for a local-side lookup key.
 * (Used by lib/storage.ts when constructing keys for fallback.)
 */
export function randomId(): string {
  return randomBytes(12).toString("hex");
}
