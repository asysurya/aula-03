"use client";

// ─────────────────────────────────────────────────────────────────────
// Editor RANTAI FALLBACK config AI (Task 29) — dipakai bersama oleh:
//   • AiSettingsDialog (panel pengaturan user: Teman AI / Builder / Vision)
//   • AiDefaultPanel   (panel Admin: default per kategori)
//
// Satu kategori = daftar entri BERURUT (prioritas):
//   #1 dipakai duluan → gagal (jaringan/HTTP) → otomatis #2 → #3 …
// Entri: provider · Base URL · model · API key (retain/clear seperti lama).
// ─────────────────────────────────────────────────────────────────────

import { useState } from "react";
import { Loader2, KeyRound, Trash2, PlugZap, Plus, ChevronUp, ChevronDown, GripVertical } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PROVIDERS, PROVIDER_IDS } from "@/lib/ai-providers";
import { cn } from "@/lib/utils";

export interface ChainEntryDraft {
  provider: string;
  baseUrl: string;
  model: string;
  apiKey: string; // input mentah; "" = pertahankan kunci tersimpan
  clearKey: boolean;
  hasKey: boolean;
  keyMask: string | null;
}

export function newChainEntry(): ChainEntryDraft {
  return {
    provider: "ollama",
    baseUrl: PROVIDERS.ollama.baseUrl,
    model: PROVIDERS.ollama.models[0] ?? "",
    apiKey: "",
    clearKey: false,
    hasKey: false,
    keyMask: null,
  };
}

/** Hasil tes satu entri. */
export interface EntryTestResult {
  ok: boolean;
  text: string;
}

export interface AiChainEditorProps {
  entries: ChainEntryDraft[];
  onChange: (next: ChainEntryDraft[]) => void;
  /** Kategori untuk tombol tes entri TERSIMPAN (user & admin panel). */
  testCategory?: "chat" | "builder" | "vision" | "tts";
  /** Tes entri indeks ke-i lewat spesifikasi (belum tersimpan). */
  onTestEntry?: (index: number) => Promise<EntryTestResult | null>;
  /** Tampilkan saran model vision (kategori vision). */
  vision?: boolean;
  /** Tampilkan saran model TTS (kategori tts — /audio/speech). */
  tts?: boolean;
  /** Label ringkas tiap entri: "#1 Utama", "#2 Cadangan"… */
  maxEntries?: number;
  disabled?: boolean;
}

const ENTRY_ROLE = (i: number) =>
  i === 0 ? "utama" : `cadangan ${i}`;

