"use client";

// ─────────────────────────────────────────────────────────────────────
// AI Builder (Pusat Belajar → tab "AI Builder").
//
// AI yang TUGASNYA MENULIS KODE HTML/CSS/JS untuk siswa: siswa
// menjelaskan aplikasi yang diinginkan (mis. "bikinin platform tes
// kecepatan mengetik"), AI menulis satu dokumen HTML lengkap, lalu
// langsung BISA DIJALANKAN di pratinjau sandbox di sebelahnya.
//
// - Provider DIPISAH dari Teman AI (AppSetting "ai.builder", diatur
//   admin di Admin Panel → tab AI Builder).
// - Pratinjau: iframe sandbox="allow-scripts allow-forms allow-modals
//   allow-pointer-lock" (tanpa allow-same-origin — kode siswa tidak
//   bisa menyentuh sesi/data Aula).
// - Kode ditampilkan terpisah per tab HTML / CSS / JS.
// - Proyek bisa disimpan ke server (BuilderProject) lalu dibuka lagi.
// ─────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { toast } from "sonner";
import {
  Bot,
  Send,
  Square,
  Play,
  Download,
  Save,
  Trash2,
  FolderOpen,
  Loader2,
  Maximize2,
  FileCode2,
  Sparkles,
  Code2,
  Eye,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Tipe & util
// ---------------------------------------------------------------------------

interface ChatMsg {
  role: "user" | "assistant";
  content: string;
  at: string;
  streaming?: boolean;
  error?: boolean;
}

interface ProjectRow {
  id: string;
  title: string;
  description: string | null;
  htmlLength: number;
  updatedAt: string;
}

const EXAMPLES = [
  "Bikin platform tes kecepatan mengetik (kata per menit)",
  "Bikin game ular (snake) dengan skor",
  "Bikin kalkulator lengkap",
  "Bikin kartu belajar huruf hijaiyah",
  "Bikin timer pomodoro dengan suara",
  "Bikin konversi satuan panjang & berat",
];

/** Ambil dokumen HTML dari jawaban AI (buangs pagar markdown kalau ada). */
function extractHtml(raw: string): string {
  let t = raw.trim();
  // Buang code fence ```html ... ``` bila model memakainya.
  const fence = t.match(/```(?:html)?\s*\n([\s\S]*?)```/i);
  if (fence && /<(!doctype|html)/i.test(fence[1])) t = fence[1];
  const start = t.search(/<!doctype html|<html/i);
  if (start > 0) t = t.slice(start);
  const end = t.toLowerCase().lastIndexOf("</html>");
  if (end !== -1) t = t.slice(0, end + 7);
  return t.trim();
}

/** Judul dari <title> dokumen, atau fallback. */
function titleFromHtml(html: string): string | null {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const t = m?.[1]?.trim();
  return t ? t.slice(0, 120) : null;
}

/** Pecah dokumen jadi bagian HTML/CSS/JS utk tab kode (utk dilihat siswa). */
function splitCode(html: string): { htmlPart: string; cssPart: string; jsPart: string } {
  let cssPart = "";
  let jsPart = "";
  let htmlPart = html
    // ambil isi <style> … </style>
    .replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gi, (_m, inner: string) => {
      cssPart += inner.trim() + "\n";
      return "<style>/* lihat tab CSS */</style>";
    })
    // ambil isi <script> … </script> yang TANPA src (script lokal)
    .replace(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi, (_m, inner: string) => {
      jsPart += inner.trim() + "\n";
      return "<script>/* lihat tab JS */</script>";
    });
  htmlPart = htmlPart.replace(/\n{3,}/g, "\n\n").trim();
  return { htmlPart, cssPart: cssPart.trim(), jsPart: jsPart.trim() };
}

function slugTitle(t: string): string {
  return (
    t
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "proyek-ai-builder"
  );
}

/** Baca stream NDJSON /api/ai/builder; onChunk dipanggil per potongan. */
async function readBuilderStream(
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
    aborted = true;
  }
  return { full: got, error: errMsg ?? (aborted && !got ? "Koneksi terputus." : null) };
}

// ---------------------------------------------------------------------------
// Komponen utama
// ---------------------------------------------------------------------------

