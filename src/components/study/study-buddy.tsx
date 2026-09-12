"use client";

// src/components/study/study-buddy.tsx
//
// "Teman Belajar AI" (tab Teman AI di Pusat Belajar) — tanya-jawab
// materi dengan konteks MATERI bersama.
//
// Perubahan arsitektur besar (menyusul masukan user):
//   1. Provider AI kini SAMA dengan Teman AI di menu utama — diprokses
//      server lewat /api/ai/study: kunci sendiri (BYOK, terenkripsi di
//      server) → default admin → preset custom. Tidak ada lagi panggilan
//      langsung dari browser dengan key di localStorage, dan tidak ada
//      lagi "mode lokal" yang mengarang jawaban.
//   2. Kolom materi memakai useStudyMaterial — SATU sumber bersama dengan
//      tab Alat Materi (sinkron real-time dua arah), plus tombol "Buat
//      dengan AI" yang hasilnya langsung masuk ke kolom materi.
//
// Persistensi chat: localStorage "aula-study:buddy-chat" (maks 100).
// Kontrak ekspor: `export function StudyBuddy()` — dipanggil study-hub.tsx.

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { toast } from "sonner";
import {
  AlertTriangle,
  BookOpenText,
  Copy,
  Eraser,
  KeyRound,
  Settings,
  Sparkles,
  Trash2,
  Wand2,
  Send,
  Square,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { AiMarkdown } from "@/components/ai/ai-markdown";
import {
  AiSettingsDialog,
  fetchAiSettings,
  type AiSettingsData,
} from "@/components/ai/ai-settings-dialog";
import { MaterialAiDialog } from "@/components/study/material-ai-dialog";
import { loadJSON, saveJSON } from "@/lib/study/store";
import { useStudyMaterial } from "@/lib/study/use-study-material";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Tipe & konstanta
// ---------------------------------------------------------------------------

interface ChatMsg {
  role: "user" | "assistant";
  content: string;
  /** ISO string waktu pesan dibuat. */
  at: string;
  /** True saat masih streaming (belum dikomit ke riwayat). */
  streaming?: boolean;
  /** True bila pesan ini pesan error (bukan jawaban AI). */
  error?: boolean;
}

const CHAT_KEY = "aula-study:buddy-chat";
/** Key config AI lama (arsitektur browser langsung) — sudah tidak dipakai. */
const LEGACY_CONFIG_KEY = "aula-study:ai-config";
/** Key materi lama milik panel ini — sudah dimigrasi useStudyMaterial. */

const MAX_CHAT = 100; // maks pesan tersimpan
const MAX_HISTORY = 12; // maks pesan dikirim sebagai konteks

const QUICK_PROMPTS = [
  "Jelaskan materi ini seperti aku 12 tahun",
  "Apa 3 poin terpenting dari materi?",
  "Buat 5 pertanyaan latihan dari materi",
  "Buat analogi sederhana untuk materi ini",
];

// ---------------------------------------------------------------------------
// Util
// ---------------------------------------------------------------------------

function sanitizeChat(raw: unknown): ChatMsg[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (m): m is ChatMsg =>
        !!m &&
        typeof m === "object" &&
        ((m as ChatMsg).role === "user" || (m as ChatMsg).role === "assistant") &&
        typeof (m as ChatMsg).content === "string" &&
        typeof (m as ChatMsg).at === "string"
    )
    .map((m) => ({ role: m.role, content: m.content, at: m.at }))
    .slice(-MAX_CHAT);
}

function fmtTime(at: string): string {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" });
}

/** Index pesan streaming TERAKHIR dalam daftar chat (-1 bila tidak ada). */
function lastStreamingIndex(chat: ChatMsg[]): number {
  for (let i = chat.length - 1; i >= 0; i--) {
    if (chat[i].streaming) return i;
  }
  return -1;
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback untuk konteks non-secure (bukan https/localhost)
    try {
      const el = document.createElement("textarea");
      el.value = text;
      el.style.position = "fixed";
      el.style.opacity = "0";
      document.body.appendChild(el);
      el.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(el);
      return ok;
    } catch {
      return false;
    }
  }
}

