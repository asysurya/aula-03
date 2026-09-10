"use client";

// ─────────────────────────────────────────────────────────────────────────
// Transfer Manager — upload & download berjalan di BACKGROUND.
//
// - Antrean global (zustand, singleton) dengan maks 2 job aktif bersamaan.
// - Kontrol per job: pause / resume / cancel / retry / reorder / hapus.
// - Progress di-flush ke state React SETIAP 2 DETIK (biar prosesnya jelas
//   terlihat, tidak spam re-render). Transisi status (selesai/gagal/batal)
//   diterapkan langsung tanpa menunggu flush.
// - Upload: file kecil = XHR langsung; file besar = chunked (init/chunk/
//   complete) — pause di tengah chunk membatalkan chunk itu saja, lanjut
//   dari chunk berikutnya saat resume.
// - Download: fetch + stream; pause → abort; resume → lanjut via header
//   Range dari byte terakhir diterima (server mendukung 206).
// ─────────────────────────────────────────────────────────────────────────

import { create } from "zustand";
import { toast } from "sonner";
import type { SmartUploadTarget } from "@/lib/upload-client";

export type TransferKind = "upload" | "download";
export type TransferStatus =
  | "queued"
  | "active"
  | "paused"
  | "done"
  | "error"
  | "cancelled";

export interface TransferJob {
  id: string;
  kind: TransferKind;
  name: string;
  /** total byte (0 = tidak diketahui, mis. download tanpa content-length) */
  size: number;
  loaded: number;
  status: TransferStatus;
  error?: string | null;
  /** byte/detik — dihitung ulang tiap flush (delta 2 detik) */
  speed: number;
  createdAt: number;
  startedAt?: number | null;
  finishedAt?: number | null;
  /** konteks asal (tampil di modal): "Cloud", "Mount MEGA", "Chat", dll */
  context: string;
}

// ── Runtime job (di luar state React — tidak ikut render) ──

interface JobRuntime {
  id: string;
  kind: TransferKind;
  file?: File;
  target?: SmartUploadTarget;
  url?: string;
  /** nama file untuk disimpan saat unduhan selesai */
  saveName?: string;
  autoSave?: boolean;
  onDoneFile?: (fileId: string, extra: Record<string, unknown>) => void;
  onBlob?: (blob: Blob) => void;
  onFileOps?: () => void;
  /** byte terbaru (belum di-flush) */
  liveLoaded: number;
  /** byte pada flush terakhir (untuk hitung speed) */
  lastFlushLoaded: number;
  lastFlushAt: number;
  // kontrol eksekusi
  cancelled: boolean;
  pauseRequested: boolean;
  paused: boolean;
  abortCurrent: () => void;
  waitResume: () => Promise<void>;
  notifyResume: (() => void) | null;
  /** bagian blob download yang sudah diterima (untuk resume Range) */
  parts?: Blob[];
  /** ukuran total yang diketahui saat mengunduh (dari header) */
  liveSizeHint?: number;
  execPromise?: Promise<void>;
}

const runtimes = new Map<string, JobRuntime>();
const MAX_ACTIVE = 2;
const FLUSH_MS = 2000;

