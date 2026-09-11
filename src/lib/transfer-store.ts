"use client";

// ─────────────────────────────────────────────────────────────────────────
// Transfer Manager — upload & download berjalan di BACKGROUND.
//
// - Antrean global (zustand, singleton) dengan maks 2 job aktif bersamaan.
// - Kontrol per job: pause / resume / cancel / retry / reorder / hapus.
// - Progress di-flush ke state React SETIAP 1 DETIK (biar prosesnya jelas
//   terlihat, tidak spam re-render). Transisi status (selesai/gagal/batal)
//   diterapkan langsung tanpa menunggu flush.
// - Upload: file kecil = XHR langsung; file besar = chunked (init/chunk/
//   complete) dengan UPLOAD_PARALLEL chunk terkirim BERSAMAAN — saat server
//   memproses satu chunk, byte chunk lain tetap mengalir sehingga progress
//   tidak flat / kecepatan tidak drop karena duty-cycle. Pause membatalkan
//   seluruh chunk in-flight saja (belum selesai tidak dihitung); resume
//   melanjutkan chunk yang tersisa. Setelah semua chunk terkirim, fase
//   "finalizing" (Menyimpan ke cloud…) tampil selama /api/upload/complete
//   masih berjalan.
// - Download: file ≥ 8MB dari server pendukung Range (206) diunduh dalam
//   DOWNLOAD_SEGMENTS segmen paralel; file kecil / tanpa Range = single
//   stream. Pause menyimpan progres PER SEGMEN; resume melanjutkan segmen
//   yang belum tuntas via Range dari offset segmen itu.
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
  /** fase aktif job: "finalizing" = semua byte terkirim, server sedang
   *  merakit chunk & menyimpan ke cloud (tampil: "Menyimpan ke cloud…"). */
  phase?: "uploading" | "finalizing";
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
  /** true selama runner (runUpload/runDownload) mengeksekusi — mencegah
   *  pump menjalankan job dua kali (mis. resume dari pause yang tertahan
   *  di gate runner lama). */
  running: boolean;
  /** fase tampilan job (mirror TransferJob.phase) */
  phase?: "uploading" | "finalizing";
  /** unduhan bersegmen: total byte file & state tiap segmen */
  segTotal?: number;
  segs?: DownloadSeg[];
}

/** Satu segmen unduhan paralel (rentang byte inklusif). */
interface DownloadSeg {
  start: number;
  end: number;
  /** byte diterima pada segmen ini */
  received: number;
  /** potongan blob segmen (urut) */
  parts: Blob[];
}

const runtimes = new Map<string, JobRuntime>();
const MAX_ACTIVE = 2;
const FLUSH_MS = 1000;
/** Jumlah chunk upload yang dikirim bersamaan — saat server memproses satu
 *  chunk (parse formData + upsert MongoDB) byte chunk lain tetap mengalir
 *  sehingga duty-cycle mendekati 100%. */
