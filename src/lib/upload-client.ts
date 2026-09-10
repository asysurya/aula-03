// ─────────────────────────────────────────────────────────────────────────
// Smart upload — file kecil langsung (XHR + progress), file besar chunked.
//
// Kenapa chunked: serverless Vercel membatasi request body ± 4.5 MB.
// File lebih besar dipecah jadi chunk ± 4 MB → /api/upload/init + /chunk
// + /complete — lalu server merakit & menjalankan logika upload yang sama.
// Response JSON & status code identik dengan endpoint asli, jadi pemanggil
// tidak perlu tahu jalurnya.
// ─────────────────────────────────────────────────────────────────────────

"use client";

export type SmartUploadKind =
  | "cloud-file"
  | "submission"
  | "mega"
  | "attachment"
  | "avatar"
  | "form-image"
  | "answer-file";

export interface SmartUploadTarget {
  kind: SmartUploadKind;
  /** cloud-file */
  folderId?: string | null;
  classroomId?: string | null;
  visibility?: string | null;
  /** submission */
  assignmentId?: string;
  note?: string | null;
  /** mega */
  parentId?: string | null;
  accountId?: string | null;
  /** attachment */
  convKind?: "classroom" | "group" | "dm";
  convId?: string;
  /** answer-file */
  questionId?: string;
}

export interface UploadProgressInfo {
  phase: "uploading" | "finalizing" | "done";
  /** byte terkirim (fase uploading) */
  loaded: number;
  total: number;
  /** 0-100 */
  percent: number;
}

export interface SmartUploadResult<T = Record<string, unknown>> {
  ok: boolean;
  status: number;
  json: T & { error?: string };
}

// Ambang: di atas ini body multipart masih aman di bawah limit Vercel,
// tapi kita pakai chunked supaya konsisten. 4 MB = zona aman.
const DIRECT_THRESHOLD = 4 * 1024 * 1024;

// POST XHR dengan upload progress (fetch tidak punya progress upload).
function xhrUpload(
  url: string,
  form: FormData,
  onProgress?: (loaded: number, total: number) => void
): Promise<SmartUploadResult> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.responseType = "json";
    if (onProgress) {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress(e.loaded, e.total);
      };
    }
    xhr.onload = () => {
      const json =
        (xhr.response && typeof xhr.response === "object"
          ? xhr.response
          : safeParse(xhr.responseText)) ?? {};
      resolve({ ok: xhr.status >= 200 && xhr.status < 300, status: xhr.status, json });
    };
    xhr.onerror = () => reject(new Error("Kesalahan jaringan saat mengunggah"));
    xhr.ontimeout = () => reject(new Error("Timeout saat mengunggah"));
    xhr.send(form);
  });
}

function safeParse(text: string): Record<string, unknown> | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function postJson(
  url: string,
  body: unknown
): Promise<SmartUploadResult> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) ?? {};
    return { ok: res.ok, status: res.status, json };
  } catch {
    return {
      ok: false,
      status: 0,
      json: { error: "Kesalahan jaringan" },
    };
  }
}

// Endpoint + FormData untuk jalur langsung (file kecil), per target.
function buildDirectRequest(file: File, target: SmartUploadTarget): { url: string; form: FormData } | { error: string } {
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
      if (!target.assignmentId) return { error: "assignmentId wajib" };
      form.append("assignmentId", target.assignmentId);
      if (target.note) form.append("note", target.note);
      return { url: "/api/cloud/submissions", form };
    }
    case "mega": {
      if (target.parentId) form.append("parentId", target.parentId);
      if (target.accountId) form.append("accountId", target.accountId);
      return { url: "/api/cloud/mega/upload", form };
    }
    case "attachment": {
      if (!target.convKind || !target.convId)
        return { error: "convKind & convId wajib" };
      form.append("kind", target.convKind);
      form.append("id", target.convId);
      return { url: "/api/chat/attachments", form };
    }
    case "avatar": {
      return { url: "/api/profile/avatar", form };
    }
    case "form-image": {
      if (!target.folderId) return { error: "folderId wajib" };
      return {
        url: `/api/cloud/assignments/${encodeURIComponent(target.folderId)}/form/image`,
        form,
      };
    }
    case "answer-file": {
      if (!target.folderId || !target.questionId)
        return { error: "folderId & questionId wajib" };
      form.append("questionId", target.questionId);
      return {
        url: `/api/cloud/assignments/${encodeURIComponent(target.folderId)}/form/answer-file`,
        form,
      };
    }
    default:
      return { error: "Jenis upload tidak dikenal" };
  }
}