function newId(): string {
  return `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function fmtName(name: string, max = 40): string {
  return name.length > max ? `${name.slice(0, max - 3)}…` : name;
}

// ── State & actions ──

interface TransferState {
  jobs: TransferJob[];
  enqueueUpload: (opts: {
    file: File;
    target: SmartUploadTarget;
    context?: string;
    onDoneFile?: (fileId: string, extra: Record<string, unknown>) => void;
    onFileOps?: () => void;
  }) => string;
  enqueueDownload: (opts: {
    url: string;
    name: string;
    size?: number;
    context?: string;
    autoSave?: boolean;
    onBlob?: (blob: Blob) => void;
  }) => string;
  pauseJob: (id: string) => void;
  resumeJob: (id: string) => void;
  cancelJob: (id: string) => void;
  retryJob: (id: string) => void;
  removeJob: (id: string) => void;
  moveJob: (id: string, dir: -1 | 1) => void;
  clearFinished: () => void;
}

export const useTransferStore = create<TransferState>((set, get) => ({
  jobs: [],

  enqueueUpload({ file, target, context = "Cloud", onDoneFile, onFileOps }) {
    const id = newId();
    runtimes.set(id, {
      id,
      kind: "upload",
      file,
      target,
      onDoneFile,
      onFileOps,
      liveLoaded: 0,
      lastFlushLoaded: 0,
      lastFlushAt: Date.now(),
      cancelled: false,
      pauseRequested: false,
      paused: false,
      abortCurrent: () => {},
      waitResume: () => Promise.resolve(),
      notifyResume: null,
    });
    set((s) => ({
      jobs: [
        ...s.jobs,
        {
          id,
          kind: "upload",
          name: fmtName(file.name),
          size: file.size,
          loaded: 0,
          status: "queued",
          error: null,
          speed: 0,
          createdAt: Date.now(),
          context,
        },
      ],
    }));
    pump();
    return id;
  },

  enqueueDownload({ url, name, size = 0, context = "Unduhan", autoSave = true, onBlob }) {
    const id = newId();
    runtimes.set(id, {
      id,
      kind: "download",
      url,
      saveName: name,
      autoSave,
      onBlob,
      liveLoaded: 0,
      lastFlushLoaded: 0,
      lastFlushAt: Date.now(),
      cancelled: false,
      pauseRequested: false,
      paused: false,
      abortCurrent: () => {},
      waitResume: () => Promise.resolve(),
      notifyResume: null,
      parts: [],
    });
    set((s) => ({
      jobs: [
        ...s.jobs,
        {
          id,
          kind: "download",
          name: fmtName(name),
          size,
          loaded: 0,
          status: "queued",
          error: null,
          speed: 0,
          createdAt: Date.now(),
          context,
        },
      ],
    }));
    pump();
    return id;
  },

  pauseJob(id) {
    const rt = runtimes.get(id);
    if (!rt) return;
    if (rt.cancelled) return;
    const job = get().jobs.find((j) => j.id === id);
    if (!job || (job.status !== "active" && job.status !== "queued")) return;
    rt.pauseRequested = true;
    if (job.status === "active") {
      // Batalkan request yang sedang berjalan — runner mendeteksi pauseRequested
      // lalu berhenti rapi pada batas chunk/byte terakhir.
      try {
        rt.abortCurrent();
      } catch {
        /* abaikan */
      }
    }
    set((s) => ({
      jobs: s.jobs.map((j) =>
        j.id === id ? { ...j, status: "paused", speed: 0 } : j
      ),
    }));
  },

  resumeJob(id) {
    const rt = runtimes.get(id);
    if (!rt) return;
    const job = get().jobs.find((j) => j.id === id);
    if (!job || job.status !== "paused") return;
    rt.pauseRequested = false;
    if (rt.paused) {
      rt.paused = false;
      rt.notifyResume?.();
      rt.notifyResume = null;
    }
    set((s) => ({
      jobs: s.jobs.map((j) =>
        j.id === id ? { ...j, status: "queued" } : j
      ),
    }));
    pump();
  },

  cancelJob(id) {
    const rt = runtimes.get(id);
    const job = get().jobs.find((j) => j.id === id);
    if (!job || job.status === "done" || job.status === "cancelled") return;
    if (rt) {
      rt.cancelled = true;
      try {
        rt.abortCurrent();
      } catch {
        /* abaikan */
      }
      if (rt.paused) {
        rt.paused = false;
        rt.notifyResume?.();
        rt.notifyResume = null;
      }
    }
    set((s) => ({
      jobs: s.jobs.map((j) =>
        j.id === id
          ? { ...j, status: "cancelled", speed: 0, finishedAt: Date.now() }
          : j
      ),
    }));
    pump();
  },

  retryJob(id) {
    const rt = runtimes.get(id);
    const job = get().jobs.find((j) => j.id === id);
    if (!rt || !job || job.status !== "error") return;
    // Reset runtime progres; eksekusi ulang dari awal.
    rt.cancelled = false;
    rt.pauseRequested = false;
    rt.paused = false;
    rt.liveLoaded = 0;
    rt.lastFlushLoaded = 0;
    rt.lastFlushAt = Date.now();
    rt.parts = [];
    set((s) => ({
      jobs: s.jobs.map((j) =>
        j.id === id
          ? { ...j, status: "queued", loaded: 0, speed: 0, error: null }
          : j
      ),
    }));
    pump();
  },

  removeJob(id) {
    const rt = runtimes.get(id);
    const job = get().jobs.find((j) => j.id === id);
    if (job && (job.status === "active" || job.status === "queued" || job.status === "paused")) {
      // Job masih hidup → perlakukan remove sebagai cancel.
      get().cancelJob(id);
    }
    runtimes.delete(id);
    set((s) => ({ jobs: s.jobs.filter((j) => j.id !== id) }));
  },

  moveJob(id, dir) {
    set((s) => {
      const idx = s.jobs.findIndex((j) => j.id === id);
      if (idx === -1) return s;
      const target = idx + dir;
      if (target < 0 || target >= s.jobs.length) return s;
      const next = [...s.jobs];
      const [item] = next.splice(idx, 1);
      next.splice(target, 0, item);
      return { jobs: next };
    });
    pump();
  },

  clearFinished() {
    set((s) => ({
      jobs: s.jobs.filter(
        (j) => j.status !== "done" && j.status !== "cancelled" && j.status !== "error"
      ),
    }));
  },
}));

// ── Scheduler: jalankan job antrean selama slot aktif tersedia ──

function pump() {
  if (typeof window === "undefined") return;
  const state = useTransferStore.getState();
  const activeCount = state.jobs.filter(
    (j) => j.status === "active" || j.status === "paused"
  ).length;
  if (activeCount >= MAX_ACTIVE) return;

  const next = state.jobs.find((j) => j.status === "queued");
  if (!next) return;
  const rt = runtimes.get(next.id);
  if (!rt) {
    useTransferStore.setState((s) => ({
      jobs: s.jobs.filter((j) => j.id !== next.id),
    }));
    pump();
    return;
  }

  useTransferStore.setState((s) => ({
    jobs: s.jobs.map((j) =>
      j.id === next.id
        ? { ...j, status: "active", startedAt: j.startedAt ?? Date.now() }
        : j
    ),
  }));

  rt.execPromise = (rt.kind === "upload"
    ? runUpload(rt)
    : runDownload(rt)
  )
    .then(() => {
      finishJob(rt.id, "done");
    })
    .catch((e: unknown) => {
      if (rt.cancelled) {
        finishJob(rt.id, "cancelled");
        return;
      }
      if (rt.pauseRequested) {
        // Runner berhenti karena pause — status sudah "paused" dari pauseJob().
        return;
      }
      const msg =
        e instanceof Error ? e.message : "Transfer gagal";
      finishJob(rt.id, "error", msg);
    });
}

function finishJob(id: string, status: "done" | "error" | "cancelled", error?: string) {
  useTransferStore.setState((s) => ({
    jobs: s.jobs.map((j) =>
      j.id === id
        ? {
            ...j,
            status,
            error: error ?? null,
            speed: 0,
            finishedAt: Date.now(),
            loaded: status === "done" ? j.size || j.loaded : j.loaded,
          }
        : j
    ),
  }));
  const rt = runtimes.get(id);
  if (status === "done" && rt) {
    // Toast ringan tanpa memblokir.
    if (rt.kind === "upload") {
      toast.success(`Upload selesai: ${rt.file?.name ?? "file"}`);
    } else if (rt.autoSave) {
      toast.success(`Unduhan selesai: ${rt.url?.split("/").pop()?.slice(0, 40) ?? "file"}`);
    }
  }
  pump();
}

// ── Flush 2 detik: salin progres live → state (progress bar update tiap 2 dtk) ──

let flushTimer: ReturnType<typeof setInterval> | null = null;

export function __initTransferFlush() {
  if (typeof window === "undefined") return;
  if (flushTimer) return;
  flushTimer = setInterval(() => {
    const state = useTransferStore.getState();
    if (state.jobs.length === 0) return;
    const now = Date.now();
    const patch = new Map<string, { loaded: number; speed: number }>();
    for (const j of state.jobs) {
      if (j.status !== "active") continue;
      const rt = runtimes.get(j.id);
      if (!rt) continue;
      const dt = (now - rt.lastFlushAt) / 1000;
      const dBytes = Math.max(0, rt.liveLoaded - rt.lastFlushLoaded);
      const speed = dt > 0 ? dBytes / dt : 0;
      patch.set(j.id, { loaded: rt.liveLoaded, speed });
      rt.lastFlushLoaded = rt.liveLoaded;
      rt.lastFlushAt = now;
    }
    if (patch.size === 0) return;
    useTransferStore.setState((s) => ({
      jobs: s.jobs.map((j) => {
        const p = patch.get(j.id);
        return p ? { ...j, loaded: p.loaded, speed: p.speed } : j;
      }),
    }));
  }, FLUSH_MS);
}

// Auto-init di client (import pertama oleh komponen apa pun).
if (typeof window !== "undefined") {
  __initTransferFlush();
}

// ── Runner: UPLOAD ──

const DIRECT_THRESHOLD = 4 * 1024 * 1024; // sama dengan uploadSmart

function makePauseGate(rt: JobRuntime) {
  rt.waitResume = () =>
    new Promise<void>((resolve) => {
      rt.notifyResume = resolve;
    });
}

async function ensureNotPausedOrCancelled(rt: JobRuntime) {
  if (rt.cancelled) throw new Error("__CANCELLED__");
  if (rt.pauseRequested) {
    rt.paused = true;
    makePauseGate(rt);
    await rt.waitResume();
    rt.paused = false;
    if (rt.cancelled) throw new Error("__CANCELLED__");
  }
}

function xhrPost(
  url: string,
  form: FormData,
  rt: JobRuntime,
  onProgress?: (loaded: number) => void
): Promise<{ ok: boolean; status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    rt.abortCurrent = () => xhr.abort();
    xhr.open("POST", url);
    xhr.responseType = "json";
    if (onProgress && xhr.upload) {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress(e.loaded);
      };
    }
    xhr.onload = () => {
      const json =
        xhr.response && typeof xhr.response === "object"
          ? (xhr.response as Record<string, unknown>)
          : {};
      resolve({ ok: xhr.status >= 200 && xhr.status < 300, status: xhr.status, json });
    };
    xhr.onabort = () =>
      reject(new Error(rt.cancelled ? "__CANCELLED__" : "__PAUSED__"));
    xhr.onerror = () => reject(new Error("Kesalahan jaringan saat mengunggah"));
    xhr.send(form);
  });
}

async function postJson(
  url: string,
  body: unknown
): Promise<{ ok: boolean; status: number; json: Record<string, unknown> }> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) ?? {};
    return { ok: res.ok, status: res.status, json: json as Record<string, unknown> };
  } catch {
    return { ok: false, status: 0, json: { error: "Kesalahan jaringan" } };
  }
}

/** Endpoint + FormData untuk jalur langsung (file kecil), per target. */
function buildDirectForm(file: File, target: SmartUploadTarget): { url: string; form: FormData } {
  const form = new FormData();
  form.append("file", file);
  switch (target.kind) {
    case "cloud-file": {
      if (target.folderId) form.append("folderId", target.folderId);
      if (target.classroomId) form.append("classroomId", target.classroomId);
      if (target.visibility) form.append("visibility", target.visibility);
      return { url: "/api/cloud/files", form };
    }
    case "submission": {
      form.append("assignmentId", target.assignmentId ?? "");
      if (target.note) form.append("note", target.note);
      return { url: "/api/cloud/submissions", form };
    }
    case "mega": {
      if (target.parentId) form.append("parentId", target.parentId);
      if (target.accountId) form.append("accountId", target.accountId);
      return { url: "/api/cloud/mega/upload", form };
    }
    default:
      return { url: "/api/cloud/files", form };
  }
}

async function runUpload(rt: JobRuntime) {
  const file = rt.file;
  const target = rt.target;
  if (!file || !target) throw new Error("Upload tidak valid");

  // ── Jalur 1: file kecil → POST langsung ──
  if (file.size <= DIRECT_THRESHOLD) {
    const { url, form } = buildDirectForm(file, target);
    let lastErr = "";
    for (let attempt = 1; attempt <= 3; attempt++) {
      await ensureNotPausedOrCancelled(rt);
      try {
        const res = await xhrPost(url, form, rt, (loaded) => {
          rt.liveLoaded = Math.min(loaded, file.size);
        });
        if (!res.ok) {
          lastErr = (res.json.error as string) || `Gagal (${res.status})`;
          // Error fungsional (4xx) tidak perlu diulang.
          if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429)
            throw new Error(lastErr);
          throw new Error(lastErr);
        }
        rt.liveLoaded = file.size;
        const fileId =
          (res.json.fileId as string | undefined) ??
          ((res.json.file as { id?: string } | undefined)?.id ?? "");
        rt.onDoneFile?.(fileId, res.json);
        rt.onFileOps?.();
        return;
      } catch (e) {
        const msg = e instanceof Error ? e.message : "";
        if (msg === "__CANCELLED__") throw e;
        if (msg === "__PAUSED__") {
          // Pause di tengah request → ulang request ini setelah resume.
          continue;
        }
        if (attempt === 3) throw new Error(msg || "Upload gagal");
        await new Promise((r) => setTimeout(r, 600 * attempt));
      }
    }
    throw new Error(lastErr || "Upload gagal");
  }

  // ── Jalur 2: file besar → chunked ──
  const init = await postJson("/api/upload/init", {
    name: file.name,
    size: file.size,
    mimetype: file.type || "application/octet-stream",
  });
  if (!init.ok) throw new Error((init.json.error as string) || "Gagal memulai upload");

  const { uploadId, chunkSize, chunkCount } = init.json as {
    uploadId: string;
    chunkSize: number;
    chunkCount: number;
  };

  let chunkIdx = 0;
  while (chunkIdx < chunkCount) {
    await ensureNotPausedOrCancelled(rt);
    const start = chunkIdx * chunkSize;
    const end = Math.min(file.size, start + chunkSize);
    const blob = file.slice(start, end);
    const base = start; // progres = base + progressXHR
    const form = new FormData();
    form.append("uploadId", uploadId);
    form.append("idx", String(chunkIdx));
    form.append("chunk", blob, `chunk-${chunkIdx}`);
    try {
      const res = await xhrPost("/api/upload/chunk", form, rt, (loaded) => {
        rt.liveLoaded = base + Math.min(loaded, blob.size);
      });
      if (!res.ok) {
        throw new Error((res.json.error as string) || `Chunk gagal (${res.status})`);
      }
      rt.liveLoaded = end;
      chunkIdx++;
    } catch (e) {
      const msg = e instanceof Error ? e.message : "";
      if (msg === "__CANCELLED__") throw e;
      if (msg === "__PAUSED__") continue; // ulangi chunk yang sama setelah resume
      throw new Error(msg || "Chunk gagal");
    }
  }

  await ensureNotPausedOrCancelled(rt);
  const complete = await postJson("/api/upload/complete", {
    uploadId,
    target: {
      kind: target.kind,
      folderId: target.folderId ?? null,
      classroomId: target.classroomId ?? null,
      visibility: target.visibility ?? null,
      assignmentId: target.assignmentId,
      note: target.note ?? null,
      parentId: target.parentId ?? null,
      accountId: target.accountId ?? null,
      convKind: target.convKind,
      convId: target.convId,
      questionId: target.questionId,
    },
  });
  if (!complete.ok) {
    throw new Error((complete.json.error as string) || "Finalisasi upload gagal");
  }
  rt.liveLoaded = file.size;
  const fileId =
    (complete.json.fileId as string) ??
    ((complete.json.file as { id?: string } | undefined)?.id ?? "");
  rt.onDoneFile?.(fileId, complete.json);
  rt.onFileOps?.();
}

// ── Runner: DOWNLOAD (fetch + stream + resume Range) ──

async function runDownload(rt: JobRuntime) {
  if (!rt.url) throw new Error("URL unduhan tidak valid");
  let received = rt.parts?.length ? rt.parts.reduce((s, b) => s + b.size, 0) : 0;
  rt.liveLoaded = received;

  for (let attempt = 1; attempt <= 3; attempt++) {
    await ensureNotPausedOrCancelled(rt);
    const ctrl = new AbortController();
    rt.abortCurrent = () => ctrl.abort();
    try {
      const headers: Record<string, string> = {};
      if (received > 0) headers["Range"] = `bytes=${received}-`;
      const res = await fetch(rt.url, { headers, signal: ctrl.signal });
      if (!res.ok && res.status !== 206) {
        throw new Error(`HTTP ${res.status}`);
      }
      const isRange = res.status === 206;
      if (!isRange && received > 0) {
        // Server balas 200 (tidak dukung range utk request ini) → restart.
        received = 0;
        rt.parts = [];
        rt.liveLoaded = 0;
      }
      // Total size dari header.
      const totalHeader = res.headers.get("content-length");
      const crHeader = res.headers.get("content-range"); // "bytes s-e/total"
      if (crHeader) {
        const total = Number(crHeader.split("/")[1]);
        if (Number.isFinite(total)) rt.liveSizeHint = total;
      } else if (totalHeader && !isRange) {
        const total = Number(totalHeader);
        if (Number.isFinite(total)) rt.liveSizeHint = received + total;
      }
      syncSizeHint(rt);

      if (!res.body) {
        // Fallback tanpa stream.
        const buf = await res.arrayBuffer();
        rt.parts = [new Blob([buf])];
        received = buf.byteLength;
        rt.liveLoaded = received;
      } else {
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            rt.parts?.push(new Blob([value]));
            received += value.byteLength;
            rt.liveLoaded = received;
            syncSizeHint(rt);
          }
          if (rt.cancelled || rt.pauseRequested) {
            try {
              ctrl.abort();
            } catch {
              /* abaikan */
            }
            break;
          }
        }
      }
      if (rt.cancelled) throw new Error("__CANCELLED__");
      if (rt.pauseRequested) throw new Error("__PAUSED__");

      // Selesai → rakit blob.
      const blob = new Blob(rt.parts ?? []);
      if (rt.autoSave) saveBlob(blob, downloadNameFromRt(rt));
      rt.onBlob?.(blob);
      return;
    } catch (e) {
      const msg = e instanceof Error ? e.message : "";
      if (msg === "__CANCELLED__") throw e;
      // Abort karena pause → keluar rapi; pauseJob sudah set status.
      if (rt.pauseRequested) throw new Error("__PAUSED__");
      if (attempt === 3) throw new Error(msg || "Unduhan gagal");
      await new Promise((r) => setTimeout(r, 600 * attempt));
    }
  }
}

function downloadNameFromRt(rt: JobRuntime): string {
  // Nama eksplisit dari pemanggil enqueueDownload — kredibel.
  if (rt.saveName && rt.saveName !== "file") return rt.saveName;
  // Fallback dari akhir URL (hati-hati: /api/storage/<key> mengandung ":").
  const fromName = decodeURIComponent(
    rt.url?.split("?")[0].split("/").pop() ?? ""
  );
  if (!fromName || fromName.includes(":") || fromName.length > 80) return "file";
  return fromName;
}

function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 15000);
}

// Ukuran total kadang baru ketahuan saat unduhan berjalan → sinkron ke job.
function syncSizeHint(rt: JobRuntime) {
  const hint = rt.liveSizeHint;
  if (hint && hint > 0) {
    useTransferStore.setState((s) => ({
      jobs: s.jobs.map((j) =>
        j.id === rt.id && j.size !== hint ? { ...j, size: hint } : j
      ),
    }));
  }
}

// ── Helper publik untuk UI ──

export function transferStats(jobs: TransferJob[]) {
  const active = jobs.filter((j) => j.status === "active");
  const queued = jobs.filter((j) => j.status === "queued");
  const paused = jobs.filter((j) => j.status === "paused");
  const totalActivePct = active.length
    ? Math.round(
        active.reduce((s, j) => {
          const p = j.size > 0 ? (j.loaded / j.size) * 100 : 0;
          return s + p;
        }, 0) / active.length
      )
    : 0;
  return { active, queued, paused, totalActivePct };
}
