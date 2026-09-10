"use client";

// Pencarian pesan dalam percakapan — cari di pesan yang sudah dimuat
// (jendela 200 terbaru), daftar hasil, klik untuk lompat + sorot.

import { useEffect, useMemo, useState } from "react";
import { format } from "date-fns";
import { MessageSquareText, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { ChatMessage } from "./types";

export function MessageSearch({
  open,
  onOpenChange,
  messages,
  onJump,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  messages: ChatMessage[];
  onJump: (id: string) => void;
}) {
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");

  // Reset pencarian saat dialog DIBUKA — pola render (adjust state during
  // render), bukan di dalam efek.
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) {
      setQ("");
      setDebounced("");
    }
  }

  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim().toLowerCase()), 200);
    return () => clearTimeout(t);
  }, [q]);

  const results = useMemo(() => {
    if (debounced.length < 2) return [];
    const out: { m: ChatMessage; snippet: string }[] = [];
    // Cari dari yang terbaru.
    for (let i = messages.length - 1; i >= 0 && out.length < 30; i--) {
      const m = messages[i];
      if (!m.content) continue;
      const idx = m.content.toLowerCase().indexOf(debounced);
      if (idx === -1) continue;
      const start = Math.max(0, idx - 30);
      const end = Math.min(m.content.length, idx + debounced.length + 40);
      const snippet =
        (start > 0 ? "…" : "") +
        m.content.slice(start, end).replace(/\n/g, " ") +
        (end < m.content.length ? "…" : "");
      out.push({ m, snippet });
    }
    return out;
  }, [messages, debounced]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[75vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Search className="size-5 text-primary" /> Cari Pesan
          </DialogTitle>
          <DialogDescription>
            Mencari di {messages.length} pesan terakhir percakapan ini.
          </DialogDescription>
        </DialogHeader>

        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
          <Input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Ketik minimal 2 huruf…"
            className="pl-8"
          />
          {q ? (
            <button
              type="button"
              onClick={() => setQ("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              aria-label="Bersihkan"
            >
              <X className="size-3.5" />
            </button>
          ) : null}
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto rounded-lg border border-border divide-y divide-border">
          {debounced.length < 2 ? (
            <p className="p-6 text-center text-sm text-muted-foreground">
              Ketik kata kunci untuk mulai mencari.
            </p>
          ) : results.length === 0 ? (
            <p className="p-6 text-center text-sm text-muted-foreground">
              Tidak ada pesan yang cocok dengan “{debounced}”.
            </p>
          ) : (
            results.map(({ m, snippet }) => (
              <button
                key={m.id}
                type="button"
                onClick={() => {
                  onJump(m.id);
                  onOpenChange(false);
                }}
                className="flex items-start gap-2.5 w-full px-3 py-2.5 text-left hover:bg-accent/50 transition-colors"
              >
                <MessageSquareText className="size-4 shrink-0 mt-0.5 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <p className="text-xs">
                    <span className="font-semibold">{m.sender.name}</span>
                    <span className="text-muted-foreground">
                      {" "}
                      · {format(new Date(m.createdAt), "d MMM HH:mm")}
                    </span>
                  </p>
                  <p className="text-sm text-muted-foreground truncate">{snippet}</p>
                </div>
              </button>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
