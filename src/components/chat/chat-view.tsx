"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Hash,
  Lock,
  MoreHorizontal,
  Copy,
  Check,
  Users,
  Loader2,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { UserAvatar } from "@/components/shared/user-avatar";
import { OnlineDot } from "@/components/shared/online-dot";
import { EmptyState } from "@/components/shared/empty-state";
import { useUIStore, type Conversation } from "@/stores/ui-store";
import type { MeResponse } from "@/hooks/use-me";
import { MESSAGE_POLL_INTERVAL } from "@/lib/constants";

import { MessageBubble } from "./message-bubble";
import { MessageInput } from "./message-input";
import { GroupCreateDialog } from "./group-create-dialog";
import { GroupJoinDialog } from "./group-join-dialog";
import { groupMessages, type ChatMessage, type ChatSender, type GroupInfo } from "./types";
import { Skeleton } from "@/components/ui/skeleton";

function conversationName(c: Conversation): string {
  if (c.kind === "dm") return c.peerName;
  return c.name;
}

const meAsSender = (me: MeResponse): ChatSender | null => {
  const u = me.user;
  if (!u) return null;
  return {
    id: u.id,
    name: u.name,
    username: u.username,
    avatarUrl: u.avatarUrl,
    avatarColor: u.avatarColor,
  };
};