export function AiChainEditor({
  entries,
  onChange,
  onTestEntry,
  vision = false,
  tts = false,
  maxEntries = 6,
  disabled = false,
}: AiChainEditorProps) {
  const [testingIdx, setTestingIdx] = useState<number | null>(null);
  const [testResults, setTestResults] = useState<Record<number, EntryTestResult>>({});

  function patch(i: number, p: Partial<ChainEntryDraft>) {
    onChange(entries.map((e, idx) => (idx === i ? { ...e, ...p } : e)));
  }

  function switchProvider(i: number, p: string) {
    const preset = PROVIDERS[p as keyof typeof PROVIDERS];
    patch(i, {
      provider: p,
      baseUrl: preset?.baseUrl ?? "",
      model: (tts ? preset?.ttsModels?.[0] : vision ? preset?.visionModels?.[0] : preset?.models?.[0]) ?? "",
      clearKey: false,
    });
    setTestResults((r) => ({ ...r, [i]: undefined as never }));
  }

  function move(i: number, dir: -1 | 1) {
    const j = i + dir;
    if (j < 0 || j >= entries.length) return;
    const next = [...entries];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
    setTestResults({});
  }

  function remove(i: number) {
    onChange(entries.filter((_, idx) => idx !== i));
    setTestResults({});
  }

  async function test(i: number) {
    if (!onTestEntry) return;
    setTestingIdx(i);
    try {
      const r = await onTestEntry(i);
      if (r) setTestResults((prev) => ({ ...prev, [i]: r }));
    } finally {
      setTestingIdx(null);
    }
  }

  return (
    <div className="space-y-3">
      {entries.map((e, i) => {
        const preset = PROVIDERS[e.provider as keyof typeof PROVIDERS];
        const models = tts
          ? preset?.ttsModels ?? []
          : vision
            ? preset?.visionModels ?? preset?.models ?? []
            : preset?.models ?? [];
        const res = testResults[i];
        const testing = testingIdx === i;
        return (
          <div
            key={i}
            className="rounded-lg border bg-muted/20 p-3 space-y-2.5"
            data-ai-chain-entry={i + 1}
          >
            <div className="flex items-center gap-1.5">
              <GripVertical className="h-3.5 w-3.5 text-muted-foreground/60" />
              <span className="text-xs font-medium text-muted-foreground">
                #{i + 1} <span className="capitalize">{ENTRY_ROLE(i)}</span>
                {i === 0 ? " — dipakai duluan" : " — otomatis bila #1 gagal"}
              </span>
              <div className="flex-1" />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-6"
                title="Naikkan prioritas"
                disabled={disabled || i === 0}
                onClick={() => move(i, -1)}
              >
                <ChevronUp className="size-3.5" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-6"
                title="Turunkan prioritas"
                disabled={disabled || i === entries.length - 1}
                onClick={() => move(i, 1)}
              >
                <ChevronDown className="size-3.5" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-6 text-destructive hover:text-destructive"
                title="Hapus entri"
                disabled={disabled}
                onClick={() => remove(i)}
              >
                <Trash2 className="size-3.5" />
              </Button>
            </div>

            <div className="grid gap-2.5 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label className="text-xs">Provider</Label>
                <Select
                  value={e.provider}
                  onValueChange={(v) => switchProvider(i, v)}
                  disabled={disabled}
                >
                  <SelectTrigger className="h-9">
                    <SelectValue placeholder="Pilih provider" />
                  </SelectTrigger>
                  <SelectContent>
                    {PROVIDER_IDS.map((p) => (
                      <SelectItem key={p} value={p}>
                        {PROVIDERS[p].label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Base URL</Label>
                <Input
                  className="h-9"
                  value={e.baseUrl}
                  onChange={(ev) => patch(i, { baseUrl: ev.target.value })}
                  placeholder="https://api.provider.com/v1"
                  autoComplete="off"
                  disabled={disabled}
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs">
                Model{vision ? " (wajib bisa melihat gambar)" : tts ? " (model suara / audio)" : ""}
              </Label>
              <Input
                className="h-9"
                value={e.model}
                onChange={(ev) => patch(i, { model: ev.target.value })}
                placeholder={
                  tts
                    ? "mis. gpt-4o-mini-tts / tts-1"
                    : vision
                      ? "mis. gpt-4o-mini / gemini-2.0-flash"
                      : "mis. gpt-4o-mini"
                }
                autoComplete="off"
                disabled={disabled}
              />
              {models.length ? (
                <div className="flex flex-wrap gap-1.5 pt-0.5">
                  {models.map((m) => (
                    <button
                      key={m}
                      type="button"
                      disabled={disabled}
                      onClick={() => patch(i, { model: m })}
                      className={cn(
                        "rounded-full border px-2 py-0.5 text-[11px] transition-colors",
                        e.model === m
                          ? "border-primary bg-primary text-primary-foreground"
                          : "border-border text-muted-foreground hover:text-foreground"
                      )}
                    >
                      {m}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs flex items-center gap-1.5">
                <KeyRound className="h-3 w-3" /> API Key
                {preset?.noKeyNeeded ? (
                  <span className="font-normal text-muted-foreground">
                    (opsional — bebas kunci)
                  </span>
                ) : null}
              </Label>
              <div className="flex gap-2">
                <Input
                  className="h-9"
                  type="password"
                  value={e.apiKey}
                  onChange={(ev) =>
                    patch(i, { apiKey: ev.target.value, clearKey: false })
                  }
                  placeholder={
                    e.hasKey && !e.clearKey
                      ? `•••••••• (tersimpan${e.keyMask ? `: ${e.keyMask}` : ""})`
                      : "tempel API key di sini"
                  }
                  autoComplete="new-password"
                  disabled={disabled}
                />
                {e.hasKey ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className={cn("h-9 shrink-0", e.clearKey && "text-destructive")}
                    disabled={disabled}
                    onClick={() => patch(i, { clearKey: !e.clearKey })}
                  >
                    {e.clearKey ? "Batal hapus" : "Hapus kunci"}
                  </Button>
                ) : null}
              </div>
            </div>

            {onTestEntry ? (
              <div className="space-y-1.5">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-8"
                  disabled={disabled || testing}
                  onClick={() => void test(i)}
                >
                  {testing ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
                  ) : (
                    <PlugZap className="h-3.5 w-3.5 mr-1.5" />
                  )}
                  Tes entri #{i + 1}
                </Button>
                {res ? (
                  <p
                    className={cn(
                      "text-xs leading-relaxed rounded-md border px-2.5 py-1.5",
                      res.ok
                        ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                        : "border-destructive/40 bg-destructive/10 text-destructive"
                    )}
                  >
                    {res.text}
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>
        );
      })}

      {entries.length < maxEntries ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="w-full border-dashed"
          disabled={disabled}
          onClick={() => onChange([...entries, newChainEntry()])}
        >
          <Plus className="h-3.5 w-3.5 mr-1.5" />
          Tambah fallback {entries.length > 0 ? `#${entries.length + 1}` : ""}
        </Button>
      ) : null}
    </div>
  );
}
