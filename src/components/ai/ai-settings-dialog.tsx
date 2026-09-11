"use client";

// ─────────────────────────────────────────────────────────────────────
// Dialog pengaturan Teman AI (BYOK per user).
// Pilih provider, base URL, model, dan API key milik sendiri.
// Kunci lama tidak pernah dikirim balik — kosongkan input = pertahankan.
// ─────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2, KeyRound, Trash2, Info, PlugZap } from "lucide-react";
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
import { PROVIDERS, PROVIDER_IDS, providerLabel } from "@/lib/ai-providers";
import { cn } from "@/lib/utils";

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
}

export async function fetchAiSettings(): Promise<AiSettingsData | null> {
  const res = await fetch("/api/ai/settings", { cache: "no-store" });
  if (!res.ok) return null;
  return res.json();
}

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

  const [provider, setProvider] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [clearKey, setClearKey] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<
    { ok: boolean; text: string } | null
  >(null);

  const load = useCallback(async () => {
    setLoading(true);
    const d = await fetchAiSettings();
    setData(d);
    setProvider(d?.user.provider ?? "");
    setBaseUrl(d?.user.baseUrl ?? "");
    setModel(d?.user.model ?? "");
    setApiKey("");
    setClearKey(false);
    setLoading(false);
  }, []);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  function switchProvider(p: string) {
    setProvider(p);
    setClearKey(false);
    setTestResult(null);
    if (p === "") return; // ikuti default admin
    const preset = PROVIDERS[p as keyof typeof PROVIDERS];
    if (preset) {
      setBaseUrl(preset.baseUrl);
      setModel(preset.models[0] ?? "");
    }
  }

  async function testConnection() {
    setTesting(true);
    setTestResult(null);
    try {
      const body =
        provider === ""
          ? {} // tes config aktif (user → default admin)
          : {
              provider,
              baseUrl: baseUrl.trim() || undefined,
              model: model.trim() || undefined,
              apiKey: apiKey.trim() || undefined,
            };
      const res = await fetch("/api/ai/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => ({}));
      if (json?.ok) {
        const replyTxt = json.reply ? ` dan menjawab: “${json.reply}”` : "";
        setTestResult({
          ok: true,
          text: `Tersambung! Model “${json.model ?? "?"}” berfungsi${replyTxt}.`,
        });
        toast.success("Sambungan Teman AI OK");
      } else {
        setTestResult({ ok: false, text: json?.error ?? "Tes gagal — coba lagi." });
      }
    } catch {
      setTestResult({ ok: false, text: "Gagal menghubungi server untuk tes." });
    } finally {
      setTesting(false);
    }
  }

  async function save() {
    if (provider !== "") {
      const preset = PROVIDERS[provider as keyof typeof PROVIDERS];
      if (!baseUrl.trim()) {
        toast.error("Base URL wajib diisi untuk provider ini.");
        return;
      }
      if (!/^https?:\/\/.+/i.test(baseUrl.trim())) {
        toast.error("Base URL harus mulai dengan http:// atau https://.");
        return;
      }
      // Provider selain ollama disarankan memasang kunci.
      if (!preset?.noKeyNeeded && !apiKey.trim() && !(data?.user.hasKey && !clearKey)) {
        toast.error("API key wajib diisi untuk provider ini.");
        return;
      }
    }
    setSaving(true);
    try {
      const res = await fetch("/api/ai/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider,
          baseUrl: baseUrl.trim(),
          model: model.trim(),
          apiKey: apiKey.trim() || undefined,
          clearKey: clearKey || undefined,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(json.error ?? "Gagal menyimpan pengaturan.");
        return;
      }
      toast.success(
        provider === ""
          ? "Kembali mengikuti default admin."
          : "Pengaturan Teman AI tersimpan."
      );
      onSaved?.();
      onOpenChange(false);
    } catch {
      toast.error("Gagal menyimpan pengaturan.");
    } finally {
      setSaving(false);
    }
  }

  const preset = provider ? PROVIDERS[provider as keyof typeof PROVIDERS] : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Pengaturan Teman AI</DialogTitle>
          <DialogDescription>
            Pakai API key milikmu sendiri (bawa kunci sendiri) atau ikuti
            default yang diatur admin. Kunci disimpan terenkripsi di server.
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-10 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin mr-2" /> Memuat…
          </div>
        ) : (
          <div className="space-y-4">
            {/* Default admin */}
            <div className="rounded-md border bg-muted/40 px-3 py-2 flex items-start gap-2">
              <Info className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground" />
              <p className="text-xs text-muted-foreground">
                Default admin:{" "}
                {data?.default.available ? (
                  <span className="font-medium text-foreground">
                    {providerLabel(data.default.provider)}
                    {data.default.model ? ` · ${data.default.model}` : ""}
                  </span>
                ) : (
                  <span className="font-medium text-foreground">belum tersedia</span>
                )}
                . Pilih &quot;Ikuti default admin&quot; untuk memakainya.
              </p>
            </div>

            {/* Provider */}
            <div className="space-y-1.5">
              <Label htmlFor="ai-provider">Provider</Label>
              <Select value={provider || "follow"} onValueChange={(v) => switchProvider(v === "follow" ? "" : v)}>
                <SelectTrigger id="ai-provider">
                  <SelectValue placeholder="Pilih provider" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="follow">
                    Ikuti default admin{data?.default.available ? "" : " (belum tersedia)"}
                  </SelectItem>
                  {PROVIDER_IDS.map((p) => (
                    <SelectItem key={p} value={p}>
                      {PROVIDERS[p].label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {provider !== "" ? (
              <>
                {/* Base URL */}
                <div className="space-y-1.5">
                  <Label htmlFor="ai-baseurl">Base URL</Label>
                  <Input
                    id="ai-baseurl"
                    value={baseUrl}
                    onChange={(e) => setBaseUrl(e.target.value)}
                    placeholder="https://api.provider.com/v1"
                    autoComplete="off"
                  />
                  {preset?.hint ? (
                    <p className="text-xs text-muted-foreground">{preset.hint}</p>
                  ) : null}
                </div>

                {/* Model */}
                <div className="space-y-1.5">
                  <Label htmlFor="ai-model">Model</Label>
                  <Input
                    id="ai-model"
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                    placeholder="nama model, mis. gpt-4o-mini"
                  />
                  {preset?.models?.length ? (
                    <div className="flex flex-wrap gap-1.5 pt-1">
                      {preset.models.map((m) => (
                        <button
                          key={m}
                          type="button"
                          onClick={() => setModel(m)}
                          className={cn(
                            "rounded-full border px-2.5 py-0.5 text-xs transition-colors",
                            model === m
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

                {/* API key */}
                <div className="space-y-1.5">
                  <Label htmlFor="ai-key" className="flex items-center gap-1.5">
                    <KeyRound className="h-3.5 w-3.5" /> API Key
                    {preset?.noKeyNeeded ? (
                      <span className="text-[11px] font-normal text-muted-foreground">
                        (opsional — provider ini bebas kunci)
                      </span>
                    ) : null}
                  </Label>
                  <Input
                    id="ai-key"
                    type="password"
                    value={apiKey}
                    onChange={(e) => {
                      setApiKey(e.target.value);
                      setClearKey(false);
                    }}
                    placeholder={
                      data?.user.hasKey && !clearKey
                        ? `•••••••• (tersimpan${data.user.keyMask ? `: ${data.user.keyMask}` : ""})`
                        : "tempel API key di sini"
                    }
                    autoComplete="new-password"
                  />
                  <p className="text-xs text-muted-foreground">
                    {data?.user.hasKey && !clearKey
                      ? "Kosongkan untuk memakai kunci yang sudah tersimpan."
                      : "Kunci dienkripsi (AES-256-GCM) dan tidak pernah dibaca balik."}
                  </p>
                  {data?.user.hasKey ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className={cn(
                        "h-7 text-destructive hover:text-destructive",
                        clearKey && "opacity-60"
                      )}
                      onClick={() => setClearKey((c) => !c)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      {clearKey
                        ? "Batal hapus (kunci tetap tersimpan)"
                        : "Hapus kunci tersimpan"}
                    </Button>
                  ) : null}
                </div>
              </>
            ) : null}
          </div>
        )}

        {testResult ? (
          <div
            className={cn(
              "rounded-md border px-3 py-2 text-xs leading-relaxed",
              testResult.ok
                ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                : "border-destructive/40 bg-destructive/10 text-destructive"
            )}
          >
            {testResult.text}
          </div>
        ) : null}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={testConnection}
            disabled={loading || saving || testing}
          >
            {testing ? (
              <Loader2 className="h-4 w-4 animate-spin mr-1.5" />
            ) : (
              <PlugZap className="h-4 w-4 mr-1.5" />
            )}
            Tes sambungan
          </Button>
          <div className="flex-1" />
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Batal
          </Button>
          <Button onClick={save} disabled={loading || saving}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin mr-1.5" /> : null}
            Simpan
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
