"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Paperclip, Send, Smile, X, UploadCloud } from "lucide-react";
import { toast } from "sonner";
import EmojiPicker, { Theme as EmojiTheme } from "emoji-picker-react";
import { useTheme } from "next-themes";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { FileIcon } from "@/components/cloud/file-icon";
import { mimeToIcon } from "@/lib/cloud-format";
import { uploadSmart } from "@/lib/upload-client";
import {
  ALLOWED_MIMES,
  formatBytes,
  isImageMime,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_FILE_SIZE,
} from "@/lib/file-constants";
import type { ChatMessage } from "./types";

export interface PendingAttachment {
  fileId: string;
  name: string;
  size: number;
  mimetype: string;
  storageKey: string;
}

interface MessageInputProps {
  onSend: (content: string, attachmentFileIds: string[]) => Promise<void>;
  placeholder?: string;
  disabled?: boolean;
  // Conversation context used to upload attachments.
  conversation: { kind: "classroom" | "group" | "dm"; id: string };
  // Reply target (Discord-style reply composer bar).
  replyTo?: ChatMessage | null;
  onCancelReply?: () => void;
}

interface UploadingState {
  id: string; // local id for tracking
  name: string;
  size: number;
  mimetype: string;
  previewUrl?: string;
  error?: string;
  result?: PendingAttachment;
}

