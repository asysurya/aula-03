"use client";

// ─────────────────────────────────────────────────────────────────────
// Admin Panel → tab Teman AI / AI Builder: atur DEFAULT AI per KATEGORI
// (chat / builder / vision) dengan RANTAI FALLBACK berurutan (Task 29).
//   • variant "teman" (default) → SATU panel dengan 3 tab kategori
//     (endpoint /api/admin/ai, AppSetting "ai.fallbacks").
//   • variant "builder" → hanya kategori Builder (dipakai di tab AI
//     Builder di samping panel kuota — endpoint sama).
// User tanpa config sendiri mengikuti rantai default ini; entri #1
// dipakai duluan, bila gagal otomatis lanjut #2, #3…
// Kunci disimpan terenkripsi (AES-256-GCM), tidak dikirim balik.
// ─────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2, Info, CheckCircle2, XCircle, PlugZap, PowerOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  AiChainEditor,
  newChainEntry,
  type ChainEntryDraft,
  type EntryTestResult,
} from "@/components/ai/ai-chain-editor";
import {
  PROVIDERS,
  AI_CATEGORIES,
  CATEGORY_HINTS,
  CATEGORY_LABELS,
  type AiCategory,
} from "@/lib/ai-providers";
import { cn } from "@/lib/utils";

interface AdminEntryView {
  provider: string;
  baseUrl: string | null;
  model: string | null;
  hasKey: boolean;
  keyMask: string | null;
}

interface AdminAiData {
  categories: Record<AiCategory, { entries: AdminEntryView[] }>;
}

const TAB_LABEL: Record<AiCategory, string> = {
  chat: "Chat",
  builder: "Builder",
  vision: "Vision",
};

function draftsFrom(entries: AdminEntryView[]): ChainEntryDraft[] {
  return entries.map((e) => ({
    provider: e.provider,
    baseUrl: e.baseUrl ?? "",
    model: e.model ?? "",
    apiKey: "",
    clearKey: false,
    hasKey: e.hasKey,
    keyMask: e.keyMask,
  }));
}

