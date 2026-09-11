"use client";

// ─────────────────────────────────────────────────────────────────────
// Admin Panel → tab Teman AI: atur provider & API key DEFAULT untuk
// semua user (disimpan terenkripsi di AppSetting "ai.default").
// User tetap bisa memakai kunci sendiri di pengaturan Teman AI.
// ─────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2, KeyRound, Trash2, Info, CheckCircle2, XCircle, PlugZap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PROVIDERS, PROVIDER_IDS, providerLabel } from "@/lib/ai-providers";
import { cn } from "@/lib/utils";

interface AdminAiDefault {
  provider: string;
  baseUrl: string | null;
  model: string | null;
  hasKey: boolean;
  keyMask: string | null;
  usable: boolean;
}

export function AiDefaultPanel() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [data, setData] = useState<AdminAiDefault | null>(null);

  const [provider, setProvider] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [clearKey, setClearKey] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/ai", { cache: "no-store" });
      if (!res.ok) throw new Error();
      const json: AdminAiDefault = await res.json();
      setData(json);
      setProvider(json.provider ?? "");
      setBaseUrl(json.baseUrl ?? "");
      setModel(json.model ?? "");
      setApiKey("");
      setClearKey(false);
    } catch {
      toast.error("Gagal memuat default Teman AI.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function switchProvider(p: string) {
    setProvider(p);
    setClearKey(false);
    setTestResult(null);
    const preset = PROVIDERS[p as keyof typeof PROVIDERS];
    if (preset) {
      setBaseUrl(preset.baseUrl);
      setModel(preset.models[0] ?? "");
    }
  }

  async function testConnection() {
    if (!provider) {
      toast.error("Pilih provider dulu sebelum dites.");
      return;
    }
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch("/api/ai/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider,
          baseUrl: baseUrl.trim() || undefined,
          model: model.trim() || undefined,
          apiKey: apiKey.trim() || undefined,
          scope: "admin",
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (json?.ok) {
        const replyTxt = json.reply ? ` dan menjawab: “${json.reply}”` : "";
        setTestResult({ ok: true, text: `Tersambung! Model “${json.model ?? "?"}” berfungsi${replyTxt}.` });
        toast.success("Sambungan default Teman AI OK");
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
    if (provider === "") {
      toast.error("Pilih provider dulu, atau pakai tombol Nonaktifkan default.");
      return;
    }
    if (!baseUrl.trim() || !/^https?:\/\/.+/i.test(baseUrl.trim())) {
      toast.error("Base URL wajib diisi dan harus mulai http:// atau https://.");
      return;
    }
    const preset = PROVIDERS[provider as keyof typeof PROVIDERS];
    if (!preset?.noKeyNeeded && !apiKey.trim() && !(data?.hasKey && !clearKey)) {
      toast.error("API key wajib diisi untuk provider ini.");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/admin/ai", {
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
        toast.error(json.error ?? "Gagal menyimpan default.");
        return;
      }
      toast.success("Default Teman AI tersimpan — dipakai user tanpa kunci sendiri.");
      setApiKey("");
      await load();
    } catch {
      toast.error("Gagal menyimpan default.");
    } finally {
      setSaving(false);
    }
  }

  async function disableDefault() {
    setSaving(true);
    try {
      const res = await fetch("/api/admin/ai", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "" }),
      });
      if (!res.ok) throw new Error();
      toast.success("Default dimatikan — setiap user harus pasang kunci sendiri.");
      await load();
    } catch {
      toast.error("Gagal menonaktifkan default.");
    } finally {
      setSaving(false);
    }
  }

  const preset = provider ? PROVIDERS[provider as keyof typeof PROVIDERS] : null;

  return (
    <div className="max-w-2xl">
      <div className="rounded-lg border bg-card p-4 md:p-5 space-y-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="font-semibold flex items-center gap-2">
              <KeyRound className="h-4 w-4 text-primary" /> Default Teman AI
            </h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              User tanpa pengaturan sendiri otomatis memakai provider & kunci ini.
            </p>
          </div>
          {data ? (
            data.usable ? (
              <Badge className="gap-1 bg-emerald-600 hover:bg-emerald-600">
                <CheckCircle2 className="h-3.5 w-3.5" /> aktif
              </Badge>
            ) : (
              <Badge variant="destructive" className="gap-1">
                <XCircle className="h-3.5 w-3.5" /> belum siap
              </Badge>
            )
          ) : null}
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-10 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin mr-2" /> Memuat…
          </div>
        ) : (
          <>
            <div className="rounded-md border bg-muted/40 px-3 py-2 flex items-start gap-2">
              <Info className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground" />
              <p className="text-xs text-muted-foreground">
                User bisa memakai <strong className="text-foreground">kunci sendiri</strong> di
                pengaturan Teman AI (ChatGPT, DeepSeek, OpenRouter, Gemini, Ollama, atau base URL
                kustom) — pengaturan per-user selalu menang atas default ini.
              </p>
            </div>

            {/* Provider */}
            <div className="space-y-1.5">
              <Label>Provider</Label>
              <Select value={provider || "none"} onValueChange={(v) => switchProvider(v === "none" ? "" : v)}>
                <SelectTrigger>
                  <SelectValue placeholder="Pilih provider default" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none" disabled>
                    Belum ada default
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
                <div className="space-y-1.5">
                  <Label htmlFor="adm-ai-baseurl">Base URL</Label>
                  <Input
                    id="adm-ai-baseurl"
                    value={baseUrl}
                    onChange={(e) => setBaseUrl(e.target.value)}
                    placeholder="https://api.provider.com/v1"
                    autoComplete="off"
                  />
                  {preset?.hint ? (
                    <p className="text-xs text-muted-foreground">{preset.hint}</p>
                  ) : null}
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="adm-ai-model">Model</Label>
                  <Input
                    id="adm-ai-model"
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

                <div className="space-y-1.5">
                  <Label htmlFor="adm-ai-key" className="flex items-center gap-1.5">
                    <KeyRound className="h-3.5 w-3.5" /> API Key default
                  </Label>
                  <Input
                    id="adm-ai-key"
                    type="password"
                    value={apiKey}
                    onChange={(e) => {
                      setApiKey(e.target.value);
                      setClearKey(false);
                    }}
                    placeholder={
                      data?.hasKey && !clearKey
                        ? `•••••••• (tersimpan${data.keyMask ? `: ${data.keyMask}` : ""})`
                        : "tempel API key milik sekolah/organisasi"
                    }
                    autoComplete="new-password"
                  />
                  <p className="text-xs text-muted-foreground">
                    {data?.hasKey && !clearKey
                      ? "Kosongkan untuk memakai kunci yang sudah tersimpan."
                      : "Disimpan terenkripsi (AES-256-GCM) — tidak pernah dibaca balik."}
                  </p>
                  {data?.hasKey ? (
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
                      {clearKey ? "Batal hapus (kunci tetap tersimpan)" : "Hapus kunci tersimpan"}
                    </Button>
                  ) : null}
                </div>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">
                Belum ada default aktif
                {data?.provider === "" ? "" : ` (${providerLabel(data?.provider)})`}
                . User harus memasang kunci sendiri untuk memakai Teman AI.
              </p>
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

            <div className="flex flex-wrap items-center gap-2 pt-1">
              <Button
                type="button"
                variant="outline"
                onClick={testConnection}
                disabled={saving || testing}
              >
                {testing ? (
                  <Loader2 className="h-4 w-4 animate-spin mr-1.5" />
                ) : (
                  <PlugZap className="h-4 w-4 mr-1.5" />
                )}
                Tes sambungan
              </Button>
              <Button onClick={save} disabled={saving}>
                {saving ? <Loader2 className="h-4 w-4 animate-spin mr-1.5" /> : null}
                Simpan default
              </Button>
              {data?.provider || data?.hasKey ? (
                <Button
                  variant="outline"
                  onClick={disableDefault}
                  disabled={saving}
                  className="text-destructive hover:text-destructive"
                >
                  Nonaktifkan default
                </Button>
              ) : null}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