export function MessageInput({
  onSend,
  placeholder = "Tulis pesan…",
  disabled,
  conversation,
  replyTo,
  onCancelReply,
}: MessageInputProps) {
  const { resolvedTheme } = useTheme();
  const emojiTheme: EmojiTheme =
    resolvedTheme === "dark" ? EmojiTheme.DARK : EmojiTheme.LIGHT;

  const [value, setValue] = useState("");
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState<UploadingState[]>([]);
  const [pending, setPending] = useState<PendingAttachment[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const dragDepth = useRef(0);
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Auto-grow textarea up to a max height.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "0px";
    const next = Math.min(el.scrollHeight, 160);
    el.style.height = `${next}px`;
  }, [value]);

  const trimmed = value.trim();
  const isUploadingAny = uploading.length > 0;
  const canSend =
    !sending &&
    !disabled &&
    !isUploadingAny &&
    (trimmed.length > 0 || pending.length > 0);

  function pickFiles() {
    fileInputRef.current?.click();
  }

  async function handleFilesSelected(files: FileList | null) {
    if (!files || files.length === 0) return;
    // Reset input so the same file can be re-picked later.
    if (fileInputRef.current) fileInputRef.current.value = "";

    const room = MAX_ATTACHMENTS_PER_MESSAGE - pending.length - uploading.length;
    if (room <= 0) {
      toast.error(`Maks ${MAX_ATTACHMENTS_PER_MESSAGE} lampiran per pesan`);
      return;
    }

    const toAdd: File[] = [];
    for (let i = 0; i < files.length && toAdd.length < room; i++) {
      const f = files[i];
      if (!f) continue;
      // Client-side validation.
      if (f.size === 0) {
        toast.error(`File "${f.name}" kosong`);
        continue;
      }
      if (f.size > MAX_FILE_SIZE) {
        toast.error(
          `File "${f.name}" melebihi ${Math.round(MAX_FILE_SIZE / 1024 / 1024)}MB`
        );
        continue;
      }
      const mt = f.type || "application/octet-stream";
      if (!ALLOWED_MIMES.has(mt)) {
        toast.error(`Tipe file "${f.name}" tidak didukung`);
        continue;
      }
      toAdd.push(f);
    }
    if (toAdd.length === 0) return;

    // Stage as uploading.
    const staged: UploadingState[] = toAdd.map((f) => ({
      id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      name: f.name,
      size: f.size,
      mimetype: f.type || "application/octet-stream",
      previewUrl: isImageMime(f.type || "") ? URL.createObjectURL(f) : undefined,
    }));
    setUploading((prev) => [...prev, ...staged]);

    // Upload each in parallel (file besar otomatis chunked + progress).
    await Promise.all(
      staged.map(async (s, idx) => {
        const f = toAdd[idx];
        try {
          const res = await uploadSmart<{
            fileId?: string;
            name?: string;
            size?: number;
            mimetype?: string;
            storageKey?: string;
            error?: string;
          }>(f, {
            kind: "attachment",
            convKind: conversation.kind as "classroom" | "group" | "dm",
            convId: conversation.id,
          });
          const data = res.json;
          if (!res.ok || !data?.fileId) {
            throw new Error(data?.error || `Upload gagal (${res.status})`);
          }
          const result: PendingAttachment = {
            fileId: data.fileId,
            name: data.name as string,
            size: data.size as number,
            mimetype: data.mimetype as string,
            storageKey: data.storageKey as string,
          };
          setPending((prev) => [...prev, result]);
          setUploading((prev) =>
            prev.map((u) => (u.id === s.id ? { ...u, result } : u))
          );
        } catch (e) {
          const msg = e instanceof Error ? e.message : "Upload gagal";
          setUploading((prev) =>
            prev.map((u) => (u.id === s.id ? { ...u, error: msg } : u))
          );
          toast.error(`Gagal upload "${f.name}": ${msg}`);
        }
      })
    );

    // Remove completed (success or error) from the uploading list.
    setUploading((prev) => prev.filter((u) => !u.result && !u.error));
  }

  function removePending(fileId: string) {
    setPending((prev) => prev.filter((p) => p.fileId !== fileId));
  }

  function dismissUploading(id: string) {
    setUploading((prev) => prev.filter((u) => u.id !== id));
  }

  // ── Drag & drop (Discord-style) ──
  const onDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (disabled) return;
    // Only handle file drags
    if (!e.dataTransfer.types.includes("Files")) return;
    dragDepth.current += 1;
    setIsDragging(true);
  }, [disabled]);

  const onDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragDepth.current -= 1;
    if (dragDepth.current <= 0) {
      dragDepth.current = 0;
      setIsDragging(false);
    }
  }, []);

  const onDragOver = useCallback((e: React.DragEvent) => {
    // Must call preventDefault to allow drop.
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragDepth.current = 0;
    setIsDragging(false);
    if (disabled) return;
    const files = e.dataTransfer.files;
    if (files && files.length > 0) {
      void handleFilesSelected(files);
    }
  }, [disabled]);

  // Insert emoji at cursor position (or append to end).
  function insertEmoji(emoji: string) {
    const el = ref.current;
    if (!el) {
      setValue((v) => v + emoji);
      return;
    }
    const start = el.selectionStart ?? value.length;
    const end = el.selectionEnd ?? value.length;
    const next = value.slice(0, start) + emoji + value.slice(end);
    setValue(next);
    // Restore cursor after emoji.
    requestAnimationFrame(() => {
      el.focus();
      const pos = start + emoji.length;
      el.setSelectionRange(pos, pos);
    });
  }

  async function submit() {
    if (!canSend) return;
    const content = trimmed;
    const attachmentFileIds = pending.map((p) => p.fileId);
    setValue("");
    setSending(true);
    try {
      await onSend(content, attachmentFileIds);
      // On success: clear pending attachments + reply target.
      setPending([]);
      onCancelReply?.();
    } finally {
      setSending(false);
      // refocus for fast typing
      requestAnimationFrame(() => ref.current?.focus());
    }
  }

  // Shift+Enter to send; plain Enter = newline (default behavior).
  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && e.shiftKey) {
      e.preventDefault();
      void submit();
      return;
    }
    if (e.key === "Escape" && replyTo) {
      e.preventDefault();
      onCancelReply?.();
    }
  }

  const showPreviews = pending.length > 0 || uploading.length > 0;
  const replyName = replyTo?.sender?.name ?? replyTo?.sender?.username ?? "";
  const replySnippet =
    replyTo && replyTo.content.length > 60
      ? `${replyTo.content.slice(0, 60)}…`
      : replyTo?.content ?? "";

  return (
    <div
      className="relative border-t border-border bg-background p-3 sm:p-4"
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      {/* Drag-and-drop overlay (Discord-style) */}
      {isDragging ? (
        <div className="absolute inset-2 z-10 rounded-lg border-2 border-dashed border-primary bg-primary/5 flex items-center justify-center pointer-events-none">
          <div className="flex flex-col items-center gap-2 text-primary">
            <UploadCloud className="h-10 w-10" />
            <p className="font-medium text-sm">Lepaskan file untuk melampirkan</p>
            <p className="text-xs text-muted-foreground">Maks {MAX_ATTACHMENTS_PER_MESSAGE} file · {Math.round(MAX_FILE_SIZE / 1024 / 1024)}MB per file</p>
          </div>
        </div>
      ) : null}

      {/* Reply composer bar (Discord-style) */}
      {replyTo ? (
        <div className="flex items-center gap-2 mb-2 rounded-md border border-border bg-muted/40 px-2 py-1.5 text-xs">
          <span className="font-medium text-foreground/80 truncate">
            Membalas {replyName}:
          </span>
          <span className="italic text-muted-foreground truncate flex-1">
            {replySnippet}
          </span>
          <button
            type="button"
            onClick={onCancelReply}
            className="shrink-0 rounded-full p-0.5 hover:bg-muted text-muted-foreground"
            aria-label="Batal balas"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ) : null}

      {/* Pending / uploading attachments preview */}
      {showPreviews ? (
        <div className="flex flex-wrap gap-2 mb-2 max-h-32 overflow-y-auto">
          {uploading.map((u) => (
            <div
              key={u.id}
              className="relative flex items-center gap-2 rounded-md border border-border bg-card px-2 py-1.5 pr-7 max-w-[200px]"
            >
              {u.previewUrl ? (
                <img
                  src={u.previewUrl}
                  alt={u.name}
                  className="h-8 w-8 rounded object-cover shrink-0"
                />
              ) : (
                <FileIcon
                  name={mimeToIcon(u.mimetype)}
                  className="h-4 w-4 shrink-0 text-muted-foreground"
                />
              )}
              <div className="min-w-0 flex-1">
                <p className="text-xs font-medium truncate">{u.name}</p>
                <p className="text-[10px] text-muted-foreground flex items-center gap-1">
                  <Loader2 className="h-2.5 w-2.5 animate-spin" /> Mengunggah…
                </p>
              </div>
              <button
                type="button"
                onClick={() => dismissUploading(u.id)}
                className="absolute right-1 top-1 rounded-full p-0.5 hover:bg-muted text-muted-foreground"
                aria-label="Batalkan upload"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
          {pending.map((p) => (
            <div
              key={p.fileId}
              className="relative flex items-center gap-2 rounded-md border border-emerald-500/40 bg-emerald-500/5 px-2 py-1.5 pr-7 max-w-[200px]"
            >
              {isImageMime(p.mimetype) ? (
                <img
                  src={`/api/storage/${p.storageKey}`}
                  alt={p.name}
                  className="h-8 w-8 rounded object-cover shrink-0"
                />
              ) : (
                <FileIcon
                  name={mimeToIcon(p.mimetype)}
                  className="h-4 w-4 shrink-0 text-muted-foreground"
                />
              )}
              <div className="min-w-0 flex-1">
                <p className="text-xs font-medium truncate">{p.name}</p>
                <p className="text-[10px] text-muted-foreground">
                  {formatBytes(p.size)}
                </p>
              </div>
              <button
                type="button"
                onClick={() => removePending(p.fileId)}
                className="absolute right-1 top-1 rounded-full p-0.5 hover:bg-muted text-muted-foreground"
                aria-label="Hapus lampiran"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      ) : null}

      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          void handleFilesSelected(e.target.files);
        }}
        accept={Array.from(ALLOWED_MIMES).join(",")}
      />
      <div className="flex items-end gap-2">
        <Textarea
          ref={ref}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKeyDown}
          rows={1}
          placeholder={placeholder}
          disabled={disabled}
          className="resize-none min-h-[40px] max-h-40 bg-card"
          aria-label="Pesan"
        />
        <Popover open={emojiOpen} onOpenChange={setEmojiOpen}>
          <PopoverTrigger asChild>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              disabled={disabled}
              aria-label="Pilih emoji"
              title="Pilih emoji"
              className="h-10 w-10 shrink-0 rounded-full"
            >
              <Smile className="h-5 w-5" />
            </Button>
          </PopoverTrigger>
          <PopoverContent
            align="end"
            side="top"
            className="w-auto border-0 bg-transparent p-0 shadow-none"
          >
            <EmojiPicker
              theme={emojiTheme}
              onEmojiClick={(emojiData) => {
                insertEmoji(emojiData.emoji);
              }}
              previewConfig={{ showPreview: false }}
              searchPlaceHolder="Cari emoji"
              width={320}
              height={380}
            />
          </PopoverContent>
        </Popover>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          onClick={pickFiles}
          disabled={disabled || isUploadingAny}
          aria-label="Lampirkan file"
          title="Lampirkan file (maks 5, otomatis dihapus setelah 24 jam)"
          className="h-10 w-10 shrink-0 rounded-full"
        >
          <Paperclip className="h-4 w-4" />
        </Button>
        <Button
          type="button"
          size="icon"
          onClick={() => void submit()}
          disabled={!canSend}
          aria-label="Kirim"
          className="h-10 w-10 shrink-0 rounded-full"
        >
          {sending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Send className="h-4 w-4" />
          )}
        </Button>
      </div>
      <p className="text-[10px] text-muted-foreground mt-1 px-1 hidden sm:block">
        Shift+Enter untuk kirim · Enter untuk baris baru · Lampiran dihapus otomatis 24 jam
      </p>
    </div>
  );
}