export function AiDefaultPanel({ variant = "teman" }: { variant?: "teman" | "builder" }) {
  const cats: AiCategory[] = variant === "builder" ? ["builder"] : ["chat", "builder", "vision"];
  const [tab, setTab] = useState<AiCategory>(cats[0]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [drafts, setDrafts] = useState<Record<AiCategory, ChainEntryDraft[]>>({
    chat: [],
    builder: [],
    vision: [],
  });
  const [dirty, setDirty] = useState<Record<AiCategory, boolean>>({
    chat: false,
    builder: false,
    vision: false,
  });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/ai", { cache: "no-store" });
      if (!res.ok) throw new Error();
      const json = (await res.json()) as AdminAiData;
      setDrafts({
        chat: draftsFrom(json.categories?.chat?.entries ?? []),
        builder: draftsFrom(json.categories?.builder?.entries ?? []),
        vision: draftsFrom(json.categories?.vision?.entries ?? []),
      });
      setDirty({ chat: false, builder: false, vision: false });
    } catch {
      toast.error("Gagal memuat default AI.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const draft = drafts[tab];

  function setDraft(next: ChainEntryDraft[]) {
    setDrafts((d) => ({ ...d, [tab]: next }));
    setDirty((d) => ({ ...d, [tab]: true }));
  }

  /** Tes entri admin: spesifikasi (kunci diketik) atau entri tersimpan. */
  const testEntry = useCallback(
    async (index: number): Promise<EntryTestResult | null> => {
      const e = drafts[tab][index];
      if (!e) return null;
      try {
        const body =
          e.apiKey.trim() || !e.hasKey
            ? {
                provider: e.provider,
                baseUrl: e.baseUrl.trim() || undefined,
                model: e.model.trim() || undefined,
                apiKey: e.apiKey.trim() || undefined,
              }
            : { category: tab, index };
        const res = await fetch("/api/ai/test", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const json = await res.json().catch(() => ({}));
        if (json?.ok) {
          const reply = json.reply ? ` dan menjawab: “${json.reply}”` : "";
          return { ok: true, text: `Tersambung! Model “${json.model ?? "?"}” berfungsi${reply}.` };
        }
        return { ok: false, text: json?.error ?? "Tes gagal — coba lagi." };
      } catch {
        return { ok: false, text: "Gagal menghubungi server untuk tes." };
      }
    },
    [drafts, tab]
  );

  async function save() {
    const entries = drafts[tab];
    for (const e of entries) {
      if (!e.baseUrl.trim() || !/^https?:\/\/.+/i.test(e.baseUrl.trim())) {
        toast.error("Base URL setiap entri wajib diisi dan mulai http(s)://");
        return;
      }
    }
    setSaving(true);
    try {
      const res = await fetch("/api/admin/ai", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          entries.length
            ? {
                category: tab,
                entries: entries.map((e) => ({
                  provider: e.provider,
                  baseUrl: e.baseUrl.trim(),
                  model: e.model.trim(),
                  apiKey: e.apiKey.trim() || undefined,
                  clearKey: e.clearKey || undefined,
                })),
              }
            : { category: tab, disabled: true }
        ),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json?.error) {
        toast.error(json?.error ?? "Gagal menyimpan default AI.");
        return;
      }
      toast.success(
        entries.length
          ? `Default ${CATEGORY_LABELS[tab]} tersimpan (${entries.length} entri fallback).`
          : `Default ${CATEGORY_LABELS[tab]} dinonaktifkan.`
      );
      await load();
    } catch {
      toast.error("Gagal menyimpan default AI.");
    } finally {
      setSaving(false);
    }
  }

  async function disableCategory() {
    setSaving(true);
    try {
      const res = await fetch("/api/admin/ai", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ category: tab, disabled: true }),
      });
      if (!res.ok) throw new Error();
      toast.success(`Default ${CATEGORY_LABELS[tab]} dinonaktifkan — user memakai kunci sendiri.`);
      await load();
    } catch {
      toast.error("Gagal menonaktifkan default.");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="rounded-xl border bg-card p-6 flex items-center justify-center text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin mr-2" /> Memuat…
      </div>
    );
  }

  return (
    <div className="rounded-xl border bg-card p-4 sm:p-5 space-y-4">
      <div className="space-y-1">
        <h3 className="text-sm font-semibold flex items-center gap-2">
          Default AI Aula
          {draft.length ? (
            <Badge variant="secondary" className="gap-1 text-[10px] font-normal">
              <CheckCircle2 className="h-3 w-3 text-emerald-500" />
              {draft.length} entri {TAB_LABEL[tab].toLowerCase()}
            </Badge>
          ) : (
            <Badge variant="destructive" className="gap-1 text-[10px] font-normal">
              <XCircle className="h-3 w-3" />
              belum diatur
            </Badge>
          )}
        </h3>
        <p className="text-xs text-muted-foreground leading-relaxed">
          Dipakai user yang belum memasang kunci sendiri. Susun rantai
          fallback per kategori — entri #1 dipakai duluan; bila gagal
          (error/key ditolak) permintaan otomatis lanjut ke entri #2, #3…
        </p>
      </div>

      <Tabs value={tab} onValueChange={(v) => setTab(v as AiCategory)}>
        {cats.length > 1 ? (
          <TabsList className={cn("grid w-full", cats.length === 3 && "grid-cols-3")}>
            {cats.map((c) => (
              <TabsTrigger key={c} value={c}>
                {TAB_LABEL[c]}
              </TabsTrigger>
            ))}
          </TabsList>
        ) : null}

        {cats.map((c) => (
          <TabsContent key={c} value={c} className="mt-3 space-y-3">
            <div className="rounded-md border bg-muted/40 px-3 py-2 flex items-start gap-2">
              <Info className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground" />
              <p className="text-xs text-muted-foreground">
                <span className="font-medium text-foreground">{CATEGORY_LABELS[c]}.</span>{" "}
                {CATEGORY_HINTS[c]}
              </p>
            </div>

            <AiChainEditor
              entries={drafts[c]}
              onChange={(next) => {
                setDrafts((d) => ({ ...d, [c]: next }));
                setDirty((d) => ({ ...d, [c]: true }));
              }}
              onTestEntry={testEntry}
              vision={c === "vision"}
            />

            {!drafts[c].length ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="border-dashed"
                onClick={() => {
                  setDrafts((d) => ({ ...d, [c]: [newChainEntry()] }));
                  setDirty((d) => ({ ...d, [c]: true }));
                }}
              >
                <PlugZap className="h-3.5 w-3.5 mr-1.5" />
                Tambah entri pertama
              </Button>
            ) : null}
          </TabsContent>
        ))}
      </Tabs>

      <div className="flex items-center gap-2 pt-1">
        <Button size="sm" onClick={save} disabled={saving}>
          {saving ? <Loader2 className="h-4 w-4 animate-spin mr-1.5" /> : null}
          Simpan {TAB_LABEL[tab]}
          {dirty[tab] ? " •" : ""}
        </Button>
        {draft.length ? (
          <Button
            size="sm"
            variant="ghost"
            className="text-destructive hover:text-destructive"
            onClick={disableCategory}
            disabled={saving}
          >
            <PowerOff className="h-3.5 w-3.5 mr-1.5" />
            Nonaktifkan default {TAB_LABEL[tab].toLowerCase()}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
