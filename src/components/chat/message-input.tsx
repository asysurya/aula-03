"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BarChart3,
  ClipboardList,
  Eye,
  EyeOff,
  Loader2,
  Paperclip,
  Send,
  Smile,
  X,
  UploadCloud,
} from "lucide-react";
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
import {
  formatBytes,
  isImageMime,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_FILE_SIZE,
  resolveMime,
} from "@/lib/file-constants";
import { mimeToIcon } from "@/lib/cloud-format";
import { uploadSmart } from "@/lib/upload-client";
import { UserAvatar } from "@/components/shared/user-avatar";
import { MarkdownText } from "./markdown";
import {
  AttachmentPicker,
  type CloudPickerFile,
} from "./attachment-picker";
import { VoiceRecorder } from "./voice-recorder";
import { PollComposer } from "./poll-composer";
import { AssignmentAttachDialog } from "./assignment-attach-dialog";
import type { AssignmentCard, ChatMessage } from "./types";
import { cn } from "@/lib/utils";

export interface PendingAttachment {
  fileId: string;
  name: string;
  size: number;
  mimetype: string;
  storageKey: string;
}

interface MessageInputProps {
  // Mengembalikan id pesan nyata (untuk auto-react polling) atau null.
  onSend: (
    content: string,
    attachmentFileIds: string[],
    assignmentId?: string | null
  ) => Promise<string | null>;
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

// ── Slash command (Discord-style) ──────────────────────────────────

const SLASH_COMMANDS: { cmd: string; label: string; insert: string }[] = [
  {
    cmd: "/shrug",
    label: "Tambah ¯\\_(ツ)_/¯ di akhir pesan",
    insert: "¯\\_(ツ)_/¯",
  },
  { cmd: "/tableflip", label: "(╯°□°)╯︵ ┻━┻", insert: "(╯°□°)╯︵ ┻━┻" },
  { cmd: "/me", label: "Aksi / narasi italic — /me sedang belajar", insert: "_sedang belajar_" },
  { cmd: "/spoiler", label: "Spoiler ||teks tersembunyi||", insert: "||teks tersembunyi||" },
  { cmd: "/bold", label: "**teks tebal**", insert: "**teks tebal**" },
  { cmd: "/code", label: "Blok kode```…```", insert: "```\nkode di sini\n```" },
];

function applySlashCommand(value: string, insert: string): string {
  // Ganti kata pertama (/xxx) dengan template command.
  const idx = value.indexOf("/");
  if (idx === -1) return value;
  const before = value.slice(0, idx);
  const after = value.slice(idx);
  const firstWordEnd = after.indexOf(" ");
  const rest =
    firstWordEnd === -1 ? "" : after.slice(firstWordEnd + 1);
  return `${before}${insert}${rest ? ` ${rest}` : ""}`;
}

// ── @mention — tag user (autocomplete + highlight) ──────────────────

interface MentionUser {
  id: string;
  name: string;
  username: string;
  avatarUrl: string | null;
}

const MENTION_MAX_RESULTS = 8;

/**
 * Deteksi token @mention tepat sebelum kursor: "@" di awal teks atau
 * didahului spasi, diikuti 0..N karakter username. Email
 * ("user@domain") tidak memicu karena "@" tidak di awal/didahului
 * spasi. Return posisi "@" (start) + query yang sudah diketik.
 */
function detectMentionToken(
  text: string,
  caret: number
): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const m = /(?:^|\s)@([a-zA-Z0-9_.]*)$/.exec(before);
  if (!m) return null;
  return { start: caret - m[1].length - 1, query: m[1] };
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
  const [pickerOpen, setPickerOpen] = useState(false);
  const [previewMd, setPreviewMd] = useState(false);
  const [slashIndex, setSlashIndex] = useState(0);
  // Tugas yang dilampirkan (kartu tugas) + polling.
  const [pendingAssignment, setPendingAssignment] =
    useState<AssignmentCard | null>(null);
  const [assignmentOpen, setAssignmentOpen] = useState(false);
  const [pollOpen, setPollOpen] = useState(false);
  // ── @mention (tag user) ── token aktif sebelum kursor + daftar anggota.
  const [mention, setMention] = useState<{ start: number; query: string } | null>(
    null
  );
  const [mentionIndex, setMentionIndex] = useState(0);
  const [mentionUsers, setMentionUsers] = useState<MentionUser[] | null>(null);
  // Ambil daftar anggota SEKALI saat popup pertama dibuka (cache memori
  // selama komponen hidup; gagal fetch → boleh dicoba lagi nanti).
  const mentionFetchStarted = useRef(false);
  // Timer tutup-popup saat blur (beri kesempatan klik item di mobile).
  const mentionCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Throttle kirim sinyal "sedang menulis".
  const lastTypingSentRef = useRef(0);
  const dragDepth = useRef(0);
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Draft otomatis — pesan yang belum terkirim tersimpan per conversation,
  // aman saat pindah channel / refresh (localStorage).
  const draftKey = `chat-draft-${conversation.kind}-${conversation.id}`;
  useEffect(() => {
    try {
      const saved = localStorage.getItem(draftKey);
      if (saved) setValue(saved);
    } catch {
      /* abaikan */
    }
    // Pindah conversation — tutup popup mention dari teks lama.
    setMention(null);
  }, [draftKey]);
  useEffect(() => {
    try {
      if (value) localStorage.setItem(draftKey, value);
      else localStorage.removeItem(draftKey);
    } catch {
      /* abaikan */
    }
  }, [value, draftKey]);

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
    (trimmed.length > 0 || pending.length > 0 || !!pendingAssignment);

