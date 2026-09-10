"use client";

// Daftar pesan yang disematkan (pin) di percakapan — selalu diambil segar
// dari server (tidak terbatas jendela 200 pesan). Klik → lompat ke pesan.

import { format } from "date-fns";
import { Pin, PinOff } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export interface PinnedMessage {
  id: string;
  content: string;
  createdAt: string;
  pinnedAt: string;
  sender: { id: string; name: string; username: string };
}

export function PinnedMessages({
  open,
  onOpenChange,
  conversation,
  onJump,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  conversation: { kind: "classroom" | "group" | "dm"; id: string };
  onJump: (id: string) => void;
}) {
  const { data, isLoading } = useQuery<{ pinned: PinnedMessage[] }>({
    queryKey: ["chat-pinned", conversation.kind, conversation.id],
    queryFn: async () => {
      const params = new URLSearchParams({
        kind: conversation.kind,
        id: conversation.id,
      });
      const res = await fetch(
        `/api/chat/messages/pinned?${params.toString()}`,
        { cache: "no-store" }
      );
      if (!res.ok) throw new Error("Gagal memuat sematan");
      return res.json();
    },
    enabled: open,
    refetchInterval: 15_000,
  });

  const pinned = data?.pinned ?? [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[75vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Pin className="size-5 text-primary" /> Pesan Sematan
          </DialogTitle>
          <DialogDescription>
            Pengirim, guru kelas, atau admin bisa menyematkan pesan lewat
            menu titik-tiga pada pesan.
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 min-h-0 overflow-y-auto rounded-lg border border-border divide-y divide-border">
          {isLoading ? (
            <div className="p-3 space-y-2">
              <Skeleton className="h-14 w-full" />
              <Skeleton className="h-14 w-full" />
            </div>
          ) : pinned.length === 0 ? (
            <div className="p-6 text-center text-sm text-muted-foreground">
              <PinOff className="size-6 mx-auto mb-2 opacity-40" />
              Belum ada pesan yang disematkan di sini.
            </div>
          ) : (
            pinned.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => {
                  onJump(p.id);
                  onOpenChange(false);
                }}
                className="flex items-start gap-2.5 w-full px-3 py-3 text-left hover:bg-accent/50 transition-colors"
              >
                <Pin className="size-4 shrink-0 mt-0.5 text-primary" />
                <div className="min-w-0 flex-1">
                  <p className="text-xs">
                    <span className="font-semibold">{p.sender.name}</span>
                    <span className="text-muted-foreground">
                      {" "}
                      · {format(new Date(p.createdAt), "d MMM yyyy HH:mm")}
                    </span>
                  </p>
                  <p className="text-sm line-clamp-3 whitespace-pre-wrap text-muted-foreground">
                    {p.content || "(lampiran)"}
                  </p>
                </div>
                <Badge variant="secondary" className="text-[9px] shrink-0">
                  sematan
                </Badge>
              </button>
            ))
          )}
        </div>

        <p className="text-[10px] text-muted-foreground text-right">
          Daftar diperbarui otomatis setiap 15 detik.
        </p>
      </DialogContent>
    </Dialog>
  );
}