export function AiBuilder() {
  // ── chat & kode ──
  const [chat, setChat] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const [html, setHtml] = useState("");
  const [previewKey, setPreviewKey] = useState(0); // utk tombol "jalankan ulang"
  const chatEndRef = useRef<HTMLDivElement | null>(null);
  const stickRef = useRef(true);

  // ── panel kanan ──
  const [rightTab, setRightTab] = useState<"preview" | "code">("preview");
  const [fullscreen, setFullscreen] = useState(false);

  // ── proyek tersimpan ──
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [projectsOpen, setProjectsOpen] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveTitle, setSaveTitle] = useState("");
  const [saving, setSaving] = useState(false);
  const [currentProjectId, setCurrentProjectId] = useState<string | null>(null);

  const loadProjects = useCallback(async () => {
    try {
      const res = await fetch("/api/builder/projects", { cache: "no-store" });
      if (!res.ok) return;
      const json = (await res.json()) as { projects: ProjectRow[] };
      setProjects(json.projects ?? []);
    } catch {
      /* diam — daftar proyek opsional */
    }
  }, []);

  function openProjects() {
    void loadProjects();
    setProjectsOpen(true);
  }

  // Auto-scroll chat bila menempel di bawah.
  useEffect(() => {
    if (stickRef.current) chatEndRef.current?.scrollIntoView({ block: "end" });
  }, [chat]);

  const code = useMemo(() => (html ? splitCode(html) : null), [html]);
  const lineCount = useMemo(
    () => (html ? html.split("\n").length : 0),
    [html]
  );

  function patchStreaming(fullText: string) {
    setChat((prev) => {
      const next = [...prev];
      const last = next[next.length - 1];
      if (last?.streaming) last.content = fullText;
      return next;
    });
  }

  function commitStreaming(patch: Partial<ChatMsg>) {
    setChat((prev) => {
      const next = [...prev];
      const last = next[next.length - 1];
      if (last?.streaming) {
        next[next.length - 1] = { ...last, streaming: false, ...patch };
      }
      return next;
    });
  }

  async function ask(raw: string) {
    const message = raw.trim();
    if (!message || busy) return;

    const userMsg: ChatMsg = { role: "user", content: message, at: new Date().toISOString() };
    setChat((prev) => [
      ...prev,
      userMsg,
      { role: "assistant", content: "", at: new Date().toISOString(), streaming: true },
    ]);
    setInput("");
    setBusy(true);
    stickRef.current = true;

    const ac = new AbortController();
    abortRef.current = ac;

    try {
      const res = await fetch("/api/ai/builder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message,
          currentHtml: html || undefined,
        }),
        signal: ac.signal,
      });

      if (!res.ok || !res.body) {
        const json = await res.json().catch(() => null);
        throw new Error(json?.error ?? `Gagal menghubungi server (HTTP ${res.status}).`);
      }

      const { full, error } = await readBuilderStream(res, (fullText) => {
        patchStreaming(fullText);
      });

      const doc = extractHtml(full);
      if (doc && /<html|<!doctype/i.test(doc)) {
        setHtml(doc);
        setPreviewKey((k) => k + 1);
        setRightTab("preview");
        if (!currentProjectId) {
          const t = titleFromHtml(doc);
          if (t) setSaveTitle(t);
        }
        commitStreaming({ content: doc });
      } else if (error) {
        commitStreaming({ content: error, error: true });
      } else if (ac.signal.aborted) {
        commitStreaming({ content: "_(dihentikan)_" });
      } else {
        commitStreaming({
          content: full.trim() || "_(AI tidak mengirim kode — coba lagi)_",
          error: !full.trim(),
        });
      }
    } catch (err) {
      if (ac.signal.aborted) {
        commitStreaming({ content: "_(dihentikan)_" });
      } else {
        commitStreaming({
          content: (err as Error)?.message ?? "Koneksi gagal. Coba lagi.",
          error: true,
        });
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

  function downloadHtml() {
    if (!html) return;
    const blob = new Blob([html], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${slugTitle(saveTitle || titleFromHtml(html) || "proyek")}.html`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    toast.success("File HTML diunduh — bisa dibuka langsung di browser mana pun.");
  }

  async function saveProject() {
    if (!html) return;
    const title = saveTitle.trim() || titleFromHtml(html) || "Proyek AI Builder";
    setSaving(true);
    try {
      const res = await fetch("/api/builder/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: currentProjectId ?? undefined,
          title,
          html,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error || "Gagal menyimpan proyek.");
      toast.success(currentProjectId ? "Proyek diperbarui." : "Proyek tersimpan.");
      setCurrentProjectId(json.id ?? null);
      setSaveTitle(title);
      setSaveOpen(false);
      await loadProjects();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function openProject(id: string) {
    try {
      const res = await fetch(`/api/builder/projects/${id}`, { cache: "no-store" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json?.project?.html) throw new Error(json?.error || "Gagal membuka proyek.");
      const p = json.project as { id: string; title: string; html: string };
      setHtml(p.html);
      setPreviewKey((k) => k + 1);
      setCurrentProjectId(p.id);
      setSaveTitle(p.title);
      setRightTab("preview");
      setProjectsOpen(false);
      setChat((prev) => [
        ...prev,
        {
          role: "user",
          content: `(membuka proyek "${p.title}")`,
          at: new Date().toISOString(),
        },
        {
          role: "assistant",
          content:
            `Proyek "${p.title}" dimuat. Tulis permintaan ubah di bawah — mis. "tambahkan warna" atau "ganti judul jadi …".`,
          at: new Date().toISOString(),
        },
      ]);
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  async function deleteProject(id: string) {
    try {
      const res = await fetch(`/api/builder/projects/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Gagal menghapus proyek.");
      toast.success("Proyek dihapus.");
      if (currentProjectId === id) setCurrentProjectId(null);
      await loadProjects();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  function newProject() {
    setHtml("");
    setCurrentProjectId(null);
    setSaveTitle("");
    setChat([]);
    setRightTab("preview");
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <div className="flex h-full min-h-[600px] flex-col gap-3 lg:flex-row">
      {/* ===== KIRI: percakapan ===== */}
      <section className="flex min-h-[420px] flex-1 flex-col rounded-xl border bg-card shadow-xs">
        <header className="flex items-center gap-2 border-b border-border px-3 py-2.5">
          <div className="flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Bot className="size-4" />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-semibold leading-tight">AI Builder</h3>
            <p className="text-[11px] text-muted-foreground truncate">
              Minta AI menulis aplikasi web (HTML/CSS/JS) — langsung bisa dijalankan.
            </p>
          </div>
          <Button variant="ghost" size="sm" className="h-7 px-2 text-[11px]" onClick={newProject} title="Mulai proyek baru (kosongkan chat & kode)">
            + Baru
          </Button>
        </header>

        <ScrollArea className="flex-1 min-h-0">
          <div className="space-y-3 p-3">
            {chat.length === 0 ? (
              <div className="space-y-3 py-6 text-center">
                <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-primary/10">
                  <Sparkles className="size-5 text-primary" />
                </div>
                <div>
                  <p className="text-sm font-medium">Mau bikin aplikasi apa hari ini?</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Ceritakan idemu — AI menulis kodenya, kamu tinggal tekan jalankan.
                  </p>
                </div>
                <div className="mx-auto flex max-w-md flex-wrap justify-center gap-1.5 pt-1">
                  {EXAMPLES.map((ex) => (
                    <button
                      key={ex}
                      type="button"
                      onClick={() => ask(ex)}
                      className="rounded-full border border-border bg-background px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground"
                    >
                      {ex}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              chat.map((m, i) => <ChatBubble key={i} msg={m} />)
            )}
            <div ref={chatEndRef} />
          </div>
        </ScrollArea>

        <div className="border-t border-border p-2.5">
          <div className="flex items-end gap-2">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              rows={2}
              maxLength={6000}
              disabled={busy}
              placeholder={
                html
                  ? "Mau diubah apa? mis. tambah fitur skor tertinggi…"
                  : "mis. Bikin platform tes kecepatan mengetik…"
              }
              className="max-h-32 min-h-[44px] flex-1 resize-none rounded-lg border border-input bg-background px-3 py-2.5 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-60"
            />
            {busy ? (
              <Button variant="destructive" size="icon" onClick={stop} title="Hentikan">
                <Square className="size-4" />
              </Button>
            ) : (
              <Button size="icon" onClick={() => ask(input)} disabled={!input.trim()} title="Kirim">
                <Send className="size-4" />
              </Button>
            )}
          </div>
        </div>
      </section>

      {/* ===== KANAN: pratinjau & kode ===== */}
      <section className="flex min-h-[420px] flex-1 flex-col rounded-xl border bg-card shadow-xs">
        <header className="flex flex-wrap items-center gap-1.5 border-b border-border px-3 py-2">
          <Tabs value={rightTab} onValueChange={(v) => setRightTab(v as "preview" | "code")}>
            <TabsList className="h-8">
              <TabsTrigger value="preview" className="gap-1.5 px-3 text-xs">
                <Eye className="size-3.5" /> Pratinjau
              </TabsTrigger>
              <TabsTrigger value="code" className="gap-1.5 px-3 text-xs">
                <Code2 className="size-3.5" /> Kode
              </TabsTrigger>
            </TabsList>
          </Tabs>
          <span className="flex-1" />
          {html ? (
            <>
              <Badge variant="secondary" className="text-[10px]">
                {lineCount} baris
              </Badge>
              <Button variant="ghost" size="icon" className="size-7" onClick={() => setPreviewKey((k) => k + 1)} title="Jalankan ulang">
                <Play className="size-3.5" />
              </Button>
              <Button variant="ghost" size="icon" className="size-7" onClick={() => setFullscreen(true)} title="Perbesar pratinjau">
                <Maximize2 className="size-3.5" />
              </Button>
              <Button variant="ghost" size="icon" className="size-7" onClick={downloadHtml} title="Unduh file HTML">
                <Download className="size-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                onClick={() => setSaveOpen(true)}
                title={currentProjectId ? "Perbarui proyek" : "Simpan ke Proyekku"}
              >
                <Save className="size-3.5" />
              </Button>
            </>
          ) : null}
          <Button variant="ghost" size="icon" className="size-7" onClick={openProjects} title="Proyekku">
            <FolderOpen className="size-3.5" />
          </Button>
        </header>

        {html ? (
          <Tabs value={rightTab} onValueChange={(v) => setRightTab(v as "preview" | "code")} className="flex min-h-0 flex-1 flex-col gap-0">
            <TabsContent value="preview" className="mt-0 min-h-0 flex-1">
              <iframe
                key={previewKey}
                title="Pratinjau aplikasi"
                srcDoc={html}
                sandbox="allow-scripts allow-forms allow-modals allow-pointer-lock"
                className="h-full min-h-[380px] w-full border-0 bg-white"
              />
            </TabsContent>
            <TabsContent value="code" className="mt-0 min-h-0 flex-1">
              <CodeTabs code={code} />
            </TabsContent>
          </Tabs>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
            <FileCode2 className="size-10 text-muted-foreground/40" />
            <p className="text-sm font-medium text-muted-foreground">Belum ada kode</p>
            <p className="max-w-xs text-xs text-muted-foreground/70">
              Hasil tulisan AI akan muncul di sini — bisa dijalankan, dilihat kodenya, diunduh,
              dan disimpan sebagai proyek.
            </p>
          </div>
        )}
      </section>

      {/* ===== Dialog: simpan proyek ===== */}
      <Dialog open={saveOpen} onOpenChange={setSaveOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Simpan ke Proyekku</DialogTitle>
            <DialogDescription>
              Proyek tersimpan di akunmu — bisa dibuka lagi kapan saja dari tab Pusat Belajar ini.
            </DialogDescription>
          </DialogHeader>
          <Input
            value={saveTitle}
            onChange={(e) => setSaveTitle(e.target.value)}
            placeholder="Nama proyek, mis. Tes Kecepatan Mengetik"
            maxLength={120}
            onKeyDown={(e) => {
              if (e.key === "Enter") void saveProject();
            }}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setSaveOpen(false)} disabled={saving}>
              Batal
            </Button>
            <Button onClick={saveProject} disabled={saving} className="gap-1.5">
              {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
              Simpan
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ===== Dialog: daftar proyek ===== */}
      <Dialog open={projectsOpen} onOpenChange={setProjectsOpen}>
        <DialogContent className="max-w-md max-h-[75vh] flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FolderOpen className="size-4 text-primary" /> Proyekku
            </DialogTitle>
            <DialogDescription>Proyek yang kamu simpan dari AI Builder.</DialogDescription>
          </DialogHeader>
          {projects.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              Belum ada proyek tersimpan.
            </p>
          ) : (
            <ScrollArea className="flex-1 min-h-0 -mx-2 px-2">
              <div className="space-y-1.5">
                {projects.map((p) => (
                  <div
                    key={p.id}
                    className={cn(
                      "group flex items-center gap-2 rounded-lg border px-3 py-2",
                      currentProjectId === p.id && "border-primary/60 bg-primary/5"
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => openProject(p.id)}
                      className="min-w-0 flex-1 text-left"
                    >
                      <p className="truncate text-sm font-medium">{p.title}</p>
                      <p className="text-[11px] text-muted-foreground">
                        {(p.htmlLength / 1000).toFixed(1)} rb karakter ·{" "}
                        {new Date(p.updatedAt).toLocaleDateString("id-ID", {
                          day: "numeric",
                          month: "short",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </p>
                    </button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-7 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:text-destructive"
                      onClick={() => deleteProject(p.id)}
                      title="Hapus proyek"
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                ))}
              </div>
            </ScrollArea>
          )}
        </DialogContent>
      </Dialog>

      {/* ===== Dialog: pratinjau fullscreen ===== */}
      <Dialog open={fullscreen} onOpenChange={setFullscreen}>
        <DialogContent className="max-w-[95vw] h-[90vh] p-0 flex flex-col overflow-hidden [&>button]:z-10">
          <DialogHeader className="px-4 pt-3 pb-2 border-b border-border">
            <DialogTitle className="text-sm flex items-center gap-2">
              <Eye className="size-4 text-primary" />
              {saveTitle || titleFromHtml(html) || "Pratinjau"}
            </DialogTitle>
          </DialogHeader>
          <iframe
            title="Pratinjau aplikasi (besar)"
            srcDoc={html}
            sandbox="allow-scripts allow-forms allow-modals allow-pointer-lock"
            className="flex-1 w-full border-0 bg-white"
          />
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Bubble chat
// ---------------------------------------------------------------------------

function ChatBubble({ msg }: { msg: ChatMsg }) {
  const isUser = msg.role === "user";
  const isCode =
    !isUser && !msg.error && /<(!doctype|html)/i.test(msg.content.slice(0, 200));
  const lines = isCode ? msg.content.split("\n").length : 0;
  return (
    <div className={cn("flex gap-2", isUser ? "justify-end" : "justify-start")}>
      {!isUser ? (
        <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Bot className="size-3.5" />
        </div>
      ) : null}
      <div
        className={cn(
          "max-w-[85%] rounded-xl px-3 py-2 text-sm leading-relaxed",
          isUser
            ? "bg-primary text-primary-foreground"
            : msg.error
              ? "bg-destructive/10 text-destructive border border-destructive/30"
              : "bg-muted"
        )}
      >
        {isUser ? (
          msg.content
        ) : msg.streaming ? (
          <span className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            Menulis kode… {msg.content ? `${msg.content.split("\n").length} baris` : ""}
          </span>
        ) : isCode ? (
          <span>
            Kode selesai — <strong>{lines} baris</strong> HTML/CSS/JS.{" "}
            <span className="text-muted-foreground">
              Cek Pratinjau di sebelah kanan, atau minta perubahan lagi di bawah.
            </span>
          </span>
        ) : (
          msg.content
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab kode HTML / CSS / JS (read-only, untuk belajar)
// ---------------------------------------------------------------------------

function CodeTabs({ code }: { code: { htmlPart: string; cssPart: string; jsPart: string } | null }) {
  if (!code) return null;
  return (
    <Tabs defaultValue="html" className="flex h-full min-h-0 flex-col gap-0">
      <div className="border-b border-border px-2 pt-1">
        <TabsList className="h-7 bg-transparent p-0">
          <TabsTrigger value="html" className="h-7 px-2.5 text-[11px]">index.html</TabsTrigger>
          <TabsTrigger value="css" className="h-7 px-2.5 text-[11px]">style.css</TabsTrigger>
          <TabsTrigger value="js" className="h-7 px-2.5 text-[11px]">script.js</TabsTrigger>
        </TabsList>
      </div>
      <TabsContent value="html" className="mt-0 min-h-0 flex-1">
        <CodePane label="index.html" text={code.htmlPart} />
      </TabsContent>
      <TabsContent value="css" className="mt-0 min-h-0 flex-1">
        <CodePane
          label="style.css"
          text={code.cssPart || "/* Tidak ada CSS terpisah — AI menulis CSS di dalam <style>. */"}
        />
      </TabsContent>
      <TabsContent value="js" className="mt-0 min-h-0 flex-1">
        <CodePane
          label="script.js"
          text={code.jsPart || "// Tidak ada JS terpisah — AI menulis JS di dalam <script>."}
        />
      </TabsContent>
    </Tabs>
  );
}

function CodePane({ label, text }: { label: string; text: string }) {
  return (
    <ScrollArea className="h-full min-h-[380px] bg-zinc-950">
      <div className="p-3">
        <div className="mb-2 flex items-center justify-between">
          <span className="font-mono text-[10px] text-zinc-500">{label}</span>
          <span className="font-mono text-[10px] text-zinc-600">{text.split("\n").length} baris</span>
        </div>
        <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-zinc-200 selection:bg-primary/40">
          {text}
        </pre>
      </div>
    </ScrollArea>
  );
}
