// ─────────────────────────────────────────────────────────────────────────
// FAKE MEGA untuk E2E lokal — env-gated, TIDAK PERNAH aktif di produksi.
//
// Aktif hanya bila env MEGA_E2E_FAKE_DIR diset (skrip start-next.sh E2E)
// DAN akun yang dipakai bernama email MEGA_FAKE_EMAIL. Semua operasi MEGA
// (list/stat/download/mkdir/upload) diarahkan ke folder lokal — sehingga
// alur mount MEGA bisa diuji tuntas tanpa akun MEGA asli.
//
// Skema node id fake: "root" atau "fx" + base64url(path relatif).
// Node ID MEGA asli tidak pernah mengandung "/" — path relatif di-encode
// supaya URL /api/storage/mega:<acc>:<nodeId> tetap satu segmen.
// ─────────────────────────────────────────────────────────────────────────

import { promises as fs } from "fs";
import path from "path";
import type {
  MegaAccountLike,
  MegaListResult,
  MegaListEntry,
  MegaStatResult,
  MegaUploadResult,
} from "@/lib/mega-storage";

export const MEGA_FAKE_EMAIL = "mega-e2e@aula.test";

export function megaFakeEnabled(
  account: Pick<MegaAccountLike, "email">
): boolean {
  return (
    !!process.env.MEGA_E2E_FAKE_DIR &&
    account.email === MEGA_FAKE_EMAIL &&
    typeof process.env.MEGA_E2E_FAKE_DIR === "string" &&
    process.env.MEGA_E2E_FAKE_DIR.length > 0
  );
}

function fakeRoot(): string {
  const root = process.env.MEGA_E2E_FAKE_DIR as string;
  return root.endsWith(path.sep) ? root.slice(0, -1) : root;
}

/** Encode path relatif → node id fake (base64url, tanpa "/"/:" "). */
function encNodeId(rel: string): string {
  return rel ? `fx${Buffer.from(rel, "utf8").toString("base64url")}` : "root";
}

/** Decode node id fake → path relatif ("" = root); null bila bukan id fake. */
function decNodeId(
  nodeId: string | null | undefined
): string | null {
  if (nodeId == null || nodeId === "" || nodeId === "root") return "";
  if (!nodeId.startsWith("fx") || nodeId.length < 3) return null;
  try {
    return Buffer.from(nodeId.slice(2), "base64url").toString("utf8");
  } catch {
    return null;
  }
}

/** Path absolut dari node id (relatif) + guard traversal; null = invalid. */
function fakePath(nodeId: string | null | undefined): string | null {
  const rel = decNodeId(nodeId);
  if (rel === null) return null;
  const abs = rel ? path.resolve(fakeRoot(), rel) : path.resolve(fakeRoot());
  if (abs !== fakeRoot() && !abs.startsWith(fakeRoot() + path.sep)) {
    return null; // traversal — anggap tidak ada
  }
  return abs;
}