/** Kirim chunk dengan retry (koneksi lambat/putus sejenak). */
async function sendChunkWithRetry(
  uploadId: string,
  idx: number,
  blob: Blob,
  attempt = 1
): Promise<SmartUploadResult> {
  const form = new FormData();
  form.append("uploadId", uploadId);
  form.append("idx", String(idx));
  form.append("chunk", blob, `chunk-${idx}`);
  const res = await xhrUpload("/api/upload/chunk", form).catch((e) => ({
    ok: false,
    status: 0,
    json: { error: e instanceof Error ? e.message : "Gagal" },
  }));
  if (!res.ok && res.status === 0 && attempt < 3) {
    // Error jaringan murni → tunggu sebentar lalu coba lagi.
    await new Promise((r) => setTimeout(r, 800 * attempt));
    return sendChunkWithRetry(uploadId, idx, blob, attempt + 1);
  }
  return res;
}

export async function uploadSmart<T = Record<string, unknown>>(
  file: File,
  target: SmartUploadTarget,
  opts?: {
    onProgress?: (p: UploadProgressInfo) => void;
    /** Default 4 MB — di atas ini pakai jalur chunked. */
    directThreshold?: number;
  }
): Promise<SmartUploadResult<T>> {
  const report = (p: UploadProgressInfo) => opts?.onProgress?.(p);
  const threshold = opts?.directThreshold ?? DIRECT_THRESHOLD;

  // ── Jalur 1: file kecil → POST langsung ke endpoint asli ──
  if (file.size <= threshold) {
    const req = buildDirectRequest(file, target);
    if ("error" in req) {
      return { ok: false, status: 400, json: { error: req.error } as never };
    }
    report({ phase: "uploading", loaded: 0, total: file.size, percent: 0 });
    const onProgress = (loaded: number, total: number) => {
      const percent = total > 0 ? Math.round((loaded / total) * 95) : 0;
      report({ phase: "uploading", loaded, total, percent });
    };
    // Retry sekali kalau error jaringan murni (koneksi terputus sejenak) —
    // sama seperti perilaku jalur chunked.
    let lastError: unknown;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const res = await xhrUpload(req.url, req.form, onProgress);
        report({
          phase: "done",
          loaded: file.size,
          total: file.size,
          percent: 100,
        });
        return res as SmartUploadResult<T>;
      } catch (e) {
        lastError = e;
        if (attempt < 2) await new Promise((r) => setTimeout(r, 1200));
      }
    }
    return {
      ok: false,
      status: 0,
      json: {
        error:
          lastError instanceof Error
            ? lastError.message
            : "Gagal mengunggah",
      } as never,
    };
  }

  // ── Jalur 2: file besar → chunked via staging MongoDB ──
  report({ phase: "uploading", loaded: 0, total: file.size, percent: 0 });

  const init = await postJson("/api/upload/init", {
    name: file.name,
    size: file.size,
    mimetype: file.type || "application/octet-stream",
  });
  if (!init.ok) {
    return init as SmartUploadResult<T>;
  }
  const { uploadId, chunkSize, chunkCount } = init.json as {
    uploadId: string;
    chunkSize: number;
    chunkCount: number;
  };

  let sent = 0;
  for (let i = 0; i < chunkCount; i++) {
    const start = i * chunkSize;
    const end = Math.min(file.size, start + chunkSize);
    const blob = file.slice(start, end);
    const res = await sendChunkWithRetry(uploadId, i, blob);
    if (!res.ok) {
      return res as SmartUploadResult<T>;
    }
    sent = end;
    const percent = Math.min(95, Math.round((sent / file.size) * 95));
    report({ phase: "uploading", loaded: sent, total: file.size, percent });
  }

  report({ phase: "finalizing", loaded: sent, total: file.size, percent: 96 });

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

  report({ phase: "done", loaded: file.size, total: file.size, percent: 100 });
  return complete as SmartUploadResult<T>;
}
