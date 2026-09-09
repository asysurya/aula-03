"use client";

import { useRef, useState } from "react";
import { toast } from "sonner";
import { UploadCloud } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { MAX_FILE_SIZE_MB } from "@/lib/constants";
import { uploadSmart, type UploadProgressInfo } from "@/lib/upload-client";
import { formatBytes } from "@/lib/cloud-format";

const MAX_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;

// Drag-and-drop file upload with a hidden input fallback.
// Calls onUploaded(fileId) on success. Optional `folderId` for target folder.
// File besar (> 4 MB) otomatis dipecah jadi chunk supaya lolos batas
// body serverless Vercel — dengan progress bar.
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
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState<UploadProgressInfo | null>(null);

  async function uploadFile(file: File) {
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
    setUploading(true);
    setProgress({ phase: "uploading", loaded: 0, total: file.size, percent: 0 });
    try {
      const res = await uploadSmart<
        { file?: { id: string }; error?: string } & Record<string, unknown>
      >(
        file,
        {
          kind: "cloud-file",
          folderId: folderId ?? null,
          classroomId: classroomId ?? null,
        },
        { onProgress: setProgress }
      );
      if (!res.ok) {
        toast.error(res.json.error || `Gagal unggah (${res.status})`);
        return;
      }
      toast.success(`"${file.name}" terunggah.`);
      onUploaded?.((res.json.file?.id as string) ?? "");
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Kesalahan jaringan";
      toast.error(msg);
    } finally {
      setUploading(false);
      setProgress(null);
    }
  }

  function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    // Sequential upload (simple, predictable).
    Array.from(files).forEach(uploadFile);
  }

  const progressLabel =
    progress?.phase === "finalizing"
      ? "Menyelesaikan upload…"
      : progress
        ? `Mengunggah… ${formatBytes(progress.loaded)} / ${formatBytes(progress.total)}`
        : "Mengunggah…";

  if (compact) {
    return (
      <>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={uploading}
          onClick={() => inputRef.current?.click()}
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
            e.target.value = "";
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
      onClick={() => !uploading && inputRef.current?.click()}
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
        {uploading ? (
          <>
            <UploadCloud className="size-6 animate-pulse text-muted-foreground" />
            <p className="text-sm font-medium">{progressLabel}</p>
            {progress ? (
              <div className="w-56 max-w-full">
                <Progress value={progress.percent} className="h-1.5" />
              </div>
            ) : null}
          </>
        ) : (
          <>
            <UploadCloud className="size-6 text-muted-foreground group-hover:text-primary transition-colors" />
            <p className="text-sm font-medium">
              Tarik file ke sini atau klik untuk pilih
            </p>
            <p className="text-xs text-muted-foreground">
              Maksimal {MAX_FILE_SIZE_MB} MB per file.
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
          e.target.value = "";
        }}
      />
    </div>
  );
}
