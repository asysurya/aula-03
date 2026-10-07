"use client";

// ─────────────────────────────────────────────────────────────────────
// Dialog Pengaturan AI — SATU PANEL untuk 3 kategori (Task 29):
//   • Chat    — Teman AI, Teman Belajar, Pusat Belajar
//   • Builder — AI Builder & generator soal
//   • Vision  — baca gambar & PDF hasil scan (per halaman)
// Tiap kategori punya RANTAI FALLBACK berurutan (#1 utama → #2 cadangan
// bila #1 gagal → …) yang bisa diatur prioritasnya (naik/turun).
// BYOK per kategori; kategori tanpa entri mengikuti default admin.
// Kunci lama tidak pernah dikirim balik — kosongkan input = pertahankan.
// ─────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2, Info, PlugZap, MessageCircle, Hammer, Eye, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  AiChainEditor,
  newChainEntry,
  type ChainEntryDraft,
  type EntryTestResult,
} from "@/components/ai/ai-chain-editor";
import { CATEGORY_HINTS, CATEGORY_LABELS, AI_CATEGORIES, type AiCategory } from "@/lib/ai-providers";
import { providerLabel } from "@/lib/ai-providers";
import { cn } from "@/lib/utils";

export type AiCategoryView = {
  entries: {
    provider: string;
    baseUrl: string | null;
    model: string | null;
    hasKey: boolean;
    keyMask: string | null;
  }[];
  followsDefault: boolean;
  active: {
    provider: string;
    baseUrl: string;
    model: string;
    source: "user" | "admin";
  } | null;
  adminAvailable: boolean;
};

export interface AiSettingsData {
  user: {
    provider: string;
    baseUrl: string | null;
    model: string | null;
    hasKey: boolean;
    keyMask: string | null;
  };
  default: {
    available: boolean;
    provider: string;
    model: string | null;
    sourceLabel: string;
  };
  active: {
    provider: string;
    baseUrl: string;
    model: string;
    source: "user" | "admin";
  } | null;
  categories?: Record<AiCategory, AiCategoryView>;
}

export async function fetchAiSettings(): Promise<AiSettingsData | null> {
  const res = await fetch("/api/ai/settings", { cache: "no-store" });
  if (!res.ok) return null;
  return res.json();
}

interface CategoryDraft {
  followDefault: boolean;
  entries: ChainEntryDraft[];
}

function draftFromView(v: AiCategoryView | undefined): CategoryDraft {
  if (!v || v.followsDefault || !v.entries.length) {
    return { followDefault: true, entries: [] };
  }
  return {
    followDefault: false,
    entries: v.entries.map((e) => ({
      provider: e.provider,
      baseUrl: e.baseUrl ?? "",
      model: e.model ?? "",
      apiKey: "",
      clearKey: false,
      hasKey: e.hasKey,
      keyMask: e.keyMask,
    })),
  };
}

const TAB_META: Record<AiCategory, { icon: typeof Eye; label: string }> = {
  chat: { icon: MessageCircle, label: "Chat" },
  builder: { icon: Hammer, label: "Builder" },
  vision: { icon: Eye, label: "Vision" },
};

