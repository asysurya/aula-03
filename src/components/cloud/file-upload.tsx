"use client";

import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { ArrowUpDown, UploadCloud } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MAX_FILE_SIZE_MB } from "@/lib/constants";
import { useTransferStore } from "@/lib/transfer-store";
import { formatBytes } from "@/lib/cloud-format";

const MAX_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;

// Drag-and-drop file upload with a hidden input fallback.
// Upload BERJALAN DI LATAR BELAKANG lewat Manajer Transfer (pause/resume/
// cancel/antrean + progress yang di-update tiap 2 detik) — UI tidak
// terblokir; file baru muncul di daftar setelah selesai (invalidate query).
export function FileUpload({
  folderId,
  classroomId,
  onUploaded,
  compact = false,
}: {
  folderId?: string | null;
  classroomId?: string | null;
  onUploaded?: (fileId: string) => void;
  compact?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const enqueueUpload = useTransferStore((s) => s.enqueueUpload);
  const jobs = useTransferStore((s) => s.jobs);
  // Filter di luar selector supaya referensi stabil (anti re-render loop).
  const myActive = useMemo(
    () =>
      jobs.filter(
        (j) =>
          j.kind === "upload" &&
          (j.status === "active" ||
            j.status === "queued" ||
            j.status === "paused")
      ),
    [jobs]
  );

  function uploadFile(file: File) {
    if (file.size === 0) {
      toast.error("File kosong.");
      return;
    }
    if (file.size > MAX_BYTES) {
      toast.error(
        `Ukuran file ${MAX_FILE_SIZE_MB} MB maksimal. File kamu terlalu besar.`
      );
      return;
    }
    enqueueUpload({
      file,
      target: {
        kind: "cloud-file",
        folderId: folderId ?? null,
        classroomId: classroomId ?? null,
      },
      context: folderId ? "Folder Cloud" : "Cloud (root)",
      onDoneFile: (fileId) => {
        if (fileId) onUploaded?.(fileId);
      },
      onFileOps: () => onUploaded?.(""),
    });
    toast.info(`"${file.name}" diunggah di latar belakang — pantau di tombol Transfer.`);
  }

  function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    Array.from(files).forEach(uploadFile);
    if (inputRef.current) inputRef.current.value = "";
  }

  if (compact) {
    return (
      <>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => inputRef.current?.click()}
          title={
            myActive.length > 0
              ? `${myActive.length} upload berjalan di latar belakang`
              : "Unggah file (berjalan di latar belakang)"
          }
        >
          <UploadCloud className="size-4" />
          Unggah
        </Button>
        <input
          ref={inputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            handleFiles(e.target.files);
          }}
        />
      </>
    );
  }

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        handleFiles(e.dataTransfer.files);
      }}
      onClick={() => inputRef.current?.click()}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          inputRef.current?.click();
        }
      }}
      className={`group cursor-pointer rounded-lg border-2 border-dashed transition-colors px-4 py-6 text-center ${
        dragging
          ? "border-primary bg-accent/40"
          : "border-border hover:border-primary/50 hover:bg-accent/30"
      }`}
    >
      <div className="flex flex-col items-center gap-1.5">
        {myActive.length > 0 ? (
          <>
            <div className="flex items-center gap-2 text-primary">
              <ArrowUpDown className="size-5 animate-pulse" />
              <p className="text-sm font-medium">
                {myActive.length} upload berjalan di latar belakang
              </p>
            </div>
            <p className="text-xs text-muted-foreground">
              {myActive
                .slice(0, 2)
                .map(
                  (j) =>
                    `${j.name} · ${
                      j.size > 0
                        ? `${Math.min(100, Math.round((j.loaded / j.size) * 100))}%`
                        : formatBytes(j.loaded)
                    }`
                )
                .join(" · ")}
              {myActive.length > 2 ? ` · +${myActive.length - 2} lainnya` : ""}
            </p>
            <p className="text-[11px] text-muted-foreground mt-1">
              Kamu bisa terus menjelajah — pantau & atur lewat tombol Transfer
              di atas. Tarik file lagi untuk menambah antrean.
            </p>
          </>
        ) : (
          <>
            <UploadCloud className="size-6 text-muted-foreground group-hover:text-primary transition-colors" />
            <p className="text-sm font-medium">
              Tarik file ke sini atau klik untuk pilih
            </p>
            <p className="text-xs text-muted-foreground">
              Maksimal {MAX_FILE_SIZE_MB} MB per file · berjalan di latar
              belakang.
            </p>
          </>
        )}
      </div>
      <input
        ref={inputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          handleFiles(e.target.files);
        }}
      />
    </div>
  );
}
