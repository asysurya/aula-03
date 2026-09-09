"use client";

import { useRef, useState } from "react";
import { toast } from "sonner";
import { UploadCloud, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MAX_FILE_SIZE_MB } from "@/lib/constants";

const MAX_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;

// Drag-and-drop file upload with a hidden input fallback.
// Calls onUploaded(fileId) on success. Optional `folderId` for target folder.
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
    try {
      const fd = new FormData();
      fd.append("file", file);
      if (folderId) fd.append("folderId", folderId);
      else if (classroomId) fd.append("classroomId", classroomId);
      const res = await fetch("/api/cloud/files", {
        method: "POST",
        body: fd,
      });
      const json = await res.json();
      if (!res.ok) {
        const msg =
          (json && (json.error as string)) || `Gagal unggah (${res.status})`;
        toast.error(msg);
        return;
      }
      toast.success(`"${file.name}" terunggah.`);
      onUploaded?.(json.file.id as string);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Kesalahan jaringan";
      toast.error(msg);
    } finally {
      setUploading(false);
    }
  }

  function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    // Sequential upload (simple, predictable).
    Array.from(files).forEach(uploadFile);
  }

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
          {uploading ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <UploadCloud className="size-4" />
          )}
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
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        ) : (
          <UploadCloud className="size-6 text-muted-foreground group-hover:text-primary transition-colors" />
        )}
        <p className="text-sm font-medium">
          {uploading ? "Mengunggah…" : "Tarik file ke sini atau klik untuk pilih"}
        </p>
        <p className="text-xs text-muted-foreground">
          Maksimal {MAX_FILE_SIZE_MB} MB per file.
        </p>
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