async function existsDir(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/** Daftar isi folder fake — mirror keluaran megaList. */
export async function fakeMegaList(
  nodeId: string | null | undefined
): Promise<MegaListResult> {
  const abs = fakePath(nodeId);
  if (!abs || !(await existsDir(abs))) {
    throw new Error("MEGA_NODE_NOT_FOUND");
  }
  const rel = path.relative(fakeRoot(), abs);
  const dirents = await fs.readdir(abs, { withFileTypes: true });
  const entries: MegaListEntry[] = [];
  for (const d of dirents) {
    const childRel = rel ? `${rel}/${d.name}` : d.name;
    const st = await fs.stat(path.join(abs, d.name));
    entries.push({
      nodeId: encNodeId(childRel),
      name: d.name,
      isFolder: d.isDirectory(),
      size: d.isDirectory() ? 0 : st.size,
      timestamp: st.mtimeMs,
    });
  }
  entries.sort((a, b) => {
    if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  const pathCrumbs: { id: string; name: string }[] = [
    { id: "root", name: "MEGA" },
  ];
  if (rel) {
    const segs = rel.split("/");
    for (let i = 0; i < segs.length; i++) {
      pathCrumbs.push({
        id: encNodeId(segs.slice(0, i + 1).join("/")),
        name: segs[i],
      });
    }
  }
  return { nodeId: encNodeId(rel), path: pathCrumbs, entries };
}

/** Stat satu node fake. */
export async function fakeMegaStat(
  nodeId: string
): Promise<MegaStatResult> {
  const abs = fakePath(nodeId);
  if (!abs) throw new Error("MEGA_NODE_NOT_FOUND");
  let st;
  try {
    st = await fs.stat(abs);
  } catch {
    throw new Error("MEGA_NODE_NOT_FOUND");
  }
  const rel = path.relative(fakeRoot(), abs);
  return {
    nodeId: encNodeId(rel),
    name: rel ? path.basename(rel) : "MEGA",
    size: st.isDirectory() ? 0 : st.size,
    isFolder: st.isDirectory(),
  };
}

/** Unduh berkas fake → Buffer (null bila bukan berkas/tidak ada). */
export async function fakeMegaDownload(
  nodeId: string
): Promise<Buffer | null> {
  const abs = fakePath(nodeId);
  if (!abs) return null;
  try {
    const st = await fs.stat(abs);
    if (!st.isFile()) return null;
    return await fs.readFile(abs);
  } catch {
    return null;
  }
}

/** "Unduh" berkas fake ke disk — hardlink (instant, sparse tetap sparse),
 *  jatuh ke salinan bila hardlink tak mungkin (lintas FS). */
export async function fakeMegaDownloadToFile(
  nodeId: string,
  destPath: string
): Promise<boolean> {
  const abs = fakePath(nodeId);
  if (!abs) return false;
  try {
    const st = await fs.stat(abs);
    if (!st.isFile()) return false;
    await fs.mkdir(path.dirname(destPath), { recursive: true });
    try {
      await fs.link(abs, destPath);
    } catch {
      await fs.copyFile(abs, destPath);
    }
    return true;
  } catch {
    return false;
  }
}

/** Unggah berkas fake dari stream — mirror megaUploadStreamTo. */
export async function fakeMegaUploadStreamTo(
  account: MegaAccountLike,
  parentNodeId: string | null | undefined,
  name: string,
  size: number,
  readable: import("node:stream").Readable
): Promise<MegaUploadResult> {
  const parentAbs = fakePath(parentNodeId);
  if (!parentAbs || !(await existsDir(parentAbs))) {
    throw new Error("MEGA_FOLDER_NOT_FOUND");
  }
  const abs = path.join(parentAbs, name);
  const { createWriteStream } = await import("node:fs");
  const ws = createWriteStream(abs);
  await new Promise<void>((resolve, reject) => {
    ws.on("error", reject);
    readable.on("error", reject);
    readable.pipe(ws);
    ws.on("finish" as string, () => resolve());
  });
  const rel = path.relative(fakeRoot(), abs);
  return {
    storageKey: `mega:${account.id}:${encNodeId(rel)}`,
    size,
    nodeId: encNodeId(rel),
  } as MegaUploadResult;
}

/** Buat folder fake; kembalikan node id folder baru. */
export async function fakeMegaMkdir(
  parentNodeId: string | null | undefined,
  name: string
): Promise<{ nodeId: string }> {
  const parentAbs = fakePath(parentNodeId);
  if (!parentAbs || !(await existsDir(parentAbs))) {
    throw new Error("MEGA_FOLDER_NOT_FOUND");
  }
  const abs = path.join(parentAbs, name);
  await fs.mkdir(abs, { recursive: true });
  const rel = path.relative(fakeRoot(), abs);
  return { nodeId: encNodeId(rel) };
}

/** Unggah berkas fake; kembalikan hasil mirror megaUploadTo. */
export async function fakeMegaUploadTo(
  account: MegaAccountLike,
  parentNodeId: string | null | undefined,
  name: string,
  bytes: Buffer
): Promise<MegaUploadResult> {
  const parentAbs = fakePath(parentNodeId);
  if (!parentAbs || !(await existsDir(parentAbs))) {
    throw new Error("MEGA_FOLDER_NOT_FOUND");
  }
  const abs = path.join(parentAbs, name);
  await fs.writeFile(abs, bytes);
  const rel = path.relative(fakeRoot(), abs);
  return {
    storageKey: `mega:${account.id}:${encNodeId(rel)}`,
    size: bytes.length,
    nodeId: encNodeId(rel),
  } as MegaUploadResult;
}