const UPLOAD_PARALLEL = 3;
/** Unduhan besar dipecah jadi segmen Range paralel. */
const DOWNLOAD_SEGMENTS = 4;
/** Ambang ukuran minimal agar unduhan dipecah segmen paralel. */
const SEGMENT_MIN_BYTES = 8 * 1024 * 1024;

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
      running: false,
      phase: "uploading",
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
      running: false,
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
      // Runner lama masih hidup, hanya tertahan di gate pause — aktifkan
      // kembali TANPA memulai ulang (state progres/uploadId dipertahankan).
      rt.paused = false;
      rt.notifyResume?.();
      rt.notifyResume = null;
      set((s) => ({
        jobs: s.jobs.map((j) =>
          j.id === id ? { ...j, status: "active" } : j
        ),
      }));
      return;
    }
    // Runner sudah keluar saat pause (mis. jalur download) → antrekan ulang;
    // runner baru melanjutkan dari state tersimpan (parts/segments).
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
    rt.segs = undefined;
    rt.segTotal = undefined;
    rt.phase = "uploading";
    set((s) => ({
      jobs: s.jobs.map((j) =>
        j.id === id
          ? { ...j, status: "queued", loaded: 0, speed: 0, error: null, phase: undefined }
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

  // Lewati job "queued" yang runner-nya masih hidup (pause yang menahan
  // runner lama di gate, lalu di-resume) — jangan jalankan dua kali.
  const next = state.jobs.find(
    (j) => j.status === "queued" && !runtimes.get(j.id)?.running
  );
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

  rt.running = true;
  rt.execPromise = (rt.kind === "upload"
    ? runUpload(rt)
    : runDownload(rt)
  )
    .then(() => {
      rt.running = false;
      if (rt.cancelled) {
        finishJob(rt.id, "cancelled");
        return;
      }
      finishJob(rt.id, "done");
    })
    .catch((e: unknown) => {
      rt.running = false;
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
            phase: undefined,
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

// ── Flush 1 detik: salin progres live → state (progress bar update tiap 1 dtk) ──

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

/** Ubah fase tampilan job (hanya setState saat benar-benar berubah). */
function setJobPhase(rt: JobRuntime, phase: "uploading" | "finalizing") {
  if (rt.phase === phase) return;
  rt.phase = phase;
  useTransferStore.setState((s) => ({
    jobs: s.jobs.map((j) => (j.id === rt.id ? { ...j, phase } : j)),
  }));
}

/** Samakan loaded di store dengan hitungan akurat setelah pause — chunk /
 *  segmen yang belum selesai tidak dihitung, jadi tampilannya tidak "mentok"
 *  di angka yang salah saat dijeda. */
function syncLoadedAfterPause(rt: JobRuntime) {
  setTimeout(() => {
    useTransferStore.setState((s) => ({
      jobs: s.jobs.map((j) =>
        j.id === rt.id && j.status === "paused"
          ? { ...j, loaded: rt.liveLoaded, speed: 0 }
          : j
      ),
    }));
  }, 0);
}

function xhrPost(
  url: string,
  form: FormData,
  rt: JobRuntime,
  onProgress?: (loaded: number) => void,
  /** Jalur paralel: semua abort XHR in-flight didaftarkan di registry ini
   *  sehingga pause/cancel dapat membatalkan sekaligus. */
  abortReg?: Set<() => void>
): Promise<{ ok: boolean; status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const abortFn = () => xhr.abort();
    const cleanup = () => {
      if (abortReg) abortReg.delete(abortFn);
      else if (rt.abortCurrent === abortFn) rt.abortCurrent = () => {};
    };
    if (abortReg) abortReg.add(abortFn);
    else rt.abortCurrent = abortFn;
    xhr.open("POST", url);
    xhr.responseType = "json";
    if (onProgress && xhr.upload) {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress(e.loaded);
      };
    }
    xhr.onload = () => {
      cleanup();
      const json =
        xhr.response && typeof xhr.response === "object"
          ? (xhr.response as Record<string, unknown>)
          : {};
      resolve({ ok: xhr.status >= 200 && xhr.status < 300, status: xhr.status, json });
    };
    xhr.onabort = () => {
      cleanup();
      reject(new Error(rt.cancelled ? "__CANCELLED__" : "__PAUSED__"));
    };
    xhr.onerror = () => {
      cleanup();
      reject(new Error("Kesalahan jaringan saat mengunggah"));
    };
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
          // Semua byte terkirim tapi respons belum balas → server sedang
          // menyimpan ke cloud → tampilkan "Menyimpan ke cloud…".
          setJobPhase(rt, loaded >= file.size ? "finalizing" : "uploading");
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
        setJobPhase(rt, "uploading");
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

  // ── Kirim chunk PARALEL (hingga UPLOAD_PARALLEL bersamaan) ──
  // Saat server memproses satu chunk (parse formData + upsert MongoDB),
  // byte chunk lain tetap mengalir → progress tidak flat / duty-cycle ~100%.
  const chunkEnd = (idx: number) => Math.min(file.size, (idx + 1) * chunkSize);
  const chunkLen = (idx: number) => chunkEnd(idx) - idx * chunkSize;

  // Chunk yang sudah tersimpan di server.
  const done = new Set<number>();
  // Progres XHR yang sedang terbang (idx → byte terkirim, monotonik).
  const inFlight = new Map<number, number>();
  // Semua abort in-flight terdaftar sini → pause/cancel membatalkan semua.
  const aborts = new Set<() => void>();
  // Chunk yang gagal permanen → sibling di-abort, job gagal.
  let fatalError: unknown = null;

  rt.abortCurrent = () => {
    for (const fn of [...aborts]) {
      try {
        fn();
      } catch {
        /* abaikan */
      }
    }
  };

  const recompute = () => {
    let loaded = 0;
    for (const idx of done) loaded += chunkLen(idx);
    for (const prog of inFlight.values()) loaded += prog;
    rt.liveLoaded = Math.min(loaded, file.size);
  };

  /** Kirim satu chunk — retry mandiri (chunk lain tidak ikut gagal). */
  const sendChunk = async (idx: number): Promise<void> => {
    const start = idx * chunkSize;
    const blob = file.slice(start, chunkEnd(idx));
    let lastErr = "";
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (fatalError) throw fatalError;
      if (rt.cancelled) throw new Error("__CANCELLED__");
      if (rt.pauseRequested) throw new Error("__PAUSED__");
      const form = new FormData();
      form.append("uploadId", uploadId);
      form.append("idx", String(idx));
      form.append("chunk", blob, `chunk-${idx}`);
      try {
        const res = await xhrPost("/api/upload/chunk", form, rt, (loaded) => {
          // Monotonik: progres percobaan ulang tidak menggeser bar mundur.
          const prev = inFlight.get(idx) ?? 0;
          inFlight.set(idx, Math.max(prev, Math.min(loaded, blob.size)));
          recompute();
        }, aborts);
        if (res.ok) {
          inFlight.delete(idx);
          done.add(idx);
          recompute();
          return;
        }
        lastErr = (res.json.error as string) || `Chunk ${idx} gagal (${res.status})`;
        // Error fungsional (4xx, bukan timeout/rate-limit): ulang percuma.
        if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429)
          break;
      } catch (e) {
        if (fatalError) throw fatalError;
        const msg = e instanceof Error ? e.message : "";
        if (msg === "__CANCELLED__") throw e;
        if (msg === "__PAUSED__") throw e; // keluar rapi; loop lama atur gate
        lastErr = msg;
      }
      if (attempt < 3) await new Promise((r) => setTimeout(r, 600 * attempt));
    }
    inFlight.delete(idx);
    recompute();
    throw new Error(lastErr || `Chunk ${idx} gagal`);
  };

  /** Ambil chunk berikutnya yang belum selesai (skip yang sudah done). */
  let cursor = 0;
  const takeNext = (): number => {
    while (cursor < chunkCount && done.has(cursor)) cursor++;
    if (cursor >= chunkCount) return -1;
    return cursor++;
  };

  const runWorkers = async (): Promise<void> => {
    const workers: Promise<void>[] = [];
    const n = Math.min(UPLOAD_PARALLEL, chunkCount);
    for (let w = 0; w < n; w++) {
      workers.push(
        (async () => {
          for (;;) {
            if (fatalError) throw fatalError;
            if (rt.cancelled) throw new Error("__CANCELLED__");
            if (rt.pauseRequested) throw new Error("__PAUSED__");
            const idx = takeNext();
            if (idx === -1) return;
            try {
              await sendChunk(idx);
            } catch (e) {
              if (rt.cancelled) throw new Error("__CANCELLED__");
              if (rt.pauseRequested) throw new Error("__PAUSED__");
              const msg = e instanceof Error ? e.message : "";
              if (msg === "__CANCELLED__" || msg === "__PAUSED__") throw e;
              // Chunk gagal permanen → hentikan sibling lain, gagalkan job.
              fatalError = e instanceof Error ? e : new Error("Chunk gagal");
              try {
                rt.abortCurrent();
              } catch {
                /* abaikan */
              }
              throw fatalError;
            }
          }
        })()
      );
    }
    await Promise.all(workers);
  };

  for (;;) {
    cursor = 0;
    try {
      await runWorkers();
      break; // semua chunk tersimpan di server
    } catch (e) {
      if (fatalError) throw fatalError;
      const msg = e instanceof Error ? e.message : "";
      if (msg !== "__PAUSED__") throw e; // __CANCELLED__ / error nyata
      // Pause: tunggu di gate; setelah resume kirim chunk yang tersisa saja
      // (chunk yang belum selesai tidak dihitung dalam liveLoaded).
      syncLoadedAfterPause(rt);
      await ensureNotPausedOrCancelled(rt);
    }
  }

  // Semua chunk terkirim → server merakit & menyimpan ke cloud.
  setJobPhase(rt, "finalizing");
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

// ── Runner: DOWNLOAD (paralel bersegmen + fallback single-stream) ──

type SegmentOutcome = "done" | "paused" | "cancelled" | "no-range";

async function runDownload(rt: JobRuntime) {
  if (!rt.url) throw new Error("URL unduhan tidak valid");

  // ── Resume unduhan bersegmen dari pause sebelumnya ──
  if (rt.segTotal && rt.segs && rt.segs.length > 0) {
    const outcome = await runSegments(rt);
    if (outcome === "done") return finishDownloadBlob(rt);
    if (outcome === "paused") {
      syncLoadedAfterPause(rt);
      throw new Error("__PAUSED__");
    }
    if (outcome === "cancelled") throw new Error("__CANCELLED__");
    // "no-range": server mulai mengabaikan Range saat resume → ulang
    // dari awal dengan single-stream.
    rt.segs = undefined;
    rt.segTotal = undefined;
    rt.parts = [];
    rt.liveLoaded = 0;
  }

  // Partial single-stream dari pause lama → langsung resume di jalur itu.
  if (rt.parts && rt.parts.length > 0) return runSingleStream(rt);

  // ── Mulai segar: probe dukungan Range (minta 1 byte) ──
  const probe = await probeRangeSupport(rt);
  if (probe.supportsRange && probe.total >= SEGMENT_MIN_BYTES) {
    // File besar + server dukung Range → unduh bersegmen paralel.
    rt.liveSizeHint = probe.total;
    syncSizeHint(rt);
    rt.segTotal = probe.total;
    rt.segs = buildSegments(probe.total, DOWNLOAD_SEGMENTS);
    const outcome = await runSegments(rt);
    if (outcome === "done") return finishDownloadBlob(rt);
    if (outcome === "paused") {
      syncLoadedAfterPause(rt);
      throw new Error("__PAUSED__");
    }
    if (outcome === "cancelled") throw new Error("__CANCELLED__");
    // no-range → jatuh ke single-stream di bawah.
    rt.segs = undefined;
    rt.segTotal = undefined;
  }
  return runSingleStream(rt);
}

/** Probe 1-byte: apakah server mendukung Range (206) & berapa total byte. */
async function probeRangeSupport(
  rt: JobRuntime
): Promise<{ supportsRange: boolean; total: number }> {
  let lastErr = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    await ensureNotPausedOrCancelled(rt);
    const ctrl = new AbortController();
    rt.abortCurrent = () => ctrl.abort();
    try {
      const res = await fetch(rt.url!, {
        headers: { Range: "bytes=0-0" },
        signal: ctrl.signal,
      });
      if (res.status === 206) {
        const total = parseRangeTotal(res.headers.get("content-range"));
        try {
          await res.body?.cancel();
        } catch {
          /* buang 1 byte probe */
        }
        return { supportsRange: true, total };
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // Server abaikan Range (balas 200) → buang body, pakai single-stream.
      try {
        await res.body?.cancel();
      } catch {
        /* abaikan */
      }
      return { supportsRange: false, total: 0 };
    } catch (e) {
      const msg = e instanceof Error ? e.message : "";
      if (rt.cancelled) throw new Error("__CANCELLED__");
      if (rt.pauseRequested) {
        syncLoadedAfterPause(rt);
        throw new Error("__PAUSED__");
      }
      if (attempt === 3) throw new Error(msg || "Unduhan gagal");
      lastErr = msg;
      await new Promise((r) => setTimeout(r, 600 * attempt));
    }
  }
  throw new Error(lastErr || "Unduhan gagal");
}

/** Pecah total byte jadi `count` segmen berurutan (rentang inklusif). */
function buildSegments(total: number, count: number): DownloadSeg[] {
  const segSize = Math.ceil(total / count);
  const segs: DownloadSeg[] = [];
  for (let i = 0; i < count; i++) {
    const start = i * segSize;
    if (start >= total) break;
    const end = Math.min(total - 1, start + segSize - 1);
    segs.push({ start, end, received: 0, parts: [] });
  }
  return segs;
}

/** "bytes 0-0/12345" → 12345 (0 bila tidak terbaca). */
function parseRangeTotal(header: string | null): number {
  if (!header) return 0;
  const m = /\/(\d+)\s*$/.exec(header);
  const total = m ? Number(m[1]) : NaN;
  return Number.isFinite(total) && total > 0 ? total : 0;
}

/** Unduh semua segmen yang belum tuntas secara paralel. */
async function runSegments(rt: JobRuntime): Promise<SegmentOutcome> {
  const total = rt.segTotal ?? 0;
  const segs = rt.segs ?? [];
  const aborts = new Set<() => void>();
  const shared = { noRange: false };

  rt.abortCurrent = () => {
    for (const fn of [...aborts]) {
      try {
        fn();
      } catch {
        /* abaikan */
      }
    }
  };

  const sumReceived = () => segs.reduce((s, g) => s + g.received, 0);

  const tasks: Promise<void>[] = [];
  for (const seg of segs) {
    if (seg.received >= seg.end - seg.start + 1) continue; // sudah tuntas
    tasks.push(downloadSegment(rt, seg, total, aborts, shared, sumReceived));
  }

  try {
    await Promise.all(tasks);
  } catch (e) {
    if (shared.noRange) return "no-range";
    const msg = e instanceof Error ? e.message : "";
    if (rt.cancelled) return "cancelled";
    if (rt.pauseRequested || msg === "__PAUSED__") return "paused";
    throw e;
  }
  return "done";
}

/** Unduh satu segmen dengan resume dari offset terakhir yang diterima. */
async function downloadSegment(
  rt: JobRuntime,
  seg: DownloadSeg,
  total: number,
  aborts: Set<() => void>,
  shared: { noRange: boolean },
  sumReceived: () => number
): Promise<void> {
  const segLen = seg.end - seg.start + 1;
  const url = rt.url!;
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (rt.cancelled) throw new Error("__CANCELLED__");
    if (rt.pauseRequested) throw new Error("__PAUSED__");
    const ctrl = new AbortController();
    const abortFn = () => ctrl.abort();
    aborts.add(abortFn);
    let controlAbort = false;
    try {
      const from = seg.start + seg.received;
      const res = await fetch(url, {
        headers: { Range: `bytes=${from}-${seg.end}` },
        signal: ctrl.signal,
      });
      if (res.status === 200) {
        // Server abaikan Range → mode paralel tidak bisa dipakai.
        try {
          await res.body?.cancel();
        } catch {
          /* abaikan */
        }
        throw new Error("__NO_RANGE__");
      }
      if (res.status !== 206) throw new Error(`HTTP ${res.status}`);
      // Pastikan server balas dari offset yang diminta (anti-korupsi rakitan).
      const cr = res.headers.get("content-range");
      const m = cr ? /^bytes (\d+)-(\d+)\/(\d+)$/.exec(cr.trim()) : null;
      if (!m || Number(m[1]) !== from) {
        try {
          await res.body?.cancel();
        } catch {
          /* abaikan */
        }
        throw new Error("Respons Range tidak sesuai permintaan");
      }
      if (!res.body) {
        const buf = await res.arrayBuffer();
        seg.parts.push(new Blob([buf]));
        seg.received = Math.min(segLen, seg.received + buf.byteLength);
        rt.liveLoaded = Math.min(total, sumReceived());
        return;
      }
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.byteLength > 0) {
          seg.parts.push(new Blob([value]));
          seg.received = Math.min(segLen, seg.received + value.byteLength);
          rt.liveLoaded = Math.min(total, sumReceived());
        }
        if (rt.cancelled || rt.pauseRequested) {
          controlAbort = true;
          try {
            ctrl.abort();
          } catch {
            /* abaikan */
          }
          break;
        }
      }
    } catch (e) {
      if (shared.noRange) throw new Error("__NO_RANGE__");
      const msg = e instanceof Error ? e.message : "";
      if (msg === "__NO_RANGE__") {
        shared.noRange = true;
        try {
          rt.abortCurrent();
        } catch {
          /* abaikan */
        }
        throw new Error("__NO_RANGE__");
      }
      if (rt.cancelled) throw new Error("__CANCELLED__");
      if (rt.pauseRequested) throw new Error("__PAUSED__");
      if (msg === "__CANCELLED__" || msg === "__PAUSED__") throw e;
      if (attempt === 3) throw new Error(msg || "Unduhan segmen gagal");
      // error jaringan → retry segmen ini (offset ikut maju otomatis).
    } finally {
      aborts.delete(abortFn);
    }
    if (controlAbort) {
      if (rt.cancelled) throw new Error("__CANCELLED__");
      throw new Error("__PAUSED__");
    }
    if (seg.received >= segLen) return;
    if (attempt < 3) await new Promise((r) => setTimeout(r, 600 * attempt));
  }
  throw new Error("Unduhan segmen gagal");
}

/** Rakit blob akhir (segmen berurut / single-stream) lalu simpan. */
async function finishDownloadBlob(rt: JobRuntime): Promise<void> {
  const segs = rt.segs;
  const blob =
    segs && segs.length > 0
      ? new Blob(segs.flatMap((s) => s.parts))
      : new Blob(rt.parts ?? []);
  if (rt.segTotal && rt.segTotal > 0) rt.liveLoaded = rt.segTotal;
  if (rt.autoSave) saveBlob(blob, downloadNameFromRt(rt));
  rt.onBlob?.(blob);
}

/** Unduh satu stream penuh (dengan resume Range bila ada partial). */
async function runSingleStream(rt: JobRuntime): Promise<void> {
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
      if (rt.pauseRequested) {
        syncLoadedAfterPause(rt);
        throw new Error("__PAUSED__");
      }

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
  if (!hint || hint <= 0) return;
  // Hanya setState bila benar-benar berubah — read() terpanggil sangat sering.
  const st = useTransferStore.getState();
  const job = st.jobs.find((j) => j.id === rt.id);
  if (!job || job.size === hint) return;
  useTransferStore.setState((s) => ({
    jobs: s.jobs.map((j) =>
      j.id === rt.id ? { ...j, size: hint } : j
    ),
  }));
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
