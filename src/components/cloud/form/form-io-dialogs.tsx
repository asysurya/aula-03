"use client";

// Dialog import/export/AI untuk FormBuilder.
// - AiGenerateDialog — 2 mode:
//     1) "Buat langsung"  : prompt → AI internal aula → draf soal.
//        Jika gagal (AI_GENERATE_FAILED dst.) tampil kotak error + tombol coba lagi.
//     2) "Lewat AI lain"  : prompt siap-salin untuk ChatGPT/Gemini/Claude/dll.
//        Guru menempel balasan AI apa adanya — parser JSON toleran otomatis
//        membuang kalimat pengantar & code fence markdown di sekitarnya.
// - FormImportDialog: paste teks JSON / pilih file .json → validasi → terapkan
// - downloadFormJson: unduh form saat ini sebagai file .json

import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  AlertTriangle,
  Check,
  ClipboardCheck,
  Copy,
  FileJson,
  Loader2,
  Plus,
  Replace,
  Sparkles,
  Upload,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { questionTypeMeta, type FormSettings } from "@/lib/form-types";
import {
  parseFormJson,
  exportFormJson,
  type FormIOParsedQuestion,
} from "@/lib/form-io";
import { buildExternalPrompt } from "@/lib/form-ai";

export type ApplyMode = "append" | "replace";

interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onApply: (
    questions: FormIOParsedQuestion[],
    mode: ApplyMode,
    settings?: Partial<FormSettings>
  ) => void;
}

function QuestionPreviewList({
  questions,
}: {
  questions: FormIOParsedQuestion[];
}) {
  return (
    <div className="max-h-56 overflow-y-auto rounded-lg border border-border divide-y divide-border">
      {questions.slice(0, 30).map((q, i) => (
        <div key={i} className="flex items-start gap-2.5 px-3 py-2">
          <span className="text-[10px] text-muted-foreground tabular-nums pt-1 shrink-0">
            {i + 1}.
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-xs line-clamp-2">{q.text}</p>
            <div className="flex items-center gap-1.5 mt-1 flex-wrap">
              <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                {questionTypeMeta(q.type).label}
              </Badge>
              <span className="text-[10px] text-muted-foreground">
                {q.points} poin
                {q.type === "PG" || q.type === "MULTI_PG"
                  ? ` · ${q.options.length} opsi`
                  : ""}
              </span>
            </div>
          </div>
        </div>
      ))}
      {questions.length > 30 ? (
        <p className="px-3 py-2 text-[10px] text-muted-foreground">
          +{questions.length - 30} soal lainnya…
        </p>
      ) : null}
    </div>
  );
}

function ApplyModePicker({
  mode,
  setMode,
  hasQuestions,
}: {
  mode: ApplyMode;
  setMode: (m: ApplyMode) => void;
  hasQuestions: boolean;
}) {
  return (
    <div className="space-y-1.5">
      <Label>Terapkan sebagai</Label>
      <RadioGroup
        value={mode}
        onValueChange={(v) => setMode(v as ApplyMode)}
        className="gap-2"
      >
        <div className="flex items-center gap-2">
          <RadioGroupItem value="append" id="mode-append" />
          <Label htmlFor="mode-append" className="font-normal cursor-pointer">
            <span className="inline-flex items-center gap-1">
              <Plus className="size-3" /> Tambahkan setelah soal yang ada
            </span>
          </Label>
        </div>
        <div className="flex items-center gap-2">
          <RadioGroupItem value="replace" id="mode-replace" />
          <Label htmlFor="mode-replace" className="font-normal cursor-pointer">
            <span className="inline-flex items-center gap-1">
              <Replace className="size-3" /> Ganti seluruh soal saat ini
              {hasQuestions ? "" : " (belum ada soal)"}
            </span>
          </Label>
        </div>
      </RadioGroup>
    </div>
  );
}

// ── AI generator dialog (2 mode) ──────────────────────────────────

