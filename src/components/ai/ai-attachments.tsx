"use client";

// ── Lampiran materi untuk SEMUA fitur AI ──────────────────────────────
// Dipakai: Teman AI, Pusat Belajar (Teman Belajar/Buat Materi/Alat
// Materi), AI Builder, dan generator soal tugas. Dua sumber materi:
//   • TEKS  — textarea collapsible ("Materi teks")
//   • FILE  — format APA PUN (PDF/DOCX/XLSX/ZIP/EPUB/teks/…): diupload
//             ke /api/ai/attachments, teksnya di-extract di server.
// Id lampiran dikirim ulang pada request AI (attachmentIds) — konteks
// digabung server-side, tanpa membebani body request AI.

import { useCallback, useRef, useState } from "react";
import { FileText, Loader2, Paperclip, Type, X } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface AiAttachFileMeta {
  id: string;
  name: string;
  kind: string;
  chars: number;
  note?: string;
}

export interface AiAttachmentsState {
  files: AiAttachFileMeta[];
  text: string;
  textOpen: boolean;
  uploading: boolean;
  setText: (v: string) => void;
  setTextOpen: (v: boolean) => void;
  pickFiles: (fl: FileList | null) => Promise<void>;
  removeFile: (id: string) => void;
  clearAll: () => void;
  /** Id lampiran aktif — untuk body request AI (attachmentIds). */
  ids: string[];
  /** Ada materi apa pun (teks / file)? */
  hasAny: boolean;
}

export function useAiAttachments(): AiAttachmentsState {
  const [files, setFiles] = useState<AiAttachFileMeta[]>([]);
  const [text, setText] = useState("");
  const [textOpen, setTextOpen] = useState(false);
  const [uploading, setUploading] = useState(false);

  const pickFiles = useCallback(async (fl: FileList | null) => {
    if (!fl || fl.length === 0) return;
    const list = Array.from(fl);
    setUploading(true);
    const added: AiAttachFileMeta[] = [];
    try {
      for (const f of list) {
        if (f.size > 4 * 1024 * 1024) {
          toast.error(`"${f.name}" terlalu besar (maks 4 MB)`);
          continue;
        }
        const fd = new FormData();
        fd.append("file", f);
        try {
          const res = await fetch("/api/ai/attachments", {
            method: "POST",
            body: fd,
          });
          const json = await res.json().catch(() => null);
          if (!res.ok || !json?.attachment?.id) {
            toast.error(json?.error ?? `Gagal melampirkan "${f.name}"`);
            continue;
          }
          added.push(json.attachment as AiAttachFileMeta);
        } catch {
          toast.error(`Gagal melampirkan "${f.name}" — coba lagi.`);
        }
      }
      if (added.length) {
        setFiles((prev) => [...prev, ...added]);
        const names = added.map((a) => `"${a.name}"`).join(", ");
        toast.success(
          `${added.length} lampiran siap: ${names}`.slice(0, 120),
          {
            description: added
              .map((a) => `${a.kind}${a.chars ? ` · ${a.chars} karakter terbaca` : " · biner"}`)
              .join(" · ")
              .slice(0, 160),
          }
        );
      }
    } finally {
      setUploading(false);
    }
  }, []);

  const removeFile = useCallback((id: string) => {
    setFiles((prev) => prev.filter((f) => f.id !== id));
  }, []);

  const clearAll = useCallback(() => {
    setFiles([]);
    setText("");
    setTextOpen(false);
  }, []);

  return {
    files,
    text,
    textOpen,
    uploading,
    setText,
    setTextOpen,
    pickFiles,
    removeFile,
    clearAll,
    ids: files.map((f) => f.id),
    hasAny: files.length > 0 || text.trim().length > 0,
  };
}

export function AiAttachments({
  att,
  allowText = true,
  label = "Lampirkan materi",
  compact = false,
  className,
}: {
  att: AiAttachmentsState;
  /** Tampilkan tombol materi teks (false bila fitur sudah punya kolom
   *  teks materi sendiri — konteks teks digabungkan lewat sana). */
  allowText?: boolean;
  label?: string;
  compact?: boolean;
  className?: string;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);

  return (
    <div className={cn("w-full", className)} data-ai-attach="1">
      <div className="flex items-center gap-1.5 flex-wrap">
        <input
          ref={inputRef}
          type="file"
          multiple
          className="hidden"
          aria-label="Pilih berkas materi"
          onChange={(e) => {
            void att.pickFiles(e.target.files);
            e.target.value = "";
          }}
        />
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-7 gap-1.5 text-xs"
          disabled={att.uploading}
          onClick={() => inputRef.current?.click()}
          title="Lampirkan materi dari berkas — format apa pun (PDF, DOCX, XLSX, ZIP, teks, …)"
        >
          {att.uploading ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Paperclip className="size-3.5" />
          )}
          {label}
        </Button>
        {allowText ? (
          <Button
            type="button"
            size="sm"
            variant={att.textOpen ? "secondary" : "outline"}
            className="h-7 gap-1.5 text-xs"
            onClick={() => att.setTextOpen(!att.textOpen)}
            title="Tulis materi tambahan sebagai teks"
          >
            <Type className="size-3.5" />
            Materi teks
          </Button>
        ) : null}
        {att.files.length > 0 && !compact ? (
          <span className="text-[11px] text-muted-foreground">
            {att.files.length} lampiran
            {att.text.trim() ? " + teks" : ""}
          </span>
        ) : null}
      </div>

      {att.files.length > 0 ? (
        <ul className="mt-1.5 space-y-1">
          {att.files.map((f) => (
            <li
              key={f.id}
              data-ai-attach-chip={f.name}
              className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-border bg-muted/40 pl-2 pr-1 py-0.5 text-xs"
            >
              <FileText className="size-3.5 shrink-0 text-primary" />
              <span className="truncate max-w-[220px]" title={f.name}>
                {f.name}
              </span>
              <span className="shrink-0 text-muted-foreground">
                {f.kind}
                {f.chars ? ` · ${f.chars.toLocaleString("id-ID")} kr` : ""}
              </span>
              <button
                type="button"
                className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-destructive"
                onClick={() => att.removeFile(f.id)}
                aria-label={`Lepas lampiran ${f.name}`}
              >
                <X className="size-3" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {allowText && att.textOpen ? (
        <textarea
          value={att.text}
          onChange={(e) => att.setText(e.target.value)}
          data-ai-attach-text="1"
          placeholder="Materi tambahan (teks) — tempel catatan, rangkuman, atau bahan apa pun…"
          className="mt-1.5 w-full min-h-[72px] max-h-40 rounded-md border border-border bg-background px-2.5 py-1.5 text-xs outline-none focus:ring-1 focus:ring-ring resize-y"
        />
      ) : null}
    </div>
  );
}
