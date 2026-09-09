"use client";

import { useQuery } from "@tanstack/react-query";

export interface DmPeer {
  id: string;
  name: string;
  username: string;
  avatarUrl: string | null;
  avatarColor: string;
  status: string;
  lastSeen: string;
}

export interface DmConversation {
  id: string;
  peer: DmPeer;
  lastMessage: {
    id: string;
    content: string;
    createdAt: string;
    senderId: string;
  } | null;
}

export function useDmConversations(enabled: boolean) {
  return useQuery<{ conversations: DmConversation[] }>({
    queryKey: ["dm-conversations"],
    queryFn: async () => {
      const res = await fetch("/api/conversations/dm", { cache: "no-store" });
      if (!res.ok) throw new Error("Failed to load conversations");
      return res.json();
    },
    enabled,
    refetchInterval: 8_000,
  });
}