export function AiSettingsDialog({
  open,
  onOpenChange,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onSaved?: () => void;
}) {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [data, setData] = useState<AiSettingsData | null>(null);
  const [tab, setTab] = useState<AiCategory>("chat");
  const [drafts, setDrafts] = useState<Record<AiCategory, CategoryDraft>>({
    chat: { followDefault: true, entries: [] },
    builder: { followDefault: true, entries: [] },
    vision: { followDefault: true, entries: [] },
  });
  const [testingActive, setTestingActive] = useState(false);
  const [activeTest, setActiveTest] = useState<EntryTestResult | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const d = await fetchAiSettings();
    setData(d);
    if (d?.categories) {
      setDrafts({
        chat: draftFromView(d.categories.chat),
        builder: draftFromView(d.categories.builder),
        vision: draftFromView(d.categories.vision),
      });
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (open) {
      setActiveTest(null);
      void load();
    }
  }, [open, load]);

  const view = data?.categories?.[tab];
  const draft = drafts[tab];

  function setDraft(next: CategoryDraft) {
    setDrafts((d) => ({ ...d, [tab]: next }));
  }

  /** Tes satu entri: spesifikasi (kunci diketik) atau entri tersimpan. */
  const testEntry = useCallback(
    async (index: number): Promise<EntryTestResult | null> => {
      const d = drafts[tab];
      const e = d.entries[index];
      if (!e) return null;
      try {
        const body =
          e.apiKey.trim() || !e.hasKey
            ? {
                // Spesifikasi draft (belum tentu tersimpan).
                provider: e.provider,
                baseUrl: e.baseUrl.trim() || undefined,
                model: e.model.trim() || undefined,
                apiKey: e.apiKey.trim() || undefined,
              }
            : {
                // Kunci tersimpan — tes entri rantai tersimpan (index
                // sejajar selama belum ditata ulang / ditambah).
                category: tab,
                index,
              };
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

  /** Tes config AKTIF kategori (entri pertama rantai efektif). */
  async function testActiveCategory() {
    setTestingActive(true);
    setActiveTest(null);
    try {
      const res = await fetch("/api/ai/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ category: tab }),
      });
      const json = await res.json().catch(() => ({}));
      if (json?.ok) {
        const reply = json.reply ? ` dan menjawab: “${json.reply}”` : "";
        setActiveTest({
          ok: true,
          text: `Tersambung! Model “${json.model ?? "?"}” berfungsi${reply}.`,
        });
        toast.success(`Sambungan ${CATEGORY_LABELS[tab]} OK`);
      } else {
        setActiveTest({ ok: false, text: json?.error ?? "Tes gagal — coba lagi." });
      }
    } catch {
      setActiveTest({ ok: false, text: "Gagal menghubungi server untuk tes." });
    } finally {
      setTestingActive(false);
    }
  }

  async function save() {
    const d = drafts[tab];
    if (!d.followDefault) {
      for (const e of d.entries) {
        if (!e.provider) {
          toast.error("Setiap entri wajib memilih provider.");
          return;
        }
        if (!e.baseUrl.trim()) {
          toast.error("Base URL wajib diisi untuk setiap entri.");
          return;
        }
        if (!/^https?:\/\/.+/i.test(e.baseUrl.trim())) {
          toast.error("Base URL harus mulai dengan http:// atau https://.");
          return;
        }
      }
      if (!d.entries.length) {
        toast.error("Tambahkan minimal satu entri, atau aktifkan ikut default admin.");
        return;
      }
    }
    setSaving(true);
    try {
      const res = await fetch("/api/ai/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          d.followDefault
            ? { category: tab, followDefault: true }
            : {
                category: tab,
                entries: d.entries.map((e) => ({
                  provider: e.provider,
                  baseUrl: e.baseUrl.trim(),
                  model: e.model.trim(),
                  apiKey: e.apiKey.trim() || undefined,
                  clearKey: e.clearKey || undefined,
                })),
              }
        ),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json?.error) {
        toast.error(json?.error ?? "Gagal menyimpan pengaturan.");
        return;
      }
      toast.success(
        d.followDefault
          ? `${CATEGORY_LABELS[tab]} kini mengikuti default admin.`
          : `Pengaturan ${CATEGORY_LABELS[tab]} tersimpan.`
      );
      await load();
      onSaved?.();
    } catch {
      toast.error("Gagal menyimpan pengaturan.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Pengaturan AI</DialogTitle>
          <DialogDescription>
            Satu panel untuk semua fitur AI Aula. Pilih kategori (chat /
            builder / vision) lalu susun rantai fallback: #1 dipakai duluan,
            otomatis lanjut #2, #3… bila gagal. Kunci disimpan terenkripsi
            di server.
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-10 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin mr-2" /> Memuat…
          </div>
        ) : (
          <Tabs value={tab} onValueChange={(v) => { setTab(v as AiCategory); setActiveTest(null); }}>
            <TabsList className="grid w-full grid-cols-3">
              {AI_CATEGORIES.map((c) => {
                const Icon = TAB_META[c].icon;
                return (
                  <TabsTrigger key={c} value={c} className="gap-1.5">
                    <Icon className="h-3.5 w-3.5" />
                    {TAB_META[c].label}
                  </TabsTrigger>
                );
              })}
            </TabsList>

            {AI_CATEGORIES.map((c) => {
              const dv = data?.categories?.[c];
              const cd = drafts[c];
              return (
                <TabsContent key={c} value={c} className="mt-3">
                  <div className="space-y-3 max-h-[52vh] overflow-y-auto pr-1">
                    {/* Info kategori */}
                    <div className="rounded-md border bg-muted/40 px-3 py-2 flex items-start gap-2">
                      <Info className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground" />
                      <p className="text-xs text-muted-foreground">
                        <span className="font-medium text-foreground">
                          {CATEGORY_LABELS[c]}.
                        </span>{" "}
                        {CATEGORY_HINTS[c]}
                      </p>
                    </div>

                    {/* Status aktif */}
                    <div className="rounded-md border px-3 py-2 flex items-center gap-2 text-xs">
                      <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      {dv?.active ? (
                        <span className="text-muted-foreground">
                          Aktif:{" "}
                          <span className="font-medium text-foreground">
                            {providerLabel(dv.active.provider)} · {dv.active.model || "?"}
                          </span>{" "}
                          <span className="text-muted-foreground/70">
                            ({dv.active.source === "user" ? "kunci sendiri" : "default admin"})
                          </span>
                        </span>
                      ) : (
                        <span className="text-muted-foreground">
                          Belum aktif —{" "}
                          {dv?.adminAvailable
                            ? "default admin tersedia."
                            : "belum ada config (atur entri di bawah)."}
                        </span>
                      )}
                      <div className="flex-1" />
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-xs"
                        disabled={testingActive || !dv?.active}
                        onClick={() => void testActiveCategory()}
                      >
                        {testingActive ? (
                          <Loader2 className="h-3 w-3 animate-spin mr-1" />
                        ) : (
                          <PlugZap className="h-3 w-3 mr-1" />
                        )}
                        Tes aktif
                      </Button>
                    </div>

                    {activeTest && tab === c ? (
                      <div
                        className={cn(
                          "rounded-md border px-3 py-2 text-xs leading-relaxed",
                          activeTest.ok
                            ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                            : "border-destructive/40 bg-destructive/10 text-destructive"
                        )}
                      >
                        {activeTest.text}
                      </div>
                    ) : null}

                    {/* Ikut default admin */}
                    <div className="flex items-start justify-between gap-3 rounded-md border px-3 py-2.5">
                      <div className="space-y-0.5">
                        <Label htmlFor={`follow-${c}`} className="text-xs">
                          Ikuti default admin
                        </Label>
                        <p className="text-[11px] text-muted-foreground leading-relaxed">
                          {dv?.adminAvailable
                            ? `Default admin kategori ini: ${providerLabel(
                                dv.active?.provider ?? ""
                              )}${dv.active?.model ? ` · ${dv.active.model}` : ""}.`
                            : "Admin belum mengatur default untuk kategori ini — susun rantai sendiri di bawah."}
                        </p>
                      </div>
                      <Switch
                        id={`follow-${c}`}
                        checked={cd.followDefault}
                        onCheckedChange={(v) =>
                          setDrafts((d) => ({
                            ...d,
                            [c]: {
                              followDefault: v,
                              entries: v
                                ? []
                                : d[c].entries.length
                                  ? d[c].entries
                                  : [newChainEntry()],
                            },
                          }))
                        }
                      />
                    </div>

                    {!cd.followDefault ? (
                      <AiChainEditor
                        entries={cd.entries}
                        onChange={(next) => setDraft({ followDefault: false, entries: next })}
                        onTestEntry={testEntry}
                        vision={c === "vision"}
                      />
                    ) : null}
                  </div>
                </TabsContent>
              );
            })}
          </Tabs>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Tutup
          </Button>
          <Button onClick={save} disabled={loading || saving}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin mr-1.5" /> : null}
            Simpan {TAB_META[tab].label}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
