"use client";

// ─────────────────────────────────────────────────────────────────────
// Teman AI — asisten belajar pribadi (BYOK: bawa kunci API sendiri).
// Chat penuh tinggi: header (model aktif + sumber), daftar pesan dengan
// markdown, input Enter-kirim, streaming dengan tombol Stop.
// ─────────────────────────────────────────────────────────────────────

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { toast } from "sonner";
import {
  Bot,
  Settings2,
  Trash2,
  Send,
  Square,
  Loader2,
  AlertTriangle,
  KeyRound,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import type { MeResponse } from "@/hooks/use-me";
import { cn } from "@/lib/utils";
import { providerLabel } from "@/lib/ai-providers";
import {
  AiSettingsDialog,
  fetchAiSettings,
  type AiSettingsData,
} from "@/components/ai/ai-settings-dialog";
import { AiMarkdown } from "@/components/ai/ai-markdown";

interface ChatMsg {
  id: string;
  role: "user" | "assistant";
  content: string;
  error?: boolean;
  stopped?: boolean;
  streaming?: boolean;
}

export function TemanAiView({ me }: { me: MeResponse }) {
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [settings, setSettings] = useState<AiSettingsData | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickBottomRef = useRef(true);

  const loadHistory = useCallback(async () => {
    try {
      const res = await fetch("/api/ai/history", { cache: "no-store" });
      if (!res.ok) return;
      const json = await res.json();
      setMessages(
        (json.messages ?? []).map(
          (m: { id: string; role: string; content: string }) => ({
            id: m.id,
            role: m.role === "assistant" ? "assistant" : "user",
            content: m.content,
          })
        )
      );
      stickBottomRef.current = true;
    } catch {
      /* abaikan */
    }
  }, []);

  const loadSettings = useCallback(async () => {
    const d = await fetchAiSettings();
    setSettings(d);
    return d;
  }, []);

  useEffect(() => {
    void loadHistory();
    void loadSettings();
  }, [loadHistory, loadSettings]);

  // Auto-scroll ke bawah saat pesan baru / streaming (kalau user tidak sedang scroll ke atas).
  useEffect(() => {
    if (!stickBottomRef.current) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    stickBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 90;
  }

  function patchMsg(id: string, patch: Partial<ChatMsg>) {
    setMessages((prev) =>
      prev.map((m) => (m.id === id ? { ...m, ...patch } : m))
    );
  }

  async function send() {
    const text = input.trim();
    if (!text || streaming) return;
    setInput("");
    stickBottomRef.current = true;

    const userId = `u-${Date.now()}`;
    const aiId = `a-${Date.now()}`;
    setMessages((prev) => [
      ...prev,
      { id: userId, role: "user", content: text },
      { id: aiId, role: "assistant", content: "", streaming: true },
    ]);
    setStreaming(true);

    const ac = new AbortController();
    abortRef.current = ac;

    try {
      const res = await fetch("/api/ai/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text }),
        signal: ac.signal,
      });

      if (!res.ok || !res.body) {
        const json = await res.json().catch(() => null);
        throw new Error(json?.error ?? `Gagal menghubungi server (HTTP ${res.status}).`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let got = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          let ev: { type?: string; text?: string; message?: string };
          try {
            ev = JSON.parse(trimmed);
          } catch {
            continue;
          }
          if (ev.type === "chunk" && ev.text) {
            got += ev.text;
            patchMsg(aiId, { content: got, streaming: true });
          } else if (ev.type === "error") {
            // JANGAN timpa jawaban parsial yang sudah tampil — server tetap
            // menyimpan potongannya, jadi tampilkan error DI BAWAH teks
            // (dulu: potongan hilang di layar padahal tersimpan → membingungkan
            // setelah reload muncul lagi).
            patchMsg(aiId, {
              content: got
                ? `${got}\n\n---\n\n⚠️ ${ev.message ?? "Terjadi error."}`
                : (ev.message ?? "Terjadi error."),
              error: !got,
              streaming: false,
            });
          }
        }
      }
      patchMsg(aiId, { streaming: false });
      if (!got.trim()) {
        // Tidak ada chunk sama sekali & tidak ada error → dianggap dihentikan / kosong.
        setMessages((prev) =>
          prev.map((m) =>
            m.id === aiId && !m.content && !m.error
              ? { ...m, content: "_(tidak ada jawaban)_", stopped: true }
              : m
          )
        );
      }
    } catch (err) {
      if (ac.signal.aborted) {
        // User menekan Stop → potongan jawaban tetap tampil (tersimpan di server).
        patchMsg(aiId, { streaming: false, stopped: true });
      } else {
        patchMsg(aiId, {
          content: (err as Error)?.message ?? "Koneksi gagal. Coba lagi.",
          error: true,
          streaming: false,
        });
      }
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  }

  function stop() {
    abortRef.current?.abort();
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  }

  async function clearHistory() {
    setConfirmClear(false);
    try {
      const res = await fetch("/api/ai/history", { method: "DELETE" });
      if (!res.ok) throw new Error();
      setMessages([]);
      toast.success("Riwayat Teman AI dibersihkan.");
    } catch {
      toast.error("Gagal membersihkan riwayat.");
    }
  }

  const active = settings?.active ?? null;
  const meName = me.user?.name ?? "kamu";

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="border-b border-border px-4 md:px-6 py-3 flex items-center gap-3 shrink-0">
        <div className="h-9 w-9 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
          <Bot className="h-5 w-5 text-primary" />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="font-semibold text-lg leading-tight">Teman AI</h2>
          <div className="flex flex-wrap items-center gap-1.5">
            {active ? (
              <>
                <Badge variant="secondary" className="max-w-56 truncate">
                  {providerLabel(active.provider)} · {active.model || "model default"}
                </Badge>
                <Badge
                  variant={active.source === "user" ? "default" : "outline"}
                  className="gap-1"
                >
                  {active.source === "user" ? (
                    <>
                      <KeyRound className="h-3 w-3" /> kunci sendiri
                    </>
                  ) : (
                    "default admin"
                  )}
                </Badge>
              </>
            ) : (
              <span className="text-xs text-muted-foreground">
                Belum ada AI terpasang — pasang kunci API-mu sendiri.
              </span>
            )}
          </div>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5"
          onClick={() => setSettingsOpen(true)}
        >
          <Settings2 className="h-4 w-4" /> Pengaturan
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 text-muted-foreground hover:text-destructive"
          onClick={() => setConfirmClear(true)}
          title="Bersihkan riwayat"
          aria-label="Bersihkan riwayat"
          disabled={messages.length === 0}
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>

      {/* Daftar pesan */}
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="flex-1 min-h-0 overflow-y-auto px-4 md:px-6 py-4"
      >
        {messages.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-center gap-3 py-10">
            <div className="h-16 w-16 rounded-full bg-primary/10 flex items-center justify-center">
              <Bot className="h-8 w-8 text-primary" />
            </div>
            <div>
              <h3 className="font-semibold text-lg">Hai {meName}! 👋</h3>
              <p className="text-sm text-muted-foreground max-w-sm mt-1">
                Tanya apa saja soal pelajaran — Teman AI akan menjelaskan
                langkah demi langkah, ringkas dan jelas.
              </p>
            </div>
            {!active ? (
              <Button
                variant="outline"
                className="gap-1.5"
                onClick={() => setSettingsOpen(true)}
              >
                <KeyRound className="h-4 w-4" /> Pasang API key sendiri
              </Button>
            ) : null}
            <p className="text-xs text-muted-foreground">
              Coba: &quot;Jelaskan cara mengerjakan soal pecahan campuran&quot;
            </p>
          </div>
        ) : (
          <div className="max-w-3xl mx-auto space-y-4 pb-2">
            {messages.map((m) => (
              <div
                key={m.id}
                className={cn(
                  "flex gap-2.5",
                  m.role === "user" ? "justify-end" : "justify-start"
                )}
              >
                {m.role === "assistant" ? (
                  <div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center shrink-0 mt-0.5">
                    <Bot className="h-[18px] w-[18px] text-primary" />
                  </div>
                ) : null}
                <div
                  className={cn(
                    "rounded-2xl px-3.5 py-2.5 max-w-[85%] md:max-w-[75%] min-w-0",
                    m.role === "user"
                      ? "bg-primary text-primary-foreground rounded-br-md"
                      : m.error
                        ? "bg-destructive/10 border border-destructive/30 rounded-bl-md"
                        : "bg-muted rounded-bl-md"
                  )}
                >
                  {m.role === "user" ? (
                    <p className="text-sm whitespace-pre-wrap break-words">
                      {m.content}
                    </p>
                  ) : m.error ? (
                    <p className="text-sm text-destructive flex items-start gap-2 break-words">
                      <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                      <span>{m.content}</span>
                    </p>
                  ) : (
                    <div className="text-sm min-w-0 break-words [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
                      {/* GFM (tabel/coret/task list) + blok kode dengan tombol
                       * salin — komponen memo: streaming tidak me-render
                       * ulang seluruh riwayat. */}
                      <AiMarkdown content={m.content} streaming={!!m.streaming} />
                    </div>
                  )}
                  {m.streaming && !m.content ? (
                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground py-1">
                      <span className="inline-flex gap-1">
                        <Dot delay="0ms" />
                        <Dot delay="150ms" />
                        <Dot delay="300ms" />
                      </span>
                      Teman AI sedang mengetik…
                    </div>
                  ) : null}
                  {m.stopped && m.content ? (
                    <p className="text-[11px] text-muted-foreground mt-1">
                      dihentikan — potongan tersimpan
                    </p>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Input */}
      <div className="border-t border-border px-4 md:px-6 py-3 shrink-0">
        <div className="max-w-3xl mx-auto flex items-end gap-2">
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={
              active
                ? "Tulis pertanyaanmu… (Enter kirim, Shift+Enter baris baru)"
                : "Pasang API key dulu di Pengaturan untuk mulai mengobrol…"
            }
            rows={1}
            className="max-h-40 min-h-[44px] resize-none"
          />
          {streaming ? (
            <Button
              variant="destructive"
              size="icon"
              className="h-11 w-11 shrink-0"
              onClick={stop}
              title="Hentikan jawaban"
              aria-label="Hentikan jawaban"
            >
              <Square className="h-4 w-4" />
            </Button>
          ) : (
            <Button
              size="icon"
              className="h-11 w-11 shrink-0"
              onClick={() => void send()}
              disabled={!input.trim()}
              title="Kirim"
              aria-label="Kirim"
            >
              <Send className="h-4 w-4" />
            </Button>
          )}
        </div>
        <p className="max-w-3xl mx-auto text-[11px] text-muted-foreground mt-1.5">
          Teman AI bisa salah — cek jawaban penting ke buku/guru.
          {!active ? " Belum ada AI terpasang — buka Pengaturan atau hubungi admin." : ""}
        </p>
      </div>

      <AiSettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        onSaved={() => {
          void loadSettings();
          void loadHistory();
        }}
      />

      <AlertDialog open={confirmClear} onOpenChange={setConfirmClear}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Bersihkan seluruh riwayat Teman AI?</AlertDialogTitle>
            <AlertDialogDescription>
              Semua percakapanmu dengan Teman AI akan dihapus permanen.
              Tindakan ini tidak bisa dibatalkan.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Batal</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => void clearHistory()}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {streaming ? <Loader2 className="h-4 w-4 animate-spin mr-1.5" /> : null}
              Bersihkan
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function Dot({ delay }: { delay: string }) {
  return (
    <span
      className="inline-block h-1.5 w-1.5 rounded-full bg-muted-foreground/70 animate-bounce"
      style={{ animationDelay: delay }}
    />
  );
}
