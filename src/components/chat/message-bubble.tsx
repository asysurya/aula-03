"use client";

import { memo, useState } from "react";
import { format } from "date-fns";
import {
  Clock,
  CornerUpLeft,
  Eye,
  Loader2,
  MoreHorizontal,
  Pencil,
  Smile,
  Trash2,
  Copy,
  Check,
} from "lucide-react";
import EmojiPicker, { Theme as EmojiTheme } from "emoji-picker-react";
import { useTheme } from "next-themes";
import { toast } from "sonner";
import { UserAvatar } from "@/components/shared/user-avatar";
import { OnlineDot } from "@/components/shared/online-dot";
import { FileIcon } from "@/components/cloud/file-icon";
import { FilePreview } from "@/components/cloud/file-preview";
import { mimeToIcon, type CloudFileItem } from "@/lib/cloud-format";
import { formatBytes, isImageMime } from "@/lib/file-constants";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@/components/ui/popover";
import type { ChatAttachment, ChatMessage, ChatSender } from "./types";
import { groupReactions } from "./types";
import { MarkdownText } from "./markdown";
import { cn } from "@/lib/utils";

const MAX_EDIT_LENGTH = 4000;

interface MessageBubbleProps {
  message: ChatMessage;
  showHeader: boolean;
  isOwn: boolean;
  onlineIds: Set<string>;
  currentUserId: string;
  canDelete: boolean; // own or admin
  onAvatarClick?: (sender: ChatSender) => void;
  onReply?: (message: ChatMessage) => void;
  onEdit?: (messageId: string, content: string) => Promise<void>;
  onDelete?: (messageId: string) => Promise<void>;
  onReact?: (messageId: string, emoji: string) => Promise<void>;
  onScrollToMessage?: (id: string) => void;
}

// Lampiran pesan — klik = PRATINJAU (dialog, semua tipe: pdf/docx/xlsx/
// gambar/video/audio/teks), bukan memaksa unduh. Tombol unduh tetap ada
// di dalam pratinjau.
function Attachments({ attachments }: { attachments: ChatAttachment[] }) {
  const [previewFile, setPreviewFile] = useState<CloudFileItem | null>(null);
  if (!attachments || attachments.length === 0) return null;

  function toPreviewItem(
    a: ChatAttachment,
    fallbackName: string,
    fallbackOwner: string
  ): CloudFileItem {
    const { file } = a;
    return {
      id: file.id,
      name: file.name,
      size: file.size,
      mimetype: file.mimetype,
      storageKey: file.storageKey,
      cloudAccountId: null,
      createdAt: new Date().toISOString(),
      uploadedBy: "",
      uploader: { id: "", name: fallbackName, username: fallbackOwner },
      visibility: "ALL",
      raw: false,
    };
  }

  return (
    <>
      <div className="flex flex-wrap gap-2 mt-1.5">
        {attachments.map((a) => {
          const { file } = a;
          const url = `/api/storage/${file.storageKey}`;
          const isImg = isImageMime(file.mimetype);
          if (isImg) {
            return (
              <button
                key={a.id}
                type="button"
                onClick={() => setPreviewFile(toPreviewItem(a, file.name, "chat"))}
                className="block group relative rounded-md overflow-hidden border border-border cursor-zoom-in"
                title={`Pratinjau ${file.name}`}
              >
                {/* image thumbnail */}
                <img
                  src={url}
                  alt={file.name}
                  className="h-[140px] w-[140px] object-cover group-hover:opacity-90 transition-opacity"
                />
                <span className="absolute bottom-1 right-1 inline-flex items-center gap-0.5 rounded-full bg-black/70 text-white text-[9px] px-1.5 py-0.5 backdrop-blur-sm">
                  <Clock className="h-2.5 w-2.5" /> 24j
                </span>
              </button>
            );
          }
          return (
            <button
              key={a.id}
              type="button"
              onClick={() => setPreviewFile(toPreviewItem(a, file.name, "chat"))}
              className="flex items-center gap-2 rounded-md border border-border bg-card/60 px-2 py-1.5 max-w-[220px] hover:bg-accent/60 transition-colors text-left"
              title={`Pratinjau ${file.name} (tanpa unduh)`}
            >
              <FileIcon
                name={mimeToIcon(file.mimetype)}
                className="h-5 w-5 shrink-0 text-muted-foreground"
              />
              <div className="min-w-0 flex-1">
                <p className="text-xs font-medium truncate">{file.name}</p>
                <p className="text-[10px] text-muted-foreground flex items-center gap-1">
                  <Clock className="h-2.5 w-2.5" /> 24j · {formatBytes(file.size)}
                </p>
              </div>
              <Eye className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            </button>
          );
        })}
      </div>
      <FilePreview file={previewFile} onClose={() => setPreviewFile(null)} />
    </>
  );
}