export function ChatView({
  conversation,
  me,
  onlineIds,
}: {
  conversation: Conversation;
  me: MeResponse;
  onlineIds: Set<string>;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loadingInit, setLoadingInit] = useState(true);
  const [errorInit, setErrorInit] = useState<string | null>(null);
  const [groupInfo, setGroupInfo] = useState<GroupInfo | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [joinOpen, setJoinOpen] = useState(false);
  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null);

  const seenIdsRef = useRef<Set<string>>(new Set());
  const lastCreatedAtRef = useRef<string | null>(null);
  // Patokan `since` untuk sync realtime (jam SERVER dari response, bukan jam
  // client) — bebas skew antar perangkat.
  const lastPollRef = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const nearBottomRef = useRef<boolean>(true);
  const pollInFlightRef = useRef<boolean>(false);
  const conversationKeyRef = useRef<string>("");

  const mySender = meAsSender(me);
  const myId = me.user?.id ?? "";
  const myRole = me.user?.role ?? "STUDENT";
  const canDeleteAny = myRole === "ADMIN";

  const scrollToBottomIfNeeded = useCallback(() => {
    if (!nearBottomRef.current) return;
    sentinelRef.current?.scrollIntoView({ block: "end" });
  }, []);

  const mergeMessages = useCallback((incoming: ChatMessage[]) => {
    if (incoming.length === 0) return;
    const seen = seenIdsRef.current;
    const fresh = incoming.filter((m) => !seen.has(m.id));
    if (fresh.length === 0) return;
    for (const m of fresh) seen.add(m.id);
    fresh.sort(
      (a, b) =>
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    );
    setMessages((prev) => {
      const merged = prev.length === 0 ? fresh : [...prev, ...fresh];
      // Defensive: ensure sorted by createdAt ascending.
      merged.sort(
        (a, b) =>
          new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
      );
      return merged;
    });
    // Update lastCreatedAt
    const newest = fresh[fresh.length - 1];
    if (
      !lastCreatedAtRef.current ||
      new Date(newest.createdAt).getTime() >
      new Date(lastCreatedAtRef.current).getTime()
    ) {
      lastCreatedAtRef.current = newest.createdAt;
    }
  }, []);

  const fetchMessages = useCallback(
    async (
      since: string | null,
      signal: AbortSignal
    ): Promise<{ messages: ChatMessage[]; serverTime: string }> => {
      const params = new URLSearchParams({
        kind: conversation.kind,
        id: conversation.id,
      });
      if (since) params.set("since", since);
      const res = await fetch(`/api/chat/messages?${params.toString()}`, {
        cache: "no-store",
        signal,
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.error || `HTTP ${res.status}`);
      }
      const data = (await res.json()) as {
        messages: ChatMessage[];
        serverTime?: string;
      };
      return {
        messages: data.messages,
        serverTime: data.serverTime ?? new Date().toISOString(),
      };
    },
    [conversation.id, conversation.kind]
  );

  // (Re)load on conversation change.
  useEffect(() => {
    const key = `${conversation.kind}:${conversation.id}`;
    conversationKeyRef.current = key;
    const controller = new AbortController();

    // Reset state.
    setMessages([]);
    setGroupInfo(null);
    setErrorInit(null);
    setLoadingInit(true);
    setReplyTo(null);
    seenIdsRef.current = new Set();
    lastCreatedAtRef.current = null;
    lastPollRef.current = null;
    nearBottomRef.current = true;

    (async () => {
      try {
        const all = await fetchMessages(null, controller.signal);
        if (controller.signal.aborted) return;
        if (conversationKeyRef.current !== key) return;
        mergeMessages(all.messages);
        // Awal patokan sync realtime = jam server saat initial load.
        lastPollRef.current = all.serverTime;
      } catch (e) {
        if (controller.signal.aborted) return;
        if (conversationKeyRef.current !== key) return;
        setErrorInit(
          e instanceof Error ? e.message : "Gagal memuat pesan"
        );
      } finally {
        if (conversationKeyRef.current === key) {
          setLoadingInit(false);
          // Jump to bottom on first load.
          requestAnimationFrame(() => {
            nearBottomRef.current = true;
            sentinelRef.current?.scrollIntoView({ block: "end" });
          });
        }
      }
    })();

    return () => {
      controller.abort();
    };
  }, [conversation.id, conversation.kind, fetchMessages, mergeMessages]);

  // Terapkan delta sync (dipakai BERSAMA oleh SSE stream & polling
  // fallback): pesan baru → append; berubah → replace by id; terhapus →
  // buang dari state + seen.
  const applySyncData = useCallback(
    (data: {
      new?: ChatMessage[];
      changed?: ChatMessage[];
      deletedIds?: string[];
      serverTime?: string;
    }) => {
      if (data.new?.length) mergeMessages(data.new);
      if (data.changed?.length) {
        const changedMap = new Map(data.changed.map((c) => [c.id, c]));
        setMessages((prev) => prev.map((m) => changedMap.get(m.id) ?? m));
      }
      if (data.deletedIds?.length) {
        const del = new Set(data.deletedIds);
        for (const id of del) seenIdsRef.current.delete(id);
        setMessages((prev) => prev.filter((m) => !del.has(m.id)));
      }
      if (data.serverTime) lastPollRef.current = data.serverTime;
    },
    [mergeMessages]
  );

  // ── Realtime "0-delay": SSE stream ──
  // Server mendorong delta (pesan/edit/hapus/reaksi) seketika begitu
  // terjadi (cek tiap ±400 ms di server). EventSource auto-reconnect.
  // Saat tab disembunyikan: tutup koneksi (hemat resource), buka lagi saat
  // kembali visible — polling fallback menutup celah di sela-selanya.
  const sseAliveRef = useRef<number>(0);
  useEffect(() => {
    const key = `${conversation.kind}:${conversation.id}`;
    let es: EventSource | null = null;
    let stopped = false;

    function connect() {
      if (stopped || typeof window === "undefined") return;
      if (conversationKeyRef.current !== key) return;
      const params = new URLSearchParams({
        kind: conversation.kind,
        id: conversation.id,
      });
      if (lastPollRef.current) params.set("since", lastPollRef.current);
      es = new EventSource(
        `/api/chat/messages/stream?${params.toString()}`
      );
      es.onmessage = (ev: MessageEvent<string>) => {
        if (conversationKeyRef.current !== key) return;
        try {
          const data = JSON.parse(ev.data) as {
            new?: ChatMessage[];
            changed?: ChatMessage[];
            deletedIds?: string[];
            serverTime?: string;
            hello?: boolean;
          };
          applySyncData(data);
          sseAliveRef.current = Date.now();
        } catch {
          /* event rusak — abaikan */
        }
      };
    }

    function onVisibility() {
      if (document.hidden) {
        es?.close();
        es = null;
      } else {
        connect();
      }
    }

    connect();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stopped = true;
      document.removeEventListener("visibilitychange", onVisibility);
      es?.close();
      es = null;
    };
  }, [conversation.id, conversation.kind, applySyncData]);

  // Polling fallback (2,5 dtk) — hanya aktif kalau SSE tidak sehat
  // (>10 dtk tanpa event), mis. proxy memblok streaming atau koneksi putus.
  useEffect(() => {
    const key = `${conversation.kind}:${conversation.id}`;
    const interval = setInterval(async () => {
      if (pollInFlightRef.current) return;
      if (typeof document !== "undefined" && document.hidden) return;
      if (conversationKeyRef.current !== key) return;
      if (Date.now() - sseAliveRef.current < 10_000) return; // SSE sehat
      pollInFlightRef.current = true;
      try {
        const loadedIds = Array.from(seenIdsRef.current).filter(
          (id) => !id.startsWith("temp_")
        );
        const res = await fetch("/api/chat/messages/sync", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            kind: conversation.kind,
            id: conversation.id,
            since: lastPollRef.current,
            loadedIds,
          }),
        });
        if (!res.ok) return;
        const data = (await res.json()) as {
          new?: ChatMessage[];
          changed?: ChatMessage[];
          deletedIds?: string[];
          serverTime?: string;
        };
        if (conversationKeyRef.current !== key) return;
        applySyncData(data);
      } catch {
        // swallow polling errors silently
      } finally {
        pollInFlightRef.current = false;
      }
    }, MESSAGE_POLL_INTERVAL);
    return () => clearInterval(interval);
  }, [conversation.id, conversation.kind, applySyncData]);

  // Poor-man's cleanup cron: fire cleanup on mount + every 10 min.
  // Fire-and-forget; do not await.
  useEffect(() => {
    const fire = () => {
      fetch("/api/chat/attachments/cleanup", { method: "POST" }).catch(
        () => {}
      );
    };
    fire();
    const t = setInterval(fire, 10 * 60 * 1000);
    return () => clearInterval(t);
  }, []);

  // Group info fetch (groups only) for invite code + member count.
  useEffect(() => {
    if (conversation.kind !== "group") {
      setGroupInfo(null);
      return;
    }
    const key = `${conversation.kind}:${conversation.id}`;
    let active = true;
    (async () => {
      try {
        const res = await fetch(
          `/api/chat/groups/${conversation.id}/info`,
          { cache: "no-store" }
        );
        if (!res.ok) return;
        const data = (await res.json()) as { group: GroupInfo };
        if (active && conversationKeyRef.current === key) {
          setGroupInfo(data.group);
        }
      } catch {
        // ignore
      }
    })();
    return () => {
      active = false;
    };
  }, [conversation.id, conversation.kind]);

  // Auto-scroll on new messages if near bottom.
  useEffect(() => {
    scrollToBottomIfNeeded();
  }, [messages, scrollToBottomIfNeeded]);

  // Scroll handler to track "near bottom".
  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    nearBottomRef.current = dist < 80;
  }, []);

  const handleSend = useCallback(
    async (content: string, attachmentFileIds: string[]) => {
      if (!mySender) return;
      const tempId = `temp_${Date.now()}_${Math.random()
        .toString(36)
        .slice(2, 8)}`;
      const optimistic: ChatMessage = {
        id: tempId,
        content,
        createdAt: new Date().toISOString(),
        editedAt: null,
        senderId: mySender.id,
        sender: mySender,
        attachments: [],
        reactions: [],
        replyTo: replyTo
          ? {
              id: replyTo.id,
              content: replyTo.content,
              sender: {
                id: replyTo.sender.id,
                name: replyTo.sender.name,
                username: replyTo.sender.username,
              },
            }
          : null,
      };
      seenIdsRef.current.add(tempId);
      setMessages((prev) => [...prev, optimistic]);
      lastCreatedAtRef.current = optimistic.createdAt;
      nearBottomRef.current = true;

      try {
        const res = await fetch("/api/chat/messages", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            kind: conversation.kind,
            id: conversation.id,
            content,
            attachmentFileIds,
            replyToId: replyTo?.id ?? undefined,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error || "Gagal mengirim");
        const real = data.message as ChatMessage;
        // Replace optimistic message in-place with the real one.
        seenIdsRef.current.delete(tempId);
        const seen = seenIdsRef.current;
        if (!seen.has(real.id)) seen.add(real.id);
        setMessages((prev) => {
          const exists = prev.some((m) => m.id === real.id);
          const next = exists
            ? prev.filter((m) => m.id !== tempId)
            : prev.map((m) => (m.id === tempId ? real : m));
          next.sort(
            (a, b) =>
              new Date(a.createdAt).getTime() -
              new Date(b.createdAt).getTime()
          );
          return next;
        });
        if (
          !lastCreatedAtRef.current ||
          new Date(real.createdAt).getTime() >
          new Date(lastCreatedAtRef.current).getTime()
        ) {
          lastCreatedAtRef.current = real.createdAt;
        }
      } catch (e) {
        // Revert optimistic
        seenIdsRef.current.delete(tempId);
        setMessages((prev) => prev.filter((m) => m.id !== tempId));
        toast.error(e instanceof Error ? e.message : "Gagal mengirim pesan");
      }
    },
    [conversation.id, conversation.kind, mySender, replyTo]
  );

  const handleEdit = useCallback(
    async (messageId: string, content: string) => {
      // Optimistic edit + PATCH.
      const originalRef: { prev?: ChatMessage } = {};
      setMessages((prev) =>
        prev.map((m) => {
          if (m.id !== messageId) return m;
          originalRef.prev = m;
          return {
            ...m,
            content,
            editedAt: new Date().toISOString(),
          };
        })
      );
      try {
        const res = await fetch(`/api/chat/messages/${messageId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error || "Gagal menyimpan");
        // Replace with server-truth (covers editedAt formatting).
        const updated = data.message as ChatMessage;
        setMessages((prev) =>
          prev.map((m) => (m.id === messageId ? updated : m))
        );
      } catch (e) {
        // Revert
        if (originalRef.prev) {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === messageId ? originalRef.prev! : m
            )
          );
        }
        throw e;
      }
    },
    []
  );

  const handleDelete = useCallback(async (messageId: string) => {
    const original = messages.find((m) => m.id === messageId);
    setMessages((prev) => prev.filter((m) => m.id !== messageId));
    seenIdsRef.current.delete(messageId);
    try {
      const res = await fetch(`/api/chat/messages/${messageId}`, {
        method: "DELETE",
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || "Gagal menghapus");
      toast.success("Pesan dihapus");
    } catch (e) {
      // Restore
      if (original) {
        seenIdsRef.current.add(original.id);
        setMessages((prev) => {
          const next = [...prev, original];
          next.sort(
            (a, b) =>
              new Date(a.createdAt).getTime() -
              new Date(b.createdAt).getTime()
          );
          return next;
        });
      }
      toast.error(e instanceof Error ? e.message : "Gagal menghapus pesan");
      throw e;
    }
  }, [messages]);

  const handleReact = useCallback(
    async (messageId: string, emoji: string) => {
      if (!mySender) return;
      // Optimistic toggle.
      let didReact = false;
      setMessages((prev) =>
        prev.map((m) => {
          if (m.id !== messageId) return m;
          const existing = (m.reactions ?? []).find(
            (r) => r.emoji === emoji && r.user.id === mySender.id
          );
          if (existing) {
            didReact = false;
            return {
              ...m,
              reactions: (m.reactions ?? []).filter((r) => r.id !== existing.id),
            };
          }
          didReact = true;
          return {
            ...m,
            reactions: [
              ...(m.reactions ?? []),
              {
                id: `temp_r_${Date.now()}_${Math.random()
                  .toString(36)
                  .slice(2, 6)}`,
                emoji,
                user: {
                  id: mySender.id,
                  name: mySender.name,
                  username: mySender.username,
                },
              },
            ],
          };
        })
      );
      try {
        const res = await fetch(`/api/chat/messages/${messageId}/reactions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ emoji }),
        });
        const data = await res.json().catch(() => null);
        if (!res.ok) throw new Error(data?.error || "Gagal memberi reaksi");
        // Server-truth: align reacted state (in case of race). Use returned flag.
        const reacted = !!data?.reacted;
        if (reacted !== didReact) {
          // Toggle again to align.
          setMessages((prev) =>
            prev.map((m) => {
              if (m.id !== messageId) return m;
              const has = (m.reactions ?? []).some(
                (r) => r.emoji === emoji && r.user.id === mySender.id
              );
              if (reacted && !has) {
                return {
                  ...m,
                  reactions: [
                    ...(m.reactions ?? []),
                    {
                      id: `srv_r_${Date.now()}_${Math.random()
                        .toString(36)
                        .slice(2, 6)}`,
                      emoji,
                      user: {
                        id: mySender.id,
                        name: mySender.name,
                        username: mySender.username,
                      },
                    },
                  ],
                };
              }
              if (!reacted && has) {
                return {
                  ...m,
                  reactions: (m.reactions ?? []).filter(
                    (r) =>
                      !(r.emoji === emoji && r.user.id === mySender.id)
                  ),
                };
              }
              return m;
            })
          );
        }
      } catch (e) {
        // Revert optimistic toggle.
        setMessages((prev) =>
          prev.map((m) => {
            if (m.id !== messageId) return m;
            if (didReact) {
              return {
                ...m,
                reactions: (m.reactions ?? []).filter(
                  (r) =>
                    !(r.emoji === emoji && r.user.id === mySender.id)
                ),
              };
            }
            return {
              ...m,
              reactions: [
                ...(m.reactions ?? []),
                {
                  id: `revert_r_${Date.now()}_${Math.random()
                    .toString(36)
                    .slice(2, 6)}`,
                  emoji,
                  user: {
                    id: mySender.id,
                    name: mySender.name,
                    username: mySender.username,
                  },
                },
              ],
            };
          })
        );
        toast.error(e instanceof Error ? e.message : "Gagal memberi reaksi");
      }
    },
    [mySender]
  );

  const handleScrollToMessage = useCallback((id: string) => {
    const el = document.getElementById(`msg-${id}`);
    if (!el) {
      toast.message("Pesan asli tidak ditemukan");
      return;
    }
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    // Briefly flash the row to draw attention.
    el.classList.add("ring-2", "ring-primary/60", "rounded-md");
    setTimeout(() => {
      el.classList.remove("ring-2", "ring-primary/60", "rounded-md");
    }, 1400);
  }, []);

  const openConversation = useUIStore((s) => s.openConversation);
  const openProfile = useUIStore((s) => s.openProfile);

  const handleAvatarClick = useCallback(
    (sender: ChatSender) => {
      if (sender.id === myId) {
        openProfile();
        return;
      }
      // Start a DM with this peer.
      (async () => {
        try {
          const res = await fetch("/api/conversations/dm/start", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ peerId: sender.id }),
          });
          if (!res.ok) throw new Error();
          const { id } = await res.json();
          openConversation({
            kind: "dm",
            id,
            peerId: sender.id,
            peerName: sender.name,
          });
        } catch {
          toast.error("Gagal memulai DM");
        }
      })();
    },
    [myId, openConversation, openProfile]
  );

  const grouped = groupMessages(messages);

  return (
    <div className="h-full flex flex-col bg-background">
      <ChatHeader
        conversation={conversation}
        onlineIds={onlineIds}
        groupInfo={groupInfo}
        onCreateClick={() => setCreateOpen(true)}
        onJoinClick={() => setJoinOpen(true)}
      />

      {/* Messages */}
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="flex-1 min-h-0 overflow-y-auto px-3 sm:px-6 py-4"
      >
        {loadingInit && messages.length === 0 ? (
          <div className="space-y-4 max-w-3xl mx-auto">
            {/* Skeleton message cards */}
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="flex items-end gap-2">
                <Skeleton className="h-8 w-8 rounded-full shrink-0" />
                <div className="space-y-1.5 flex-1 max-w-[70%]">
                  <div className="flex items-center gap-2">
                    <Skeleton className="h-3 w-24" />
                    <Skeleton className="h-2 w-12" />
                  </div>
                  <Skeleton className="h-8 w-3/4 rounded-xl" />
                  <Skeleton className="h-4 w-20" />
                </div>
              </div>
            ))}
          </div>
        ) : errorInit ? (
          <div className="h-full flex items-center justify-center">
            <div className="text-center max-w-sm">
              <p className="text-sm font-medium text-foreground">
                Gagal memuat pesan
              </p>
              <p className="text-xs text-muted-foreground mt-1">{errorInit}</p>
              <Button
                variant="outline"
                size="sm"
                className="mt-3"
                onClick={() => {
                  // Force remount effect by toggling key via stateless reload.
                  setErrorInit(null);
                  setLoadingInit(true);
                  seenIdsRef.current = new Set();
                  lastCreatedAtRef.current = null;
                  lastPollRef.current = null;
                  fetchMessages(null, new AbortController().signal)
                    .then((all) => {
                      mergeMessages(all.messages);
                      lastPollRef.current = all.serverTime;
                    })
                    .catch((e) =>
                      setErrorInit(
                        e instanceof Error ? e.message : "Gagal memuat"
                      )
                    )
                    .finally(() => setLoadingInit(false));
                }}
              >
                Coba lagi
              </Button>
            </div>
          </div>
        ) : grouped.length === 0 ? (
          <EmptyState
            title="Mulai percakapan"
            description="Belum ada pesan di sini. Sapa anggota lain di bawah ini."
          />
        ) : (
          <div className="max-w-3xl mx-auto">
            {grouped.map(({ message, showHeader }) => (
              <MessageBubble
                key={message.id}
                message={message}
                showHeader={showHeader}
                isOwn={message.senderId === myId}
                onlineIds={onlineIds}
                currentUserId={myId}
                canDelete={canDeleteAny || message.senderId === myId}
                onAvatarClick={handleAvatarClick}
                onReply={(msg) => setReplyTo(msg)}
                onEdit={handleEdit}
                onDelete={handleDelete}
                onReact={handleReact}
                onScrollToMessage={handleScrollToMessage}
              />
            ))}
            <div ref={sentinelRef} className="h-1" />
          </div>
        )}
      </div>

      {/* Input */}
      {mySender ? (
        <MessageInput
          onSend={handleSend}
          placeholder={`Kirim pesan ke ${conversationName(conversation)}…`}
          conversation={{ kind: conversation.kind, id: conversation.id }}
          replyTo={replyTo}
          onCancelReply={() => setReplyTo(null)}
        />
      ) : null}

      {/* Group create/join dialogs (controlled) */}
      <GroupCreateDialog me={me} open={createOpen} onOpenChange={setCreateOpen} />
      <GroupJoinDialog open={joinOpen} onOpenChange={setJoinOpen} />
    </div>
  );
}