  // ── Sinyal "sedang menulis" ── kirim maks 1× tiap 2,5 dtk saat
  // pengguna aktif mengetik (server menyimpannya 5 dtk).
  useEffect(() => {
    if (!trimmed || disabled) return;
    const now = Date.now();
    if (now - lastTypingSentRef.current < 2500) return;
    lastTypingSentRef.current = now;
    fetch("/api/chat/typing", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: conversation.kind,
        id: conversation.id,
      }),
    }).catch(() => {});
  }, [value, trimmed, disabled, conversation.kind, conversation.id]);

  // Deteksi slash command di awal kata pertama.
  const slashMatches = useMemo(() => {
    if (!value.startsWith("/")) return [];
    const word = value.split(/\s/)[0]?.toLowerCase() ?? "";
    if (!word || word === "/") return SLASH_COMMANDS;
    return SLASH_COMMANDS.filter((c) => c.cmd.startsWith(word));
  }, [value]);

  useEffect(() => {
    setSlashIndex(0);
  }, [slashMatches.length]);

  // ── @mention: ambil daftar anggota sekali saat popup pertama dibuka ──
  const fetchMentionUsers = useCallback(() => {
    if (mentionFetchStarted.current) return;
    mentionFetchStarted.current = true;
    fetch("/api/users", { cache: "no-store" })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((d: { users?: MentionUser[] }) => {
        setMentionUsers(
          (d.users ?? []).map((u) => ({
            id: String(u.id),
            name: String(u.name ?? ""),
            username: String(u.username ?? ""),
            avatarUrl: u.avatarUrl ?? null,
          }))
        );
      })
      .catch(() => {
        // Gagal ambil — izinkan percobaan ulang saat popup dibuka lagi.
        mentionFetchStarted.current = false;
      });
  }, []);

  // Filter anggota: username/nama dimulai dengan query diprioritaskan,
  // lalu yang hanya "mengandung" query (case-insensitive). Maks 8 hasil.
  const mentionItems = useMemo<MentionUser[]>(() => {
    if (mention === null || mentionUsers === null) return [];
    const q = mention.query.toLowerCase();
    if (!q) return mentionUsers.slice(0, MENTION_MAX_RESULTS);
    const starts: MentionUser[] = [];
    const contains: MentionUser[] = [];
    for (const u of mentionUsers) {
      const name = u.name.toLowerCase();
      const username = u.username.toLowerCase();
      if (username.startsWith(q) || name.startsWith(q)) starts.push(u);
      else if (username.includes(q) || name.includes(q)) contains.push(u);
    }
    return [...starts, ...contains].slice(0, MENTION_MAX_RESULTS);
  }, [mention, mentionUsers]);

  // Indeks aktif di-reset setiap query berubah (atau popup ditutup).
  useEffect(() => {
    setMentionIndex(0);
  }, [mention?.start, mention?.query]);

  // Bersihkan timer blur saat komponen dilepas.
  useEffect(() => {
    return () => {
      if (mentionCloseTimer.current) clearTimeout(mentionCloseTimer.current);
    };
  }, []);

  const mentionActive = Math.min(
    mentionIndex,
    Math.max(0, mentionItems.length - 1)
  );

  /** Perbarui/deteksi token @mention dari teks + posisi kursor. */
  function updateMentionState(text: string, caret: number) {
    const token = detectMentionToken(text, caret);
    if (!token) {
      setMention(null);
      return;
    }
    if (mentionUsers === null) fetchMentionUsers();
    setMention((prev) =>
      prev && prev.start === token.start && prev.query === token.query
        ? prev
        : token
    );
  }

  /** Ganti token "@query" dengan "@username " pada posisi kursor. */
  function applyMention(user: MentionUser) {
    cancelMentionClose();
    const el = ref.current;
    const token = mention;
    setMention(null);
    if (!el || !token) return;
    const caret = el.selectionStart ?? value.length;
    const before = value.slice(0, token.start);
    const after = value.slice(
      Math.max(caret, token.start + 1 + token.query.length)
    );
    const insert = `@${user.username} `;
    setValue(before + insert + after);
    requestAnimationFrame(() => {
      el.focus();
      const pos = before.length + insert.length;
      el.setSelectionRange(pos, pos);
    });
  }

  /** Tutup popup sedikit tertunda saat blur (agar klik item tetap kena). */
  function scheduleMentionClose() {
    cancelMentionClose();
    mentionCloseTimer.current = setTimeout(() => setMention(null), 150);
  }

  function cancelMentionClose() {
    if (mentionCloseTimer.current) {
      clearTimeout(mentionCloseTimer.current);
      mentionCloseTimer.current = null;
    }
  }

  function pickFiles() {
    fileInputRef.current?.click();
  }

  function onAttachCloud(files: CloudPickerFile[]) {
    const room =
      MAX_ATTACHMENTS_PER_MESSAGE - pending.length - uploading.length;
    if (room <= 0) {
      toast.error(`Maks ${MAX_ATTACHMENTS_PER_MESSAGE} lampiran per pesan`);
      return;
    }
    const additions: PendingAttachment[] = files
      .slice(0, room)
      .map((f) => ({
        fileId: f.id,
        name: f.name,
        size: f.size,
        mimetype: f.mimetype,
        storageKey: f.storageKey,
      }));
    if (additions.length < files.length) {
      toast.error(
        `Hanya ${additions.length} ditambahkan (maks ${MAX_ATTACHMENTS_PER_MESSAGE} lampiran)`
      );
    }
    setPending((prev) => [...prev, ...additions]);
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
      // Mimetype OS bisa kosong/salah (khususnya Android) — infer dari
      // ekstensi. SEMUA tipe file diterima.
      toAdd.push(f);
    }
    if (toAdd.length === 0) return;

    // Stage as uploading.
    const staged: UploadingState[] = toAdd.map((f) => ({
      id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      name: f.name,
      size: f.size,
      mimetype: resolveMime(f.name, f.type),
      previewUrl: isImageMime(resolveMime(f.name, f.type))
        ? URL.createObjectURL(f)
        : undefined,
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
    // (previewUrl di-revoke — dulu: blob URL gambar bocor terus di memori.)
    setUploading((prev) => {
      for (const u of prev) {
        if ((u.result || u.error) && u.previewUrl)
          URL.revokeObjectURL(u.previewUrl);
      }
      return prev.filter((u) => !u.result && !u.error);
    });
  }

  function removePending(fileId: string) {
    setPending((prev) => prev.filter((p) => p.fileId !== fileId));
  }

  function dismissUploading(id: string) {
    setUploading((prev) => {
      const target = prev.find((u) => u.id === id);
      if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((u) => u.id !== id);
    });
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
    const assignmentId = pendingAssignment?.id ?? null;
    setValue("");
    setMention(null);
    setSending(true);
    try {
      const sentId = await onSend(content, attachmentFileIds, assignmentId);
      // onSend mengembalikan null bila GAGAL (error sudah ditangani di
      // chat-view: bubble optimistic dibatalkan + toast). Dulu: pembersihan
      // "sukses" tetap jalan → teks + lampiran + balasan + draft HILANG.
      if (sentId === null || sentId === undefined) {
        setValue(content); // pulihkan teks agar bisa dikirim ulang
        return;
      }
      // On success: clear pending attachments + tugas + reply target + draft.
      setPending([]);
      setPendingAssignment(null);
      onCancelReply?.();
      try {
        localStorage.removeItem(draftKey);
      } catch {
        /* abaikan */
      }
    } finally {
      setSending(false);
      // refocus for fast typing
      requestAnimationFrame(() => ref.current?.focus());
    }
  }

  // Polling dikirim lewat jalur sama (konten teks terformat). Setelah pesan
  // nyata dibuat → otomatis pasang reaksi angka (dulu: dijanjikan di teks
  // pesan + toast tapi TIDAK PERNAH dipasang — anggota tak bisa memilih).
  async function sendPollContent(
    content: string,
    optionCount: number
  ): Promise<string | null> {
    const id = await onSend(content, [], null);
    if (id && optionCount > 0) {
      const NUMBER_EMOJIS = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣"];
      void (async () => {
        for (let i = 0; i < Math.min(optionCount, 5); i++) {
          try {
            await fetch(`/api/chat/messages/${id}/reactions`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ emoji: NUMBER_EMOJIS[i] }),
            });
          } catch {
            /* best-effort — polling tetap terkirim */
          }
        }
      })();
    }
    return id;
  }

  // Shift+Enter to send; plain Enter = newline (default behavior).
  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Navigasi popup @mention (↑↓ pilih, Enter/Tab sisipkan, Esc tutup).
    if (mention !== null && mentionItems.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMentionIndex((i) => (i + 1) % mentionItems.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMentionIndex(
          (i) => (i - 1 + mentionItems.length) % mentionItems.length
        );
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        const chosen = mentionItems[Math.min(mentionIndex, mentionItems.length - 1)];
        if (chosen) applyMention(chosen);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setMention(null);
        return;
      }
    }
    // Pilih slash command dengan panah + Enter.
    if (slashMatches.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSlashIndex((i) => (i + 1) % slashMatches.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSlashIndex(
          (i) => (i - 1 + slashMatches.length) % slashMatches.length
        );
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        const chosen = slashMatches[slashIndex];
        if (chosen) setValue(applySlashCommand(value, chosen.insert));
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setValue("");
        return;
      }
    }
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
            <p className="text-xs text-muted-foreground">Maks {MAX_ATTACHMENTS_PER_MESSAGE} file · {Math.round(MAX_FILE_SIZE / 1024 / 1024)}MB per file · tersimpan di cloud</p>
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

      {/* Kartu tugas yang menunggu dikirim */}
      {pendingAssignment ? (
        <div className="flex items-center gap-2 mb-2 rounded-md border border-primary/40 bg-primary/5 px-2 py-1.5 text-xs">
          <ClipboardList className="size-3.5 text-primary shrink-0" />
          <span className="font-medium text-primary truncate flex-1">
            Tugas: {pendingAssignment.title}
          </span>
          <button
            type="button"
            onClick={() => setPendingAssignment(null)}
            className="shrink-0 rounded-full p-0.5 hover:bg-muted text-muted-foreground"
            aria-label="Lepas tugas"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ) : null}

      {/* Slash command suggestions (Discord-style) */}
      {slashMatches.length > 0 && !previewMd ? (
        <div className="mb-2 rounded-lg border border-border bg-popover shadow-md overflow-hidden">
          <p className="px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Perintah cepat — ↑↓ untuk pilih, Enter untuk pakai
          </p>
          {slashMatches.slice(0, 6).map((c, i) => (
            <button
              key={c.cmd}
              type="button"
              onClick={() => setValue(applySlashCommand(value, c.insert))}
              onMouseEnter={() => setSlashIndex(i)}
              className={cn(
                "flex items-center gap-2.5 w-full px-3 py-1.5 text-left text-sm transition-colors",
                i === slashIndex ? "bg-accent" : "hover:bg-accent/50"
              )}
            >
              <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                {c.cmd}
              </code>
              <span className="text-xs text-muted-foreground truncate">
                {c.label}
              </span>
            </button>
          ))}
        </div>
      ) : null}

      {/* Pratinjau markdown */}
      {previewMd ? (
        <div className="mb-2 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2.5">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-primary/80 mb-1">
            Pratinjau markdown
          </p>
          {trimmed ? (
            <MarkdownText text={trimmed} />
          ) : (
            <p className="text-xs text-muted-foreground italic">
              (kosong — tulis sesuatu untuk melihat pratinjaunya)
            </p>
          )}
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
      />
      {/* Catatan: input sengaja TANPA accept supaya semua file terlihat di
          pemilih file (mimetype OS kosong/aneh masih divalidasi di atas). */}
      <div className="relative flex items-end gap-2">
        {/* Popup @mention — autocomplete di atas textarea (Discord style) */}
        {mention !== null ? (
          mentionUsers === null ? (
            <div
              className="absolute bottom-full left-0 z-30 mb-1.5 w-72 max-w-full rounded-lg border border-border bg-popover px-3 py-2 shadow-md"
              aria-live="polite"
            >
              <p className="text-xs text-muted-foreground">
                Memuat daftar anggota…
              </p>
            </div>
          ) : mentionItems.length > 0 ? (
            <div
              role="listbox"
              aria-label="Sebut anggota"
              className="absolute bottom-full left-0 z-30 mb-1.5 w-72 max-w-full overflow-hidden rounded-lg border border-border bg-popover shadow-md"
            >
              <p className="px-2.5 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Menyebut anggota — ↑↓ pilih · Enter/Tab sisipkan · Esc tutup
              </p>
              <div className="max-h-56 overflow-y-auto pb-1">
                {mentionItems.map((u, i) => (
                  <button
                    key={u.id}
                    type="button"
                    role="option"
                    aria-selected={i === mentionActive}
                    tabIndex={-1}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      cancelMentionClose();
                    }}
                    onMouseEnter={() => setMentionIndex(i)}
                    onClick={() => applyMention(u)}
                    className={cn(
                      "flex w-full items-center gap-2.5 px-2.5 py-1.5 text-left transition-colors",
                      i === mentionActive ? "bg-accent" : "hover:bg-accent/50"
                    )}
                  >
                    <UserAvatar
                      name={u.name}
                      username={u.username}
                      avatarUrl={u.avatarUrl}
                      size="xs"
                      className="shrink-0"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-medium">
                        {u.name}
                      </span>
                      <span className="block truncate text-[10px] text-muted-foreground">
                        @{u.username}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            </div>
          ) : null
        ) : null}
        <Textarea
          ref={ref}
          value={value}
          onChange={(e) => {
            const v = e.target.value;
            setValue(v);
            // Deteksi @mention pada kata terakhir sebelum kursor.
            updateMentionState(v, e.target.selectionStart ?? v.length);
          }}
          onSelect={(e) => {
            // Kursor berpindah (klik/panah) — deteksi ulang token @mention.
            const el = e.currentTarget;
            updateMentionState(value, el.selectionStart ?? value.length);
          }}
          onBlur={scheduleMentionClose}
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
          onClick={() => setPreviewMd((p) => !p)}
          disabled={disabled}
          aria-label={previewMd ? "Tutup pratinjau" : "Pratinjau markdown"}
          title={
            previewMd
              ? "Tutup pratinjau markdown"
              : "Pratinjau markdown (**tebal**, *miring*, dll)"
          }
          className={cn(
            "h-10 w-10 shrink-0 rounded-full",
            previewMd && "text-primary bg-primary/10 hover:bg-primary/15"
          )}
        >
          {previewMd ? (
            <EyeOff className="h-4 w-4" />
          ) : (
            <Eye className="h-4 w-4" />
          )}
        </Button>
        <VoiceRecorder
          conversation={conversation}
          disabled={disabled || isUploadingAny}
          onUploaded={(v) => {
            setPending((prev) => [...prev, v]);
          }}
        />
        <Button
          type="button"
          size="icon"
          variant="ghost"
          onClick={() => setPollOpen(true)}
          disabled={disabled}
          aria-label="Buat polling cepat"
          title="Buat polling cepat (voting lewat reaksi)"
          className="h-10 w-10 shrink-0 rounded-full"
        >
          <BarChart3 className="h-4 w-4" />
        </Button>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          onClick={() => setAssignmentOpen(true)}
          disabled={disabled}
          aria-label="Lampirkan tugas"
          title="Lampirkan tugas (kartu tugas dengan tombol buka)"
          className={cn(
            "h-10 w-10 shrink-0 rounded-full",
            pendingAssignment && "text-primary bg-primary/10 hover:bg-primary/15"
          )}
        >
          <ClipboardList className="h-4 w-4" />
        </Button>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          onClick={() => setPickerOpen(true)}
          disabled={disabled || isUploadingAny}
          aria-label="Lampirkan file dari cloud atau mount MEGA"
          title="Lampirkan file (cloud kelas / mount MEGA — permanen & bisa dipakai ulang)"
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
          className="h-10 w-10 shrink-0"
        >
          {sending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Send className="h-4 w-4" />
          )}
        </Button>
      </div>
      <p className="text-[10px] text-muted-foreground mt-1 px-1 hidden sm:block">
        Shift+Enter kirim · Enter baris baru · ketik / untuk perintah cepat · ketik @ untuk menyebut anggota · lampiran tersimpan di cloud
      </p>

      {/* Cloud picker — pilih file cloud / unggah baru */}
      <AttachmentPicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        conversation={conversation}
        pendingFileIds={pending.map((p) => p.fileId)}
        maxAttachments={MAX_ATTACHMENTS_PER_MESSAGE}
        onAttach={onAttachCloud}
      />

      {/* Lampirkan tugas */}
      <AssignmentAttachDialog
        open={assignmentOpen}
        onOpenChange={setAssignmentOpen}
        currentAssignmentId={pendingAssignment?.id ?? null}
        onAttach={(a) => setPendingAssignment(a)}
      />

      {/* Polling cepat */}
      <PollComposer
        open={pollOpen}
        onOpenChange={setPollOpen}
        onSendPoll={sendPollContent}
      />
    </div>
  );
}