function ReactionBar({
  message,
  currentUserId,
  onReact,
}: {
  message: ChatMessage;
  currentUserId: string;
  onReact?: (messageId: string, emoji: string) => Promise<void>;
}) {
  const groups = groupReactions(message.reactions, currentUserId);
  if (groups.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1 mt-1.5">
      {groups.map((g) => (
        <button
          key={g.emoji}
          type="button"
          onClick={() => onReact?.(message.id, g.emoji)}
          className={cn(
            "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] transition-colors",
            g.mine
              ? "border-primary/40 bg-primary/15 text-primary hover:bg-primary/20"
              : "border-border bg-card/60 hover:bg-accent/60"
          )}
          title={g.mine ? "Klik untuk menghapus reaksi" : "Klik untuk bereaksi"}
        >
          <span className="text-xs leading-none">{g.emoji}</span>
          <span className="font-medium tabular-nums">{g.count}</span>
        </button>
      ))}
    </div>
  );
}

function ReplyIndicator({
  message,
  onScrollToMessage,
}: {
  message: ChatMessage;
  onScrollToMessage?: (id: string) => void;
}) {
  const replyTo = message.replyTo;
  if (!replyTo) return null;
  const truncated =
    replyTo.content.length > 80
      ? `${replyTo.content.slice(0, 80)}…`
      : replyTo.content;
  const senderName = replyTo.sender.name;
  return (
    <button
      type="button"
      onClick={() => onScrollToMessage?.(replyTo.id)}
      className="mb-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground hover:text-foreground transition-colors max-w-full"
      title="Klik untuk gulir ke pesan asli"
    >
      <CornerUpLeft className="h-3 w-3 shrink-0" />
      <span className="truncate">
        <span className="font-medium text-primary/90">{senderName}</span>
        <span className="mx-1">·</span>
        <span className="italic">{truncated}</span>
      </span>
    </button>
  );
}

