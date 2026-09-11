"use client";

// src/components/study/study-buddy.tsx
//
// "Teman Belajar AI" — asisten tanya-jawab materi, satu layar.
//
// Arsitektur anti-biaya (deploy di Vercel milik user, TIDAK ada server AI):
//   1. MODE LOKAL (default): jawaban disusun mesin lokal di browser
//      (src/lib/study/local-ai.ts) — gratis, tanpa limit, tanpa internet.
//   2. BYOK (bring your own key): user menempel API key miliknya sendiri
//      (Gemini / OpenAI-compatible seperti OpenRouter). Key HANYA disimpan di
//      localStorage browser user, dan panggilan API dilakukan LANGSUNG dari
//      browser ke provider — tidak melewati server aplikasi sama sekali.
//   3. FALLBACK: bila provider eksternal error/timeout/non-OK, jawaban
//      otomatis dialihkan ke mesin lokal (dengan prefix "(mode lokal)").
//
// Kontrak ekspor: `export function StudyBuddy()` — dipanggil study-hub.tsx.
// Persistensi via "@/lib/study/store" (loadJSON/saveJSON).

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { toast } from "sonner";
import {
  BookOpenText,
  Copy,
  Eraser,
  Loader2,
  PlugZap,
  Send,
  Settings,
  Sparkles,
  Trash2,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { answerLocally } from "@/lib/study/local-ai";
import { loadJSON, saveJSON } from "@/lib/study/store";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Tipe & konstanta
// ---------------------------------------------------------------------------

type ChatRole = "user" | "assistant";

interface ChatMsg {
  role: ChatRole;
  content: string;
  /** ISO string waktu pesan dibuat. */
  at: string;
}

type AIProvider = "local" | "gemini" | "openai";

interface AIConfig {
  provider: AIProvider;
  apiKey: string;
  model: string;
  baseUrl: string;
}

const MATERIAL_KEY = "aula-study:buddy-material";
const CHAT_KEY = "aula-study:buddy-chat";
const CONFIG_KEY = "aula-study:ai-config";

const MAX_CHAT = 100; // maks pesan tersimpan
const MAX_HISTORY = 12; // maks pesan dikirim sebagai konteks
const MAX_MATERIAL_CONTEXT = 12_000; // potong materi untuk system prompt
const FETCH_TIMEOUT_MS = 30_000;

const DEFAULT_CONFIG: AIConfig = {
  provider: "local",
  apiKey: "",
  model: "gemini-2.0-flash",
  baseUrl: "https://api.openai.com/v1",
};

const QUICK_PROMPTS = [
  "Jelaskan materi ini seperti aku 12 tahun",
  "Apa 3 poin terpenting dari materi?",
  "Buat 5 pertanyaan latihan dari materi",
  "Buat analogi sederhana untuk materi ini",
];

const BASE_SYSTEM_PROMPT = [
  'Kamu adalah "Teman Belajar" — asisten belajar yang sabar, hangat, dan memotivasi untuk siswa Indonesia.',
  "- Menjelaskan bertahap dengan bahasa sederhana, memakai contoh dan analogi sehari-hari.",
  "- Jika ada MATERI di bawah, utamakan menjawab dari materi itu dan kutip bagian yang relevan.",
  "- Jika ditanya di luar materi, tetap bantu dengan hati-hati.",
  "- Akui bila tidak yakin — jangan mengarang.",
  "- Dorong siswa berpikir sendiri: beri satu pertanyaan pemantik kecil di akhir bila cocok.",
  "Jawab ringkas dan terstruktur (poin-poin), dalam Bahasa Indonesia.",
].join("\n");

const PROVIDER_LABEL: Record<AIProvider, string> = {
  local: "Mode lokal",
  gemini: "Gemini",
  openai: "OpenAI-compatible",
};

// Respons (hanya bentuk yang dipakai) — dipanggil langsung dari browser.
interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
}
interface OpenAIResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

// ---------------------------------------------------------------------------
// Util
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizeConfig(raw: unknown): AIConfig {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_CONFIG };
  const c = raw as Partial<AIConfig>;
  const provider: AIProvider =
    c.provider === "gemini" || c.provider === "openai" ? c.provider : "local";
  const fallbackModel = provider === "openai" ? "gpt-4o-mini" : DEFAULT_CONFIG.model;
  return {
    provider,
    apiKey: typeof c.apiKey === "string" ? c.apiKey : "",
    model: typeof c.model === "string" && c.model.trim() ? c.model : fallbackModel,
    baseUrl:
      typeof c.baseUrl === "string" && c.baseUrl.trim() ? c.baseUrl : DEFAULT_CONFIG.baseUrl,
  };
}

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
    .slice(-MAX_CHAT);
}