export function AiGenerateDialog({
  open,
  onOpenChange,
  onApply,
}: DialogProps) {
  const [prompt, setPrompt] = useState("");
  const [countInput, setCountInput] = useState("10");
  const [type, setType] = useState<
    "MIX" | "PG" | "MULTI_PG" | "SHORT" | "ESSAY"
  >("MIX");
  const [mode, setMode] = useState<ApplyMode>("append");

  // Mode 1 — AI internal aula
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<FormIOParsedQuestion[] | null>(null);

  // Mode 2 — AI lain (salin prompt → tempel jawaban)
  const [copied, setCopied] = useState(false);
  const [reply, setReply] = useState("");
  const [replyError, setReplyError] = useState<string | null>(null);
  const [replyResult, setReplyResult] = useState<FormIOParsedQuestion[] | null>(
    null
  );

  const count = Math.max(1, Math.min(40, parseInt(countInput, 10) || 10));
  const types =
    type === "MIX" ? ["PG", "MULTI_PG", "SHORT", "ESSAY"] : [type];

  const externalPromptText = useMemo(() => {
    const p = prompt.trim();
    if (!p) return "";
    const t = type === "MIX" ? ["PG", "MULTI_PG", "SHORT", "ESSAY"] : [type];
    const c = Math.max(1, Math.min(40, parseInt(countInput, 10) || 10));
    return buildExternalPrompt(p, c, t);
  }, [prompt, countInput, type]);

  async function generate() {
    const p = prompt.trim();
    if (!p) {
      toast.error(
        "Tulis dulu prompt-nya — mis. topik, jenjang kelas, tingkat kesulitan"
      );
      return;
    }
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/forms/ai-generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: p, count, types }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json?.error || "AI_GENERATE_FAILED — coba lagi sebentar");
        return;
      }
      setResult(json.questions as FormIOParsedQuestion[]);
      toast.success(
        `${json.generatedCount} soal dibuat — periksa dulu sebelum dipakai`
      );
    } catch {
      setError("Koneksi terputus — coba lagi sebentar");
    } finally {
      setLoading(false);
    }
  }

  function validateReply() {
    try {
      const parsed = parseFormJson(reply);
      setReplyResult(parsed.questions);
      setReplyError(null);
      toast.success(`${parsed.questions.length} soal terbaca dari jawaban AI`);
    } catch (e) {
      setReplyResult(null);
      setReplyError(
        e instanceof Error ? e.message : "Jawaban AI tidak valid"
      );
    }
  }

  async function copyPrompt() {
    if (!externalPromptText) {
      toast.error(
        "Tulis dulu prompt-nya — mis. topik, jenjang kelas, tingkat kesulitan"
      );
      return;
    }
    try {
      await navigator.clipboard.writeText(externalPromptText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      toast.success(
        "Prompt disalin — buka ChatGPT/Gemini/AI lain, tempel, lalu salin jawabannya ke sini"
      );
    } catch {
      toast.error(
        "Gagal menyalin otomatis — salin manual dari kotak prompt di bawah"
      );
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="size-4 text-primary" /> Buat soal dengan AI
          </DialogTitle>
          <DialogDescription>
            Tulis prompt bebas: topik, jenjang, jumlah, tingkat kesulitan.
            Hasilnya <b>draf</b> — selalu periksa &amp; edit sebelum menyimpan.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="ai-prompt">Prompt</Label>
            <Textarea
              id="ai-prompt"
              rows={3}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Contoh: 10 soal tentang Fotosintesis untuk SMP kelas 8, campuran PG dan isian, kesulitan sedang"
              className="text-sm"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="ai-count">Jumlah soal</Label>
              <Input
                id="ai-count"
                type="number"
                min={1}
                max={40}
                value={countInput}
                onChange={(e) => setCountInput(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Jenis soal</Label>
              <Select value={type} onValueChange={(v) => setType(v as typeof type)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="MIX">Campuran otomatis</SelectItem>
                  <SelectItem value="PG">Pilihan Ganda</SelectItem>
                  <SelectItem value="MULTI_PG">PG Multi-jawaban</SelectItem>
                  <SelectItem value="SHORT">Isian singkat</SelectItem>
                  <SelectItem value="ESSAY">Esai</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <Tabs defaultValue="internal">
            <TabsList className="w-full">
              <TabsTrigger value="internal" className="flex-1 gap-1.5">
                <Sparkles className="size-3.5" /> Buat langsung
              </TabsTrigger>
              <TabsTrigger value="external" className="flex-1 gap-1.5">
                <Copy className="size-3.5" /> Lewat AI lain
              </TabsTrigger>
            </TabsList>

            {/* Mode 1 — AI internal aula */}
            <TabsContent value="internal" className="space-y-3 pt-1">
              {error ? (
                <Alert variant="destructive">
                  <AlertTriangle className="size-4" />
                  <AlertTitle>{error}</AlertTitle>
                  <AlertDescription className="mt-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void generate()}
                      disabled={loading}
                    >
                      {loading ? (
                        <Loader2 className="size-3.5 animate-spin mr-1" />
                      ) : null}
                      Coba lagi
                    </Button>
                  </AlertDescription>
                </Alert>
              ) : null}
              {result && !error ? (
                <div className="space-y-2">
                  <p className="text-xs font-medium text-muted-foreground">
                    Draf {result.length} soal:
                  </p>
                  <QuestionPreviewList questions={result} />
                  <ApplyModePicker mode={mode} setMode={setMode} hasQuestions />
                  <div className="flex justify-end gap-2 pt-1">
                    <Button variant="outline" onClick={() => setResult(null)}>
                      Buat ulang
                    </Button>
                    <Button
                      onClick={() => {
                        onApply(result, mode);
                        onOpenChange(false);
                        setPrompt("");
                        setResult(null);
                        setError(null);
                      }}
                    >
                      <Plus className="size-4 mr-1" /> Gunakan draf ini
                    </Button>
                  </div>
                </div>
              ) : null}
              {!result && !error ? (
                <Button
                  onClick={() => void generate()}
                  disabled={loading}
                  className="w-full"
                >
                  {loading ? (
                    <Loader2 className="size-4 animate-spin mr-1" />
                  ) : (
                    <Sparkles className="size-4 mr-1" />
                  )}
                  {loading ? "AI sedang menyusun soal…" : "Buat draf soal"}
                </Button>
              ) : null}
            </TabsContent>

            {/* Mode 2 — lewat AI lain (ChatGPT/Gemini/Claude/…) */}
            <TabsContent value="external" className="space-y-3 pt-1">
              <p className="text-xs text-muted-foreground">
                Salin prompt di bawah ke AI lain (ChatGPT, Gemini, Claude,
                dll.), lalu tempelkan jawabannya ke kotak paling bawah.
                Kalimat pengantar AI &amp; blok kode markdown (```…```) di
                sekitar jawaban otomatis dibuang saat validasi.
              </p>
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <Label>Prompt untuk AI lain</Label>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => void copyPrompt()}
                  >
                    {copied ? (
                      <Check className="size-3.5 mr-1" />
                    ) : (
                      <Copy className="size-3.5 mr-1" />
                    )}
                    {copied ? "Tersalin" : "Salin prompt"}
                  </Button>
                </div>
                <Textarea
                  readOnly
                  rows={4}
                  value={externalPromptText}
                  placeholder="Tulis prompt Anda dulu — prompt siap-salin muncul di sini"
                  className="text-[11px] font-mono"
                  onFocus={(e) => e.currentTarget.select()}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ai-reply">Jawaban AI (tempel apa adanya)</Label>
                <Textarea
                  id="ai-reply"
                  rows={5}
                  value={reply}
                  onChange={(e) => {
                    setReply(e.target.value);
                    setReplyResult(null);
                    setReplyError(null);
                  }}
                  placeholder="Tempel jawaban AI di sini — boleh ikut kalimat pengantarnya"
                  className="text-xs font-mono"
                />
              </div>
              <Button
                size="sm"
                variant="secondary"
                onClick={validateReply}
                disabled={!reply.trim()}
              >
                <ClipboardCheck className="size-3.5 mr-1" /> Periksa &amp;
                validasi
              </Button>
              {replyError ? (
                <Alert variant="destructive">
                  <AlertTriangle className="size-4" />
                  <AlertTitle>{replyError}</AlertTitle>
                  <AlertDescription>
                    Periksa kembali jawaban AI, atau minta AI mengulang
                    jawabannya sesuai format.
                  </AlertDescription>
                </Alert>
              ) : null}
              {replyResult ? (
                <div className="space-y-2">
                  <p className="text-xs font-medium text-muted-foreground">
                    {replyResult.length} soal terbaca:
                  </p>
                  <QuestionPreviewList questions={replyResult} />
                  <ApplyModePicker mode={mode} setMode={setMode} hasQuestions />
                  <div className="flex justify-end gap-2 pt-1">
                    <Button
                      variant="outline"
                      onClick={() => {
                        setReply("");
                        setReplyResult(null);
                      }}
                    >
                      Tempel ulang
                    </Button>
                    <Button
                      onClick={() => {
                        onApply(replyResult, mode);
                        onOpenChange(false);
                        setPrompt("");
                        setReply("");
                        setReplyResult(null);
                        setReplyError(null);
                      }}
                    >
                      <Plus className="size-4 mr-1" /> Gunakan soal ini
                    </Button>
                  </div>
                </div>
              ) : null}
            </TabsContent>
          </Tabs>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── Import JSON dialog ────────────────────────────────────────────

export function FormImportDialog({
  open,
  onOpenChange,
  onApply,
}: DialogProps) {
  const [text, setText] = useState("");
  const [parsed, setParsed] = useState<{
    questions: FormIOParsedQuestion[];
    settings: Partial<FormSettings>;
  } | null>(null);
  const [mode, setMode] = useState<ApplyMode>("replace");
  const [applySettings, setApplySettings] = useState(true);
  const fileRef = useRef<HTMLInputElement | null>(null);

  function doParse(t: string) {
    try {
      // Parser toleran: teks non-JSON di sekitar blok JSON otomatis dibuang
      // (aman untuk hasil copy-paste dari AI / catatan berformat).
      const result = parseFormJson(t);
      setParsed(result);
      toast.success(
        `${result.questions.length} soal terbaca${
          Object.keys(result.settings).length > 0 ? " + pengaturan" : ""
        }`
      );
    } catch (e) {
      setParsed(null);
      toast.error(e instanceof Error ? e.message : "JSON tidak valid");
    }
  }

  async function onFilePicked(files: FileList | null) {
    const f = files?.[0];
    if (!f) return;
    if (fileRef.current) fileRef.current.value = "";
    if (f.size > 1024 * 512) {
      toast.error("File terlalu besar (maks 512 KB)");
      return;
    }
    const t = await f.text();
    setText(t);
    doParse(t);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileJson className="size-4 text-primary" /> Impor soal dari JSON
          </DialogTitle>
          <DialogDescription>
            Tempel teks JSON atau pilih file <code>.json</code> hasil export
            sebelumnya. Teks lain di sekitar JSON diabaikan otomatis.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label htmlFor="import-text">Teks JSON</Label>
              <Button
                size="sm"
                variant="outline"
                onClick={() => fileRef.current?.click()}
              >
                <Upload className="size-3.5 mr-1" /> Pilih file
              </Button>
            </div>
            <Textarea
              id="import-text"
              rows={5}
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                setParsed(null);
              }}
              placeholder='{"kind":"aula-form","version":1,"questions":[…]}'
              className="text-xs font-mono"
            />
            <input
              ref={fileRef}
              type="file"
              accept=".json,application/json,text/plain"
              className="hidden"
              onChange={(e) => void onFilePicked(e.target.files)}
            />
          </div>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => doParse(text)}
            disabled={!text.trim()}
          >
            <FileJson className="size-3.5 mr-1" /> Periksa &amp; validasi
          </Button>

          {parsed ? (
            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground">
                {parsed.questions.length} soal valid:
              </p>
              <QuestionPreviewList questions={parsed.questions} />
              <ApplyModePicker
                mode={mode}
                setMode={setMode}
                hasQuestions
              />
              {Object.keys(parsed.settings).length > 0 ? (
                <label className="flex items-center gap-2 text-xs cursor-pointer">
                  <input
                    type="checkbox"
                    checked={applySettings}
                    onChange={(e) => setApplySettings(e.target.checked)}
                    className="accent-primary"
                  />
                  Terapkan juga pengaturan anti-nyontek dari file
                </label>
              ) : null}
            </div>
          ) : null}
        </div>

        <DialogFooter>
          <Button
            disabled={!parsed}
            onClick={() => {
              if (!parsed) return;
              onApply(
                parsed.questions,
                mode,
                applySettings ? parsed.settings : undefined
              );
              onOpenChange(false);
              setText("");
              setParsed(null);
            }}
          >
            <Plus className="size-4 mr-1" /> Terapkan
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Export helper ─────────────────────────────────────────────────

export function downloadFormJson(
  settings: FormSettings,
  questions: FormIOParsedQuestion[],
  filename: string
): void {
  const text = exportFormJson(settings, questions);
  const blob = new Blob([text], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename.endsWith(".json") ? filename : `${filename}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  toast.success("Form diexport ke file JSON");
}