function MessageActions({
  message,
  isOwn,
  canDelete,
  busy,
  onReply,
  onEdit,
  onDelete,
  onReact,
}: {
  message: ChatMessage;
  isOwn: boolean;
  canDelete: boolean;
  busy: boolean;
  onReply?: (message: ChatMessage) => void;
  onEdit?: () => void;
  onDelete?: () => void;
  onReact?: (messageId: string, emoji: string) => Promise<void>;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const { resolvedTheme } = useTheme();
  const emojiTheme: EmojiTheme =
    resolvedTheme === "dark" ? EmojiTheme.DARK : EmojiTheme.LIGHT;

  // Aksi pesan dikumpulkan di SATU tombol titik-tiga (Discord style).
  // Reaksi cepat tampil sebagai baris emoji di dalam menu.
  const quickEmojis = ["👍", "❤️", "😂", "🎉", "🙏", "👀", "🔥"];

  async function copyText() {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
      toast.success("Teks pesan disalin.");
    } catch {
      toast.error("Gagal menyalin teks.");
    }
  }

  return (
    <div
      className={cn(
        "flex items-center shrink-0 self-center",
        "opacity-70 hover:opacity-100 focus-within:opacity-100 transition-opacity"
      )}
    >
      {/* Popover emoji lengkap — terbuka dari menu titik-tiga, jangkar = tombol */}
      <Popover open={emojiOpen} onOpenChange={setEmojiOpen}>
        <PopoverAnchor asChild>
          <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                disabled={busy}
                aria-label="Aksi pesan"
                title="Aksi pesan (balas, reaksi, edit, hapus)"
                className="h-6 w-6 rounded-md border border-border bg-popover shadow-md text-muted-foreground hover:text-foreground hover:bg-accent"
              >
                <MoreHorizontal className="h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              {/* Reaksi cepat */}
              <div className="px-1.5 pt-1.5 pb-1 flex items-center gap-0.5 flex-wrap">
                {quickEmojis.map((e) => (
                  <button
                    key={e}
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      void onReact?.(message.id, e);
                      setMenuOpen(false);
                    }}
                    className="h-7 w-7 rounded-md text-base hover:bg-accent transition-colors disabled:opacity-50"
                    title={`Reaksi ${e}`}
                  >
                    {e}
                  </button>
                ))}
              </div>
              <DropdownMenuItem onSelect={() => onReply?.(message)}>
                <CornerUpLeft className="h-4 w-4" /> Balas
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => {
                  setMenuOpen(false);
                  // Buka popover emoji setelah menu tertutup (hindari konflik layer).
                  setTimeout(() => setEmojiOpen(true), 80);
                }}
              >
                <Smile className="h-4 w-4" /> Reaksi dengan emoji
              </DropdownMenuItem>
              {message.content.length > 0 ? (
                <DropdownMenuItem onSelect={() => void copyText()}>
                  {copied ? (
                    <Check className="h-4 w-4" />
                  ) : (
                    <Copy className="h-4 w-4" />
                  )}{" "}
                  Salin teks
                </DropdownMenuItem>
              ) : null}
              {isOwn ? (
                <DropdownMenuItem onSelect={() => onEdit?.()}>
                  <Pencil className="h-4 w-4" /> Edit
                </DropdownMenuItem>
              ) : null}
              {isOwn || canDelete ? (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onSelect={() => onDelete?.()}
                    className="text-destructive focus:text-destructive"
                  >
                    <Trash2 className="h-4 w-4" /> Hapus
                  </DropdownMenuItem>
                </>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        </PopoverAnchor>

        <PopoverContent
          align="end"
          side="top"
          className="w-auto border-0 bg-transparent p-0 shadow-none z-50"
        >
          <EmojiPicker
            theme={emojiTheme}
            onEmojiClick={(emojiData) => {
              void onReact?.(message.id, emojiData.emoji);
              setEmojiOpen(false);
            }}
            previewConfig={{ showPreview: false }}
            searchPlaceHolder="Cari emoji"
            width={300}
            height={360}
          />
        </PopoverContent>
      </Popover>
    </div>
  );
}