function fmtTime(at: string): string {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" });
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

/**
 * Satu pintu panggilan AI eksternal (dipakai ask() dan "Uji koneksi").
 * Fetch LANGSUNG dari browser ke provider dengan AbortController timeout.
 * Melempar Error dengan pesan Indonesia — pemanggil yang menangani fallback.
 */
async function callProvider(
  cfg: AIConfig,
  system: string,
  history: ChatMsg[],
  timeoutMs: number = FETCH_TIMEOUT_MS
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    if (cfg.provider === "gemini") {
      const model = cfg.model.trim() || "gemini-2.0-flash";
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
        model
      )}:generateContent?key=${encodeURIComponent(cfg.apiKey)}`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: history.map((m) => ({
            role: m.role === "assistant" ? "model" : "user",
            parts: [{ text: m.content }],
          })),
        }),
      });
      if (!res.ok) {
        if (res.status === 429) {
          throw new Error(
            "Kuota API Gemini habis sementara — coba lagi nanti atau pakai mode lokal"
          );
        }
        const detail = await res.text().catch(() => "");
        throw new Error(`Gemini menjawab ${res.status}: ${detail.slice(0, 160)}`);
      }
      const data = (await res.json()) as GeminiResponse;
      const answer = (data.candidates?.[0]?.content?.parts ?? [])
        .map((p) => p.text ?? "")
        .join("")
        .trim();
      if (!answer) throw new Error("Gemini tidak mengirim jawaban (kosong)");
      return answer;
    }

    if (cfg.provider === "openai") {
      const base = (cfg.baseUrl.trim() || "https://api.openai.com/v1").replace(/\/+$/, "");
      const res = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${cfg.apiKey}`,
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: cfg.model.trim() || "gpt-4o-mini",
          messages: [
            { role: "system", content: system },
            ...history.map((m) => ({ role: m.role, content: m.content })),
          ],
        }),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(`Provider menjawab ${res.status}: ${detail.slice(0, 160)}`);
      }
      const data = (await res.json()) as OpenAIResponse;
      const answer = data.choices?.[0]?.message?.content?.trim() ?? "";
      if (!answer) throw new Error("Provider tidak mengirim jawaban (kosong)");
      return answer;
    }

    throw new Error("Provider tidak dikenal");
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(
        `Waktu tunggu ${Math.round(timeoutMs / 1000)} detik habis — koneksi terlalu lambat`
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Komponen
// ---------------------------------------------------------------------------

export function StudyBuddy() {
  // --- state persist ---
  const [material, setMaterial] = useState("");
  const [chat, setChat] = useState<ChatMsg[]>([]);
  const [config, setConfig] = useState<AIConfig>({ ...DEFAULT_CONFIG });

  // --- state UI ---
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  const [draft, setDraft] = useState<AIConfig>({ ...DEFAULT_CONFIG });
  const [testing, setTesting] = useState(false);

  // --- refs ---
  const loadedRef = useRef(false);
  const stickRef = useRef(true); // user berada di dekat bawah?
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const warnedFallbackRef = useRef(false); // toast.warning fallback cukup sekali

  // --- muat data tersimpan (client only, aman dari SSR/hydration) ---
  useEffect(() => {
    setMaterial(loadJSON<string>(MATERIAL_KEY, ""));
    setChat(sanitizeChat(loadJSON<unknown>(CHAT_KEY, [])));
    setConfig(sanitizeConfig(loadJSON<unknown>(CONFIG_KEY, null)));
    loadedRef.current = true;
  }, []);

  // --- persist materi (debounce 500ms) ---
  useEffect(() => {
    if (!loadedRef.current) return;
    const t = setTimeout(() => saveJSON(MATERIAL_KEY, material), 500);
    return () => clearTimeout(t);
  }, [material]);

  // --- persist chat (maks 100 terakhir) ---
  useEffect(() => {
    if (!loadedRef.current) return;
    saveJSON(CHAT_KEY, chat.slice(-MAX_CHAT));
  }, [chat]);

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

  // --- system prompt: instruksi + materi (dipotong) ---
  const systemPrompt = useMemo(() => {
    const mat = material.trim();
    return mat
      ? `${BASE_SYSTEM_PROMPT}\n\n=== MATERI ===\n${mat.slice(0, MAX_MATERIAL_CONTEXT)}`
      : BASE_SYSTEM_PROMPT;
  }, [material]);

  const providerBadge = useMemo(() => {
    if (config.provider === "local") return "Mode lokal · 0 biaya · 0 limit";
    if (!config.apiKey.trim()) return `${PROVIDER_LABEL[config.provider]} — key belum diisi`;
    return `${PROVIDER_LABEL[config.provider]} · API key sendiri`;
  }, [config]);

  // --- aksi chat ---
  function pushAssistant(content: string) {
    setChat((prev) =>
      [...prev, { role: "assistant", content, at: new Date().toISOString() }].slice(-MAX_CHAT)
    );
  }

  async function ask(raw: string) {
    const question = raw.trim();
    if (!question || busy) return;

    const userMsg: ChatMsg = { role: "user", content: question, at: new Date().toISOString() };
    const history = [...chat, userMsg].slice(-MAX_HISTORY);

    setChat((prev) => [...prev, userMsg].slice(-MAX_CHAT));
    setInput("");
    setBusy(true);

    try {
      // Mode lokal: mesin di browser, tanpa internet.
      if (config.provider === "local") {
        await sleep(400 + Math.random() * 500); // jeda kecil biar terasa "menyusun"
        pushAssistant(answerLocally(question, material));
        return;
      }

      if (!config.apiKey.trim()) {
        throw new Error("API key belum diisi — buka Pengaturan AI (ikon roda gigi)");
      }

      const answer = await callProvider(config, systemPrompt, history);
      pushAssistant(answer);
    } catch (err) {
      // Fallback: AI eksternal gagal (error/timeout/non-OK) -> mode lokal.
      const reason = err instanceof Error ? err.message : "Kesalahan tidak diketahui";
      pushAssistant(`(mode lokal) ${answerLocally(question, material)}`);
      if (!warnedFallbackRef.current) {
        warnedFallbackRef.current = true;
        toast.warning("AI eksternal tidak merespons — jawaban dari mode lokal", {
          description: reason,
        });
      }
    } finally {
      setBusy(false);
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      ask(input);
    }
  }

  function clearChat() {
    if (!chat.length) return;
    setChat([]);
    toast.success("Percakapan dibersihkan");
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

  // --- pengaturan AI ---
  function openSettings() {
    setDraft({ ...config });
    setConfigOpen(true);
  }

  function changeProvider(value: string) {
    const provider = value as AIProvider;
    setDraft((d) => {
      let model = d.model.trim();
      if (provider === "gemini" && (!model || model === "gpt-4o-mini")) {
        model = "gemini-2.0-flash";
      }
      if (provider === "openai" && (!model || model === "gemini-2.0-flash")) {
        model = "gpt-4o-mini";
      }
      return { ...d, provider, model };
    });
  }

  function saveConfig() {
    const next = sanitizeConfig(draft);
    if (next.provider === "openai" && !/^https?:\/\//i.test(next.baseUrl)) {
      toast.error("Base URL harus diawali http(s):// — contoh: https://openrouter.ai/api/v1");
      return;
    }
    setConfig(next);
    saveJSON(CONFIG_KEY, next);
    warnedFallbackRef.current = false; // beri kesempatan warning baru setelah config baru
    setConfigOpen(false);
    toast.success(
      next.provider === "local"
        ? "Tersimpan — mode lokal aktif (0 biaya, 0 limit)"
        : `Tersimpan — mode ${PROVIDER_LABEL[next.provider]} dengan API key milikmu`
    );
  }

  async function testConnection() {
    if (draft.provider === "local") {
      toast.success("Mode lokal aktif — tidak perlu koneksi internet, selalu siap.");
      return;
    }
    if (!draft.apiKey.trim()) {
      toast.error("Tempel dulu API key-mu di atas.");
      return;
    }
    setTesting(true);
    try {
      const reply = await callProvider(
        sanitizeConfig(draft),
        "Balas HANYA dengan satu kata: pong",
        [{ role: "user", content: "ping", at: new Date().toISOString() }],
        15_000
      );
      toast.success(`Koneksi berhasil — balasan: "${reply.slice(0, 60)}"`);
    } catch (err) {
      toast.error("Koneksi gagal", {
        description: err instanceof Error ? err.message : "Kesalahan tidak diketahui",
      });
    } finally {
      setTesting(false);
    }
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <div className="flex h-full min-h-[560px] flex-col gap-3">
      {/* ===== Panel materi (atas) ===== */}
      <section className="rounded-xl border bg-card p-3 shadow-xs">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <BookOpenText className="size-4 shrink-0 text-primary" />
            <p className="truncate text-sm font-semibold">Materi pelajaran</p>
            <span className="hidden truncate text-xs text-muted-foreground sm:inline">
              — jadi konteks jawaban AI
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <span className="text-[11px] tabular-nums text-muted-foreground">
              {material.length.toLocaleString("id-ID")} karakter
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={clearMaterial}
              disabled={!material}
              title="Bersihkan materi"
            >
              <Eraser />
              <span className="hidden sm:inline">Bersihkan</span>
            </Button>
          </div>
        </div>
        <Textarea
          value={material}
          onChange={(e) => setMaterial(e.target.value)}
          placeholder="Tempel materi pelajaranmu di sini…"
          className="mt-2 min-h-24 max-h-56 text-sm"
          aria-label="Materi pelajaran sebagai konteks AI"
        />
        {material.length > MAX_MATERIAL_CONTEXT && (
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
            <Badge
              variant="secondary"
              className={cn(
                "max-w-[240px] truncate",
                config.provider !== "local" &&
                  !config.apiKey.trim() &&
                  "text-amber-600 dark:text-amber-400"
              )}
            >
              {providerBadge}
            </Badge>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={clearChat}
              disabled={!chat.length}
              title="Bersihkan percakapan"
            >
              <Trash2 />
              <span className="hidden sm:inline">Bersihkan percakapan</span>
            </Button>
            <Button
              variant="outline"
              size="icon"
              onClick={openSettings}
              title="Pengaturan AI"
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
                  Tempel materi pelajaranmu di panel atas, lalu ajukan pertanyaan — atau
                  mulai dari salah satu pertanyaan cepat ini:
                </p>
              </div>
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
                  onClick={m.role === "assistant" ? () => copyAnswer(m) : undefined}
                  title={m.role === "assistant" ? "Klik untuk menyalin jawaban" : undefined}
                  className={cn(
                    "max-w-[85%] whitespace-pre-wrap break-words rounded-2xl px-3.5 py-2.5 text-sm md:max-w-[75%]",
                    m.role === "user"
                      ? "rounded-br-sm bg-primary text-primary-foreground"
                      : "cursor-pointer rounded-bl-sm bg-muted transition-colors hover:bg-muted/70"
                  )}
                >
                  {m.content}
                </div>
                <div
                  className={cn(
                    "flex items-center gap-1.5 px-1 pt-0.5 text-[10px] text-muted-foreground opacity-0 transition-opacity group-hover/msg:opacity-100",
                    m.role === "user" ? "flex-row-reverse" : "flex-row"
                  )}
                >
                  <span className="tabular-nums">{fmtTime(m.at)}</span>
                  {m.role === "assistant" && (
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

          {/* Indikator "Menyusun jawaban…" */}
          {busy && (
            <div className="flex justify-start">
              <div
                className="flex items-center gap-2 rounded-2xl rounded-bl-sm bg-muted px-4 py-3"
                aria-live="polite"
              >
                <span className="text-sm text-muted-foreground">Menyusun jawaban</span>
                <span className="flex gap-1" aria-hidden="true">
                  {[0, 150, 300].map((delay) => (
                    <span
                      key={delay}
                      className="size-1.5 animate-bounce rounded-full bg-muted-foreground"
                      style={{ animationDelay: `${delay}ms` }}
                    />
                  ))}
                </span>
              </div>
            </div>
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
              placeholder="Tulis pertanyaanmu…"
              aria-label="Tulis pertanyaan untuk Teman Belajar"
              className="max-h-40 min-h-[2.4rem] w-full resize-none rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none transition-[color,box-shadow] placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
            />
            <Button
              size="icon"
              onClick={() => ask(input)}
              disabled={busy || !input.trim()}
              aria-label="Kirim pertanyaan"
              className="h-[2.4rem] w-[2.4rem] shrink-0"
            >
              <Send />
            </Button>
          </div>
          <p className="mt-1 px-1 text-[11px] text-muted-foreground">
            Enter kirim · Shift+Enter baris baru — klik jawaban AI untuk menyalinnya.
          </p>
        </div>
      </section>

      {/* ===== Dialog pengaturan AI ===== */}
      <Dialog open={configOpen} onOpenChange={setConfigOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Pengaturan AI</DialogTitle>
            <DialogDescription>
              AI berjalan sepenuhnya di browsermu — tanpa server berbayar, tanpa limit.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4">
            {/* Mode */}
            <div className="grid gap-1.5">
              <Label>Mode</Label>
              <Select value={draft.provider} onValueChange={changeProvider}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Pilih mode AI" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="local">
                    Lokal — tanpa internet (gratis, tanpa limit)
                  </SelectItem>
                  <SelectItem value="gemini">Gemini — API key sendiri</SelectItem>
                  <SelectItem value="openai">
                    OpenAI-compatible — API key sendiri
                  </SelectItem>
                </SelectContent>
              </Select>
              <p className="text-[11px] text-muted-foreground">
                {draft.provider === "local"
                  ? "Mesin lokal menganalisis materimu langsung di browser — tidak ada data yang keluar, selalu gratis."
                  : "Panggilan dilakukan langsung dari browsermu ke provider, memakai key milikmu."}
              </p>
            </div>

            {/* API key */}
            {draft.provider !== "local" && (
              <>
                <div className="grid gap-1.5">
                  <Label htmlFor="ai-key">API key</Label>
                  <Input
                    id="ai-key"
                    type="password"
                    autoComplete="off"
                    placeholder="Tempel API key-mu…"
                    value={draft.apiKey}
                    onChange={(e) => setDraft((d) => ({ ...d, apiKey: e.target.value }))}
                  />
                  <p className="text-[11px] leading-relaxed text-muted-foreground">
                    Key HANYA disimpan di browser ini (localStorage), bukan di server.
                    Gratis daftar di{" "}
                    <span className="font-medium text-foreground">aistudio.google.com</span>{" "}
                    (Gemini) atau{" "}
                    <span className="font-medium text-foreground">openrouter.ai</span>{" "}
                    (OpenRouter punya model gratis).
                  </p>
                </div>

                {/* Model */}
                <div className="grid gap-1.5">
                  <Label htmlFor="ai-model">Model</Label>
                  <Input
                    id="ai-model"
                    placeholder={draft.provider === "gemini" ? "gemini-2.0-flash" : "gpt-4o-mini"}
                    value={draft.model}
                    onChange={(e) => setDraft((d) => ({ ...d, model: e.target.value }))}
                  />
                  <p className="text-[11px] text-muted-foreground">
                    Default: {draft.provider === "gemini" ? "gemini-2.0-flash" : "gpt-4o-mini"}.
                  </p>
                </div>

                {/* Base URL — khusus OpenAI-compatible */}
                {draft.provider === "openai" && (
                  <div className="grid gap-1.5">
                    <Label htmlFor="ai-base">Base URL</Label>
                    <Input
                      id="ai-base"
                      placeholder="https://openrouter.ai/api/v1"
                      value={draft.baseUrl}
                      onChange={(e) => setDraft((d) => ({ ...d, baseUrl: e.target.value }))}
                    />
                    <p className="text-[11px] text-muted-foreground">
                      Default OpenAI: https://api.openai.com/v1 — untuk OpenRouter:
                      https://openrouter.ai/api/v1
                    </p>
                  </div>
                )}
              </>
            )}

            {/* Uji koneksi */}
            <div>
              <Button
                variant="outline"
                size="sm"
                onClick={testConnection}
                disabled={testing}
              >
                {testing ? <Loader2 className="animate-spin" /> : <PlugZap />}
                Uji koneksi
              </Button>
            </div>

            {/* Catatan privasi */}
            <p className="rounded-md border bg-muted/40 p-2 text-[11px] leading-relaxed text-muted-foreground">
              Catatan privasi: API key, materi, dan percakapan hanya tersimpan di browser
              ini. Untuk mode Gemini/OpenAI, permintaan dikirim langsung dari browsermu ke
              provider — tidak melewati server aplikasi. Mode lokal 100% offline.
            </p>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setConfigOpen(false)}>
              Batal
            </Button>
            <Button onClick={saveConfig}>Simpan</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