function ChatHeader({
  conversation,
  onlineIds,
  groupInfo,
  onCreateClick,
  onJoinClick,
}: {
  conversation: Conversation;
  onlineIds: Set<string>;
  groupInfo: GroupInfo | null;
  onCreateClick: () => void;
  onJoinClick: () => void;
}) {
  const [copied, setCopied] = useState(false);

  const subtitle = (() => {
    if (conversation.kind === "classroom") return "Seluruh anggota kelas";
    if (conversation.kind === "group") {
      if (groupInfo) {
        const n = groupInfo.members.length;
        return `Grup privat · ${n} anggota`;
      }
      return "Grup privat";
    }
    // dm
    const online = onlineIds.has(conversation.peerId);
    return online ? "Sedang online" : "Offline";
  })();

  async function copyInviteCode() {
    if (!groupInfo) return;
    try {
      await navigator.clipboard.writeText(groupInfo.inviteCode);
      setCopied(true);
      toast.success(`Kode invite ${groupInfo.inviteCode} disalin`);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Gagal menyalin kode");
    }
  }

  return (
    <header className="shrink-0 border-b border-border bg-background/80 backdrop-blur px-3 sm:px-6 py-3">
      <div className="max-w-3xl mx-auto flex items-center gap-3">
        <ConversationIcon
          conversation={conversation}
          onlineIds={onlineIds}
        />
        <div className="min-w-0 flex-1">
          <h2 className="font-semibold leading-tight truncate">
            {conversationName(conversation)}
          </h2>
          <p className="text-xs text-muted-foreground truncate">
            {subtitle}
          </p>
        </div>

        {/* Group actions */}
        {conversation.kind === "group" && groupInfo ? (
          groupInfo.canShareInvite ? (
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5 shrink-0"
              onClick={copyInviteCode}
              title={`Kode invite: ${groupInfo.inviteCode}`}
            >
              {copied ? (
                <Check className="h-3.5 w-3.5 text-emerald-500" />
              ) : (
                <Copy className="h-3.5 w-3.5" />
              )}
              <span className="hidden sm:inline">
                {copied ? "Tersalin" : "Salin kode"}
              </span>
              <Badge variant="secondary" className="ml-0.5 font-mono text-[10px]">
                {groupInfo.inviteCode}
              </Badge>
            </Button>
          ) : (
            <Badge
              variant="outline"
              className="shrink-0 text-muted-foreground gap-1"
              title="Hanya guru/admin/penyiar yang bisa membagikan kode invite grup ini"
            >
              <Lock className="h-3 w-3" />
              <span className="hidden sm:inline">Invite terkunci</span>
            </Badge>
          )
        ) : null}

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="shrink-0"
              aria-label="Lebih"
            >
              <MoreHorizontal className="h-5 w-5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuItem onSelect={onCreateClick}>
              <Lock className="h-4 w-4" /> Buat Grup
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onJoinClick}>
              <Users className="h-4 w-4" /> Gabung Grup
            </DropdownMenuItem>
            {conversation.kind === "group" && groupInfo?.canShareInvite ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={copyInviteCode}>
                  <Copy className="h-4 w-4" /> Salin kode invite
                </DropdownMenuItem>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}

function ConversationIcon({
  conversation,
  onlineIds,
}: {
  conversation: Conversation;
  onlineIds: Set<string>;
}) {
  if (conversation.kind === "classroom") {
    return (
      <div className="h-9 w-9 rounded-md bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 flex items-center justify-center shrink-0">
        <Hash className="h-5 w-5" />
      </div>
    );
  }
  if (conversation.kind === "group") {
    return (
      <div className="h-9 w-9 rounded-md bg-amber-500/10 text-amber-600 dark:text-amber-400 flex items-center justify-center shrink-0">
        <Lock className="h-5 w-5" />
      </div>
    );
  }
  // dm
  const online = onlineIds.has(conversation.peerId);
  return (
    <div className="relative shrink-0">
      <UserAvatar name={conversation.peerName} size="sm" />
      <OnlineDot online={online} />
    </div>
  );
}