function EditComposer({
  initial,
  onCancel,
  onSave,
}: {
  initial: string;
  onCancel: () => void;
  onSave: (content: string) => Promise<void>;
}) {
  const [value, setValue] = useState(initial);
  const [saving, setSaving] = useState(false);
  const trimmed = value.trim();
  const canSave = !saving && trimmed.length > 0 && trimmed !== initial.trim();

  async function save() {
    if (!canSave) return;
    setSaving(true);
    try {
      await onSave(trimmed);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-1.5 w-full">
      <Textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        rows={Math.min(6, Math.max(1, value.split("\n").length))}
        disabled={saving}
        maxLength={MAX_EDIT_LENGTH}
        className="resize-none min-h-[40px] max-h-40 bg-card w-full rounded-lg"
        onKeyDown={(e) => {
          if (e.key === "Enter" && e.shiftKey) {
            e.preventDefault();
            void save();
          }
          if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
      />
      <div className="flex items-center gap-1.5">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={onCancel}
          disabled={saving}
          className="h-7 px-2 text-xs"
        >
          Batal
        </Button>
        <Button
          type="button"
          size="sm"
          onClick={() => void save()}
          disabled={!canSave}
          className="h-7 px-2 text-xs"
        >
          {saving ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : null}
          Simpan
        </Button>
        <span className="text-[10px] text-muted-foreground ml-1 hidden sm:inline">
          Shift+Enter untuk simpan
        </span>
      </div>
    </div>
  );
}

export const MessageBubble = memo(function MessageBubble({
  message,
  showHeader,
  isOwn,
  onlineIds,
  currentUserId,
  canDelete,
  onAvatarClick,
  onReply,
  onEdit,
  onDelete,
  onReact,
  onScrollToMessage,
}: MessageBubbleProps) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);

  const time = format(new Date(message.createdAt), "HH:mm");
  const editedAt = message.editedAt
    ? format(new Date(message.editedAt), "HH:mm")
    : null;
  const attachments = message.attachments ?? [];
  const hasContent = message.content.length > 0;
  const hasAttachments = attachments.length > 0;

  async function handleEditSave(content: string) {
    if (!onEdit) return;
    setBusy(true);
    try {
      await onEdit(message.id, content);
      setEditing(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Gagal menyimpan");
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete() {
    if (!onDelete) return;
    setBusy(true);
    try {
      await onDelete(message.id);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Gagal menghapus");
      setBusy(false);
    }
    // Do not clear busy: bubble gets unmounted by parent on success.
  }

  async function handleReact(emoji: string) {
    if (!onReact) return;
    try {
      await onReact(message.id, emoji);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Gagal memberi reaksi");
    }
  }

  // ── Discord-style flat message row ──────────────────────────────
  return (
    <div
      id={`msg-${message.id}`}
      className={cn(
        "group relative flex gap-3 px-3 sm:px-4 hover:bg-accent/40",
        showHeader ? "mt-3 pt-1 pb-1" : "pt-0.5 pb-0.5"
      )}
    >
      {/* Avatar column / timestamp gutter */}
      <div className="w-10 shrink-0 select-none">
        {showHeader ? (
          <button
            type="button"
            onClick={() => onAvatarClick?.(message.sender)}
            className="relative rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={`Lihat profil ${message.sender.name}`}
          >
            <UserAvatar
              name={message.sender.name}
              username={message.sender.username}
              avatarUrl={message.sender.avatarUrl}
              size="xs"
            />
            <OnlineDot online={onlineIds.has(message.sender.id)} />
          </button>
        ) : (
          <span className="hidden group-hover:block pt-0.5 text-[10px] text-muted-foreground/70 tabular-nums">
            {time}
          </span>
        )}
      </div>

      {/* Content column */}
      <div className="flex-1 min-w-0">
        {editing ? (
          <EditComposer
            initial={message.content}
            onCancel={() => setEditing(false)}
            onSave={handleEditSave}
          />
        ) : (
          <>
            <ReplyIndicator
              message={message}
              onScrollToMessage={onScrollToMessage}
            />
            {showHeader ? (
              <div className="flex items-baseline gap-2">
                <span
                  className={cn(
                    "text-sm font-semibold truncate",
                    isOwn ? "text-primary" : "text-foreground"
                  )}
                >
                  {message.sender.name}
                </span>
                <span className="text-[11px] text-muted-foreground tabular-nums shrink-0">
                  {format(new Date(message.createdAt), "d MMM HH:mm")}
                </span>
                {editedAt ? (
                  <span className="text-[10px] italic text-muted-foreground/70">
                    (diedit)
                  </span>
                ) : null}
              </div>
            ) : null}
            {hasContent ? <MarkdownText text={message.content} /> : null}
            {hasAttachments ? (
              <div className="rounded-lg border border-border/60 bg-card/40 px-2 py-1.5 mt-1 max-w-full">
                <Attachments attachments={attachments} />
              </div>
            ) : null}
            <ReactionBar
              message={message}
              currentUserId={currentUserId}
              onReact={onReact}
            />
          </>
        )}
      </div>

      {/* Floating hover actions — SATU tombol titik-tiga (Discord style) */}
      {!editing ? (
        <MessageActions
          message={message}
          isOwn={isOwn}
          canDelete={canDelete}
          busy={busy}
          onReply={onReply}
          onEdit={() => setEditing(true)}
          onDelete={handleDelete}
          // PENTING: MessageActions memanggil onReact(messageId, emoji).
          // handleReact di sini hanya menerima (emoji) — bungkus adapter
          // supaya emoji tidak tertukar dengan ID pesan (bug reaksi aneh).
          onReact={(messageId, emoji) => handleReact(emoji)}
        />
      ) : null}
    </div>
  );
});