/** Baca stream NDJSON /api/ai/study; onChunk dipanggil per potongan. */
async function readStudyStream(
  res: Response,
  onChunk: (full: string, delta: string) => void
): Promise<{ full: string; error: string | null }> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let got = "";
  let errMsg: string | null = null;
  let aborted = false;
  try {
    readLoop: while (true) {
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
          onChunk(got, ev.text);
        } else if (ev.type === "error") {
          errMsg = ev.message ?? "Terjadi error.";
          break readLoop;
        }
      }
    }
  } catch {
    aborted = true; // koneksi terputus / dibatalkan
  }
  return { full: got, error: errMsg ?? (aborted && !got ? "Koneksi terputus." : null) };
}

// ---------------------------------------------------------------------------
// Komponen utama
// ---------------------------------------------------------------------------

export function StudyBuddy() {
  // --- materi bersama (sinkron dengan Alat Materi) ---
  const { material, setMaterial, loaded: materialLoaded } = useStudyMaterial();

  // --- chat persist ---
  const [chat, setChat] = useState<ChatMsg[]>([]);
  const [chatLoaded, setChatLoaded] = useState(false);

  // --- state UI ---
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [settings, setSettings] = useState<AiSettingsData | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [genOpen, setGenOpen] = useState(false);

  // --- refs ---
  const loadedRef = useRef(false);
  const stickRef = useRef(true); // user berada di dekat bawah?
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const active = settings?.active ?? null;

  const loadSettings = useCallback(async () => {
    const d = await fetchAiSettings();
    setSettings(d);
    return d;
  }, []);

  // --- muat data tersimpan (client only, aman dari SSR/hydration) ---
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- data client-only (localStorage): efek memang satu-satunya tempat aman load tanpa hydration mismatch (pola yang sama dengan komponen study lain).
    setChat(sanitizeChat(loadJSON<unknown>(CHAT_KEY, [])));
    setChatLoaded(true);
    loadedRef.current = true;
    // Config AI lama (key di localStorage) tidak dipakai lagi — bersihkan.
    try {
      window.localStorage.removeItem(LEGACY_CONFIG_KEY);
    } catch {
      /* abaikan */
    }
    void loadSettings();
  }, [loadSettings]);

  // --- persist chat (maks 100 terakhir) ---
  useEffect(() => {
    if (!chatLoaded) return;
    saveJSON(CHAT_KEY, chat.slice(-MAX_CHAT));
  }, [chat, chatLoaded]);

  // --- auto-scroll ke bawah saat pesan baru (hanya bila user "menempel" di bawah) ---
  function onScrollList() {
    const el = scrollRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickRef.current = distance < 120;
  }

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [chat, busy]);

  // --- textarea input auto-resize ---
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [input]);

  // --- badge provider (seperti Teman AI) ---
  const providerBadge = useMemo(() => {
    if (!active) return "Belum ada AI terpasang";
    return active.source === "user" ? "kunci sendiri" : "default admin";
  }, [active]);

  // --- aksi chat ---
  function patchStreaming(content: string, isError = false) {
    setChat((prev) => {
      // Ubah pesan streaming terakhir (selalu di akhir saat busy).
      const idx = lastStreamingIndex(prev);
      if (idx < 0) return prev;
      const next = [...prev];
      next[idx] = { ...next[idx], content, error: isError };
      return next;
    });
  }

  function commitStreaming(patch: Partial<ChatMsg>) {
    setChat((prev) => {
      const idx = lastStreamingIndex(prev);
      if (idx < 0) return prev;
      const next = [...prev];
      next[idx] = { ...next[idx], streaming: false, ...patch };
      return next;
    });
  }

  async function ask(raw: string) {
    const question = raw.trim();
    if (!question || busy) return;

    const userMsg: ChatMsg = { role: "user", content: question, at: new Date().toISOString() };
    const history = [...chat, userMsg]
      .slice(-MAX_HISTORY)
      .map((m) => ({ role: m.role, content: m.content }));

    setChat((prev) => [
      ...prev,
      userMsg,
      {
        role: "assistant",
        content: "",
        at: new Date().toISOString(),
        streaming: true,
      },
    ]);
    setInput("");
    setBusy(true);
    stickRef.current = true;

    const ac = new AbortController();
    abortRef.current = ac;

    try {
      const res = await fetch("/api/ai/study", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: question,
          task: "chat",
          material: material.slice(0, 12_000),
          history,
        }),
        signal: ac.signal,
      });

      if (!res.ok || !res.body) {
        const json = await res.json().catch(() => null);
        throw new Error(json?.error ?? `Gagal menghubungi server (HTTP ${res.status}).`);
      }

      const { full, error } = await readStudyStream(res, (fullText) => {
        patchStreaming(fullText);
      });

      if (error && !full.trim()) {
        commitStreaming({ content: error, error: true });
      } else if (error) {
        commitStreaming({ content: `${full}\n\n---\n\n⚠️ ${error}` });
      } else if (full.trim()) {
        commitStreaming({ content: full });
      } else if (ac.signal.aborted) {
        commitStreaming({ content: "_(dihentikan)_" });
      } else {
        commitStreaming({ content: "_(tidak ada jawaban)_" });
      }
    } catch (err) {
      if (ac.signal.aborted) {
        commitStreaming({ content: "_(dihentikan)_" });
      } else {
        commitStreaming({ content: (err as Error)?.message ?? "Koneksi gagal. Coba lagi.", error: true });
      }
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  }

  function stop() {
    abortRef.current?.abort();
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      ask(input);
    }
  }

  function clearChat() {
    setConfirmClear(false);
    if (!chat.length) return;
    setChat([]);
    toast.success("Percakapan & ingatan AI dihapus");
  }

  function clearMaterial() {
    if (!material) return;
    setMaterial("");
    toast.success("Materi dibersihkan");
  }

  async function copyAnswer(m: ChatMsg) {
    const ok = await copyText(m.content);
    if (ok) toast.success("Jawaban disalin ke clipboard");
    else toast.error("Gagal menyalin — coba pilih teksnya secara manual");
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <div className="flex h-full min-h-[560px] flex-col gap-3">
      {/* ===== Panel materi (atas) — SATU sumber dengan Alat Materi ===== */}
      <section className="rounded-xl border bg-card p-3 shadow-xs">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <BookOpenText className="size-4 shrink-0 text-primary" />
            <p className="truncate text-sm font-semibold">Materi pelajaran</p>
            <span className="hidden truncate text-xs text-muted-foreground sm:inline">
              — jadi konteks jawaban AI
            </span>
            <Badge variant="outline" className="hidden shrink-0 gap-1 text-[10px] sm:inline-flex">
              <Sparkles className="size-2.5" /> sync dengan Alat Materi
            </Badge>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <span className="text-[11px] tabular-nums text-muted-foreground">
              {material.length.toLocaleString("id-ID")} karakter
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setGenOpen(true)}
              disabled={!active}
              title={active ? "Buat materi dengan AI" : "Pasang AI dulu di pengaturan"}
            >
              <Wand2 />
              <span className="hidden sm:inline">Buat dengan AI</span>
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={clearMaterial}
              disabled={!material}
              title="Bersihkan materi"
            >
              <Eraser />
              <span className="hidden lg:inline">Bersihkan</span>
            </Button>
          </div>
        </div>
        <Textarea
          value={material}
          onChange={(e) => setMaterial(e.target.value)}
          placeholder={
            materialLoaded
              ? "Tempel materi pelajaranmu di sini — atau minta AI membuatnya…"
              : "Memuat…"
          }
          className="mt-2 min-h-24 max-h-56 text-sm"
          aria-label="Materi pelajaran sebagai konteks AI"
        />
        {material.length > 12_000 && (
          <p className="mt-1 text-[11px] text-amber-600 dark:text-amber-400">
            Materi panjang — AI membaca maksimal 12.000 karakter pertama.
          </p>
        )}
      </section>

      {/* ===== Panel chat ===== */}
      <section className="flex min-h-0 flex-1 flex-col rounded-xl border bg-card shadow-xs">
        {/* Header chat */}
        <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
          <div className="flex min-w-0 items-center gap-2">
            <Sparkles className="size-4 shrink-0 text-primary" />
            <p className="truncate text-sm font-semibold">Teman Belajar AI</p>
            {active ? (
              <>
                <Badge variant="secondary" className="max-w-[220px] truncate">
                  {providerBadge} · {active.model || "model default"}
                </Badge>
                {active.source === "user" ? (
                  <Badge className="hidden gap-1 sm:inline-flex">
                    <KeyRound className="size-3" /> kunci sendiri
                  </Badge>
                ) : null}
              </>
            ) : (
              <Badge variant="outline" className="text-amber-600 dark:text-amber-400">
                belum ada AI
              </Badge>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setConfirmClear(true)}
              disabled={!chat.length}
              title="Hapus percakapan & ingatan"
            >
              <Trash2 />
              <span className="hidden sm:inline">Hapus percakapan</span>
            </Button>
            <Button
              variant="outline"
              size="icon"
              onClick={() => setSettingsOpen(true)}
              title="Pengaturan AI (sama dengan Teman AI)"
              aria-label="Pengaturan AI"
            >
              <Settings />
            </Button>
          </div>
        </div>

        {/* Daftar pesan */}
        <div
          ref={scrollRef}
          onScroll={onScrollList}
          role="log"
          aria-live="polite"
          className="min-h-0 flex-1 space-y-2.5 overflow-y-auto px-3 py-3"
        >
          {chat.length === 0 && !busy ? (
            <div className="flex h-full flex-col items-center justify-center gap-4 py-8 text-center">
              <div className="rounded-full bg-primary/10 p-4">
                <Sparkles className="size-7 text-primary" />
              </div>
              <div>
                <p className="font-semibold">Tanya apa saja tentang materimu</p>
                <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
                  {active
                    ? "Tempel materi di panel atas (atau minta AI membuatnya), lalu ajukan pertanyaan — atau mulai dari pertanyaan cepat ini:"
                    : "Pasang API key sendiri di Pengaturan, atau minta admin mengatur default — lalu ajukan pertanyaanmu:"}
                </p>
              </div>
              {active ? (
                <div className="flex max-w-lg flex-wrap justify-center gap-2">
                  {QUICK_PROMPTS.map((p) => (
                    <Button
                      key={p}
                      variant="outline"
                      size="sm"
                      className="rounded-full"
                      onClick={() => ask(p)}
                    >
                      {p}
                    </Button>
                  ))}
                </div>
              ) : (
                <Button variant="outline" className="gap-1.5" onClick={() => setSettingsOpen(true)}>
                  <KeyRound className="h-4 w-4" /> Pasang API key sendiri
                </Button>
              )}
            </div>
          ) : (
            chat.map((m, i) => (
              <div
                key={`${m.at}-${i}`}
                className={cn(
                  "group/msg flex flex-col",
                  m.role === "user" ? "items-end" : "items-start"
                )}
              >
                <div
                  onClick={m.role === "assistant" && !m.streaming ? () => copyAnswer(m) : undefined}
                  title={
                    m.role === "assistant" && !m.streaming
                      ? "Klik untuk menyalin jawaban"
                      : undefined
                  }
                  className={cn(
                    "max-w-[85%] break-words rounded-2xl px-3.5 py-2.5 text-sm md:max-w-[75%]",
                    m.role === "user"
                      ? "whitespace-pre-wrap rounded-br-sm bg-primary text-primary-foreground"
                      : m.error
                        ? "cursor-pointer rounded-bl-sm border border-destructive/30 bg-destructive/10 text-destructive"
                        : "cursor-pointer rounded-bl-sm bg-muted transition-colors hover:bg-muted/70"
                  )}
                >
                  {m.role === "user" ? (
                    m.content
                  ) : m.error ? (
                    <span className="flex items-start gap-2">
                      <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                      <span>{m.content}</span>
                    </span>
                  ) : m.content ? (
                    <div className="min-w-0 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
                      <AiMarkdown content={m.content} streaming={!!m.streaming} />
                    </div>
                  ) : (
                    <span className="flex items-center gap-2 py-0.5 text-muted-foreground">
                      <span className="text-sm">Menyusun jawaban</span>
                      <span className="flex gap-1" aria-hidden="true">
                        {[0, 150, 300].map((delay) => (
                          <span
                            key={delay}
                            className="size-1.5 animate-bounce rounded-full bg-muted-foreground"
                            style={{ animationDelay: `${delay}ms` }}
                          />
                        ))}
                      </span>
                    </span>
                  )}
                </div>
                <div
                  className={cn(
                    "flex items-center gap-1.5 px-1 pt-0.5 text-[10px] text-muted-foreground opacity-0 transition-opacity group-hover/msg:opacity-100",
                    m.role === "user" ? "flex-row-reverse" : "flex-row"
                  )}
                >
                  <span className="tabular-nums">{fmtTime(m.at)}</span>
                  {m.role === "assistant" && !m.streaming && (
                    <button
                      type="button"
                      onClick={() => copyAnswer(m)}
                      className="inline-flex items-center gap-0.5 rounded px-1 py-0.5 hover:text-foreground"
                    >
                      <Copy className="size-3" />
                      salin
                    </button>
                  )}
                </div>
              </div>
            ))
          )}
        </div>

        {/* Input */}
        <div className="border-t p-2">
          <div className="flex items-end gap-2">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              rows={1}
              disabled={busy}
              placeholder={
                active
                  ? "Tulis pertanyaanmu…"
                  : "Pasang API key dulu di Pengaturan (ikon roda gigi)…"
              }
              aria-label="Tulis pertanyaan untuk Teman Belajar"
              className="max-h-40 min-h-[2.4rem] w-full resize-none rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none transition-[color,box-shadow] placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
            />
            {busy ? (
              <Button
                variant="destructive"
                size="icon"
                onClick={stop}
                aria-label="Hentikan jawaban"
                className="h-[2.4rem] w-[2.4rem] shrink-0"
              >
                <Square />
              </Button>
            ) : (
              <Button
                size="icon"
                onClick={() => ask(input)}
                disabled={!input.trim()}
                aria-label="Kirim pertanyaan"
                className="h-[2.4rem] w-[2.4rem] shrink-0"
              >
                <Send />
              </Button>
            )}
          </div>
          <p className="mt-1 px-1 text-[11px] text-muted-foreground">
            Enter kirim · Shift+Enter baris baru — klik jawaban AI untuk menyalinnya.
          </p>
        </div>
      </section>

      {/* ===== Dialog: pengaturan AI (komponen sama dengan Teman AI) ===== */}
      <AiSettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        onSaved={() => {
          void loadSettings();
        }}
      />

      {/* ===== Dialog: buat materi dengan AI ===== */}
      <MaterialAiDialog
        open={genOpen}
        onOpenChange={setGenOpen}
        hasExisting={material.trim().length > 0}
        currentMaterial={material}
        setMaterial={setMaterial}
        disabled={!active}
      />

      {/* Konfirmasi hapus percakapan — localStorage ikut dikosongkan via
          effect persist, jadi ingatan AI benar-benar terhapus. */}
      <AlertDialog open={confirmClear} onOpenChange={setConfirmClear}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Hapus percakapan & ingatan AI?</AlertDialogTitle>
            <AlertDialogDescription>
              Seluruh obrolan di panel ini akan dihapus permanen, termasuk
              ingatan Teman Belajar tentang obrolanmu sebelumnya. Materi yang
              kamu tempel tetap disimpan. Tindakan ini tidak bisa dibatalkan.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Batal</AlertDialogCancel>
            <AlertDialogAction
              onClick={clearChat}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Hapus permanen
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
