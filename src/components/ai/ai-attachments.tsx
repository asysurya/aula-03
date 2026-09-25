"use client";

// ── Lampiran materi untuk SEMUA fitur AI — MODAL FILE EXPLORER ────────
// Dipakai: Teman AI, Pusat Belajar (Teman Belajar/Buat Materi/Alat
// Materi), AI Builder, dan generator soal tugas. Tombol paperclip
// membuka modal penjelajah materi (seperti pemilih lampiran di aplikasi
// chat) dengan 4 tab:
//   • Unggah — pilih berkas (format APA PUN) atau tarik-lepas
//   • Cloud — tautan http/https (Google Drive/Dropbox/OneDrive/GitHub/
//             URL langsung) → POST /api/ai/attachments/import {url}
//   • Mount — FILE EXPLORER folder server (NAS/drive bersama):
//             GET import?path → daftar folder/berkas, navigasi + pilih
//             multi-berkas → POST import {path} per berkas; dibatasi
//             env AI_MOUNT_ROOTS di server
//   • Teks  — materi tulisan tangan (hanya bila fitur belum punya
//             kolom materi sendiri — allowText)
// Id lampiran dikirim ulang pada request AI (attachmentIds) — konteks
// digabung server-side, tanpa membebani body request AI.
// Input berkas tersembunyi tetap dirender DI LUAR modal sehingga alur
// lama (upload langsung tanpa membuka modal) tetap berfungsi.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowUp,
  CheckCircle2,
  Circle,
  Cloud,
  FileText,
  Folder,
  HardDrive,
  Loader2,
  Paperclip,
  Type,
  Upload,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

export interface AiAttachFileMeta {
  id: string;
  name: string;
  kind: string;
  chars: number;
  note?: string;
  /** Asal: "cloud" | "mount" | undefined (= upload biasa). */
  source?: string;
  /** URL cloud / path mount asal (untuk tooltip chip). */
  origin?: string;
}

export interface AiAttachmentsState {
  files: AiAttachFileMeta[];
  text: string;
  textOpen: boolean;
  uploading: boolean;
  setText: (v: string) => void;
  setTextOpen: (v: boolean) => void;
  pickFiles: (fl: FileList | null) => Promise<void>;
  importFromUrl: (url: string) => Promise<boolean>;
  importFromPath: (p: string) => Promise<boolean>;
  removeFile: (id: string) => void;
  clearAll: () => void;
  /** Id lampiran aktif — untuk body request AI (attachmentIds). */
  ids: string[];
  /** Ada materi apa pun (teks / file)? */
  hasAny: boolean;
}

export function useAiAttachments(): AiAttachmentsState {
  const [files, setFiles] = useState<AiAttachFileMeta[]>([]);
  const [text, setText] = useState("");
  const [textOpen, setTextOpen] = useState(false);
  const [uploading, setUploading] = useState(false);

  const pickFiles = useCallback(async (fl: FileList | null) => {
    if (!fl || fl.length === 0) return;
    const list = Array.from(fl);
    setUploading(true);
    const added: AiAttachFileMeta[] = [];
    try {
      for (const f of list) {
        if (f.size > 4 * 1024 * 1024) {
          toast.error(`"${f.name}" terlalu besar (maks 4 MB)`);
          continue;
        }
        const fd = new FormData();
        fd.append("file", f);
        try {
          const res = await fetch("/api/ai/attachments", {
            method: "POST",
            body: fd,
          });
          const json = await res.json().catch(() => null);
          if (!res.ok || !json?.attachment?.id) {
            toast.error(json?.error ?? `Gagal melampirkan "${f.name}"`);
            continue;
          }
          added.push(json.attachment as AiAttachFileMeta);
        } catch {
          toast.error(`Gagal melampirkan "${f.name}" — coba lagi.`);
        }
      }
      if (added.length) {
        setFiles((prev) => [...prev, ...added]);
        const names = added.map((a) => `"${a.name}"`).join(", ");
        toast.success(
          `${added.length} lampiran siap: ${names}`.slice(0, 120),
          {
            description: added
              .map((a) => `${a.kind}${a.chars ? ` · ${a.chars} karakter terbaca` : " · biner"}`)
              .join(" · ")
              .slice(0, 160),
          }
        );
      }
    } finally {
      setUploading(false);
    }
  }, []);

  // ── impor dari cloud (URL) / mount (path server) ──
  const doImport = useCallback(
    async (payload: { url?: string; path?: string }): Promise<boolean> => {
      setUploading(true);
      try {
        const res = await fetch("/api/ai/attachments/import", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const json = await res.json().catch(() => null);
        if (!res.ok || !json?.attachment?.id) {
          toast.error(json?.error ?? "Gagal mengimpor materi");
          return false;
        }
        const a = json.attachment as AiAttachFileMeta;
        setFiles((prev) => [...prev, a]);
        toast.success(`"${a.name}" siap dipakai`.slice(0, 120), {
          description:
            `${a.kind}${a.chars ? ` · ${a.chars.toLocaleString("id-ID")} karakter terbaca` : " · biner"} · dari ${a.source === "mount" ? "mount" : "cloud"}`,
        });
        return true;
      } catch {
        toast.error("Gagal mengimpor materi — coba lagi.");
        return false;
      } finally {
        setUploading(false);
      }
    },
    []
  );

  const importFromUrl = useCallback(
    (url: string) => doImport({ url: url.trim() }),
    [doImport]
  );
  const importFromPath = useCallback(
    (p: string) => doImport({ path: p.trim() }),
    [doImport]
  );

  const removeFile = useCallback((id: string) => {
    setFiles((prev) => prev.filter((f) => f.id !== id));
  }, []);

  const clearAll = useCallback(() => {
    setFiles([]);
    setText("");
    setTextOpen(false);
  }, []);

  return {
    files,
    text,
    textOpen,
    uploading,
    setText,
    setTextOpen,
    pickFiles,
    importFromUrl,
    importFromPath,
    removeFile,
    clearAll,
    ids: files.map((f) => f.id),
    hasAny: files.length > 0 || text.trim().length > 0,
  };
}

function ChipIcon({ source }: { source?: string }) {
  if (source === "cloud")
    return <Cloud className="size-3.5 shrink-0 text-sky-500" />;
  if (source === "mount")
    return <HardDrive className="size-3.5 shrink-0 text-amber-500" />;
  return <FileText className="size-3.5 shrink-0 text-primary" />;
}

function humanSize(n: number): string {
  if (n <= 0) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// ── Entri file explorer mount ─────────────────────────────────────────
interface MEntry {
  name: string;
  path: string;
  dir: boolean;
  size: number;
  ext: string;
}

function MountExplorer({
  att,
  onBusy,
}: {
  att: AiAttachmentsState;
  onBusy: (b: boolean) => void;
}) {
  const [roots, setRoots] = useState<{ path: string; name: string }[] | null>(null);
  const [cur, setCur] = useState<{ path: string; parent: string | null } | null>(null);
  const [entries, setEntries] = useState<MEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [importing, setImporting] = useState(false);

  const loadRoots = useCallback(async () => {
    setLoading(true);
    setErr("");
    try {
      const res = await fetch("/api/ai/attachments/import");
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        setErr(json?.error ?? "Gagal membaca folder server");
        setRoots([]);
        return;
      }
      setRoots(json.roots ?? []);
    } catch {
      setErr("Gagal membaca folder server");
      setRoots([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadDir = useCallback(async (p: string) => {
    setLoading(true);
    setErr("");
    try {
      const res = await fetch(
        `/api/ai/attachments/import?path=${encodeURIComponent(p)}`
      );
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        setErr(json?.error ?? "Gagal membaca folder");
        return;
      }
      setCur({ path: json.path, parent: json.parent ?? null });
      setEntries(json.entries ?? []);
    } catch {
      setErr("Gagal membaca folder");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadRoots();
  }, [loadRoots]);

  const toggleSel = (p: string) => {
    setSelected((prev) =>
      prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p]
    );
  };

  const importSelected = async () => {
    if (!selected.length || importing) return;
    setImporting(true);
    onBusy(true);
    let okCount = 0;
    try {
      for (const p of selected) {
        if (await att.importFromPath(p)) okCount++;
      }
      if (okCount) {
        toast.success(`${okCount} materi mount dilampirkan`);
        setSelected([]);
      }
    } finally {
      setImporting(false);
      onBusy(false);
    }
  };

  const atRootList = cur === null;

  return (
    <div className="flex flex-col gap-2" data-ai-mount-explorer="1">
      {/* baris atas: breadcrumb + tombol naik */}
      <div className="flex items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-7 gap-1 text-xs"
          disabled={atRootList || loading}
          aria-label="Folder induk"
          onClick={() => {
            setSelected([]);
            if (cur?.parent) void loadDir(cur.parent);
            else {
              setCur(null);
              void loadRoots();
            }
          }}
        >
          <ArrowUp className="size-3.5" />
          Naik
        </Button>
        <div
          className="flex-1 truncate rounded-md border border-border bg-muted/40 px-2 py-1 text-xs text-muted-foreground"
          data-ai-mount-cwd={cur ? cur.path : ""}
          title={cur ? cur.path : "Folder materi server"}
        >
          <HardDrive className="mr-1 inline size-3.5 text-amber-500" />
          {cur ? cur.path.replace(/^\/(home|mnt)\//, (m) => `${m}`) : "Folder materi server"}
        </div>
      </div>

      {/* isi explorer */}
      <div className="max-h-64 min-h-[160px] overflow-y-auto rounded-md border border-border">
        {loading ? (
          <div className="flex h-40 items-center justify-center text-muted-foreground">
            <Loader2 className="mr-2 size-4 animate-spin" /> Memuat…
          </div>
        ) : err ? (
          <div className="flex h-40 items-center justify-center px-4 text-center text-xs text-destructive">
            {err}
          </div>
        ) : atRootList ? (
          (roots ?? []).length === 0 ? (
            <div className="flex h-40 items-center justify-center px-4 text-center text-xs text-muted-foreground">
              Tidak ada folder materi server yang terpasang (AI_MOUNT_ROOTS).
            </div>
          ) : (
            <ul className="p-1">
              {(roots ?? []).map((r) => (
                <li key={r.path}>
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-muted"
                    data-ai-mount-root={r.name}
                    onClick={() => void loadDir(r.path)}
                  >
                    <HardDrive className="size-4 shrink-0 text-amber-500" />
                    <span className="font-medium">{r.name}</span>
                    <span className="truncate text-muted-foreground">
                      {r.path}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )
        ) : (
          <ul className="p-1">
            {entries.length === 0 ? (
              <li className="px-2 py-6 text-center text-xs text-muted-foreground">
                Folder kosong
              </li>
            ) : (
              entries.map((e) => (
                <li key={e.path}>
                  <button
                    type="button"
                    className={cn(
                      "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-muted",
                      selected.includes(e.path) && "bg-primary/10"
                    )}
                    data-ai-mount-entry={e.name}
                    data-ai-mount-dir={e.dir ? "1" : "0"}
                    onClick={() => {
                      if (e.dir) {
                        setSelected([]);
                        void loadDir(e.path);
                      } else {
                        toggleSel(e.path);
                      }
                    }}
                  >
                    {e.dir ? (
                      <Folder className="size-4 shrink-0 text-sky-500" />
                    ) : selected.includes(e.path) ? (
                      <CheckCircle2 className="size-4 shrink-0 text-primary" />
                    ) : (
                      <Circle className="size-4 shrink-0 text-muted-foreground" />
                    )}
                    <span className="truncate font-medium">{e.name}</span>
                    {!e.dir ? (
                      <span className="ml-auto shrink-0 text-[11px] uppercase text-muted-foreground">
                        {e.ext || "berkas"} · {humanSize(e.size)}
                      </span>
                    ) : (
                      <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">
                        folder
                      </span>
                    )}
                  </button>
                </li>
              ))
            )}
          </ul>
        )}
      </div>

      {/* baris bawah: pilihan + tombol impor */}
      <div className="flex items-center gap-2">
        <span className="text-[11px] text-muted-foreground">
          {selected.length} dipilih
        </span>
        <Button
          type="button"
          size="sm"
          className="ml-auto h-7 gap-1.5 text-xs"
          aria-label="Impor dari mount"
          disabled={importing || selected.length === 0}
          onClick={() => void importSelected()}
        >
          {importing ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <HardDrive className="size-3.5" />
          )}
          Impor terpilih ({selected.length})
        </Button>
      </div>
    </div>
  );
}

export function AiAttachments({
  att,
  allowText = true,
  label = "Lampirkan materi",
  compact = false,
  className,
}: {
  att: AiAttachmentsState;
  /** Tampilkan sumber teks (false bila fitur sudah punya kolom teks
   *  materi sendiri — konteks teks digabungkan lewat sana). */
  allowText?: boolean;
  label?: string;
  compact?: boolean;
  className?: string;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [open, setOpen] = useState(false);
  const [cloudVal, setCloudVal] = useState("");
  const [busyModal, setBusyModal] = useState(false);

  const submitCloud = () => {
    if (!cloudVal.trim()) return;
    void att.importFromUrl(cloudVal).then((ok) => {
      if (ok) setCloudVal("");
    });
  };

  return (
    <div className={cn("w-full", className)} data-ai-attach="1">
      <div className="flex items-center gap-1.5 flex-wrap">
        {/* input berkas tetap di luar modal: alur upload langsung
            (mis. otomasi) tetap berfungsi tanpa membuka modal */}
        <input
          ref={inputRef}
          type="file"
          multiple
          className="hidden"
          aria-label="Pilih berkas materi"
          onChange={(e) => {
            void att.pickFiles(e.target.files);
            e.target.value = "";
          }}
        />
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-7 gap-1.5 text-xs"
          disabled={att.uploading}
          aria-label="Lampirkan materi"
          data-ai-attach-open="1"
          onClick={() => setOpen(true)}
          title="Lampirkan materi — unggah berkas, tautan cloud, atau folder server"
        >
          {att.uploading ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Paperclip className="size-3.5" />
          )}
          {label}
        </Button>
        {allowText ? (
          <Button
            type="button"
            size="sm"
            variant={att.textOpen ? "secondary" : "outline"}
            className="h-7 gap-1.5 text-xs"
            onClick={() => att.setTextOpen(!att.textOpen)}
            title="Tulis materi tambahan sebagai teks"
          >
            <Type className="size-3.5" />
            Materi teks
          </Button>
        ) : null}
        {att.files.length > 0 && !compact ? (
          <span className="text-[11px] text-muted-foreground">
            {att.files.length} lampiran
            {att.text.trim() ? " + teks" : ""}
          </span>
        ) : null}
      </div>

      {att.files.length > 0 ? (
        <ul className="mt-1.5 space-y-1">
          {att.files.map((f) => (
            <li
              key={f.id}
              data-ai-attach-chip={f.name}
              data-ai-attach-source={f.source ?? "upload"}
              className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-border bg-muted/40 pl-2 pr-1 py-0.5 text-xs"
              title={f.origin ? `${f.origin}` : f.name}
            >
              <ChipIcon source={f.source} />
              <span className="truncate max-w-[220px]" title={f.name}>
                {f.name}
              </span>
              <span className="shrink-0 text-muted-foreground">
                {f.kind}
                {f.chars ? ` · ${f.chars.toLocaleString("id-ID")} kr` : ""}
                {f.source === "cloud" ? " · cloud" : f.source === "mount" ? " · mount" : ""}
              </span>
              <button
                type="button"
                className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-destructive"
                onClick={() => att.removeFile(f.id)}
                aria-label={`Lepas lampiran ${f.name}`}
              >
                <X className="size-3" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {allowText && att.textOpen ? (
        <textarea
          value={att.text}
          onChange={(e) => att.setText(e.target.value)}
          data-ai-attach-text="1"
          placeholder="Materi tambahan (teks) — tempel catatan, rangkuman, atau bahan apa pun…"
          className="mt-1.5 w-full min-h-[72px] max-h-40 rounded-md border border-border bg-background px-2.5 py-1.5 text-xs outline-none focus:ring-1 focus:ring-ring resize-y"
        />
      ) : null}

      {/* ══ MODAL FILE EXPLORER ══ */}
      <Dialog open={open} onOpenChange={(v) => !busyModal && setOpen(v)}>
        <DialogContent className="sm:max-w-xl" data-ai-modal="lampiran">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base">
              <Paperclip className="size-4" />
              Lampirkan materi
            </DialogTitle>
            <DialogDescription className="text-xs">
              Unggah berkas format apa pun, ambil dari tautan cloud, telusuri
              folder materi server, atau tulis teks.
            </DialogDescription>
          </DialogHeader>

          <Tabs defaultValue="unggah" data-ai-tabs="1">
            <TabsList
              className={cn(
                "grid w-full",
                allowText ? "grid-cols-4" : "grid-cols-3"
              )}
            >
              <TabsTrigger value="unggah" className="gap-1.5 text-xs">
                <Upload className="size-3.5" />
                Unggah
              </TabsTrigger>
              <TabsTrigger value="cloud" className="gap-1.5 text-xs">
                <Cloud className="size-3.5" />
                Cloud
              </TabsTrigger>
              <TabsTrigger value="mount" className="gap-1.5 text-xs">
                <HardDrive className="size-3.5" />
                Mount
              </TabsTrigger>
              {allowText ? (
                <TabsTrigger value="teks" className="gap-1.5 text-xs">
                  <Type className="size-3.5" />
                  Teks
                </TabsTrigger>
              ) : null}
            </TabsList>

            {/* ── Tab: Unggah ── */}
            <TabsContent value="unggah" className="pt-3">
              <button
                type="button"
                data-ai-drop="1"
                className="flex w-full flex-col items-center justify-center gap-1.5 rounded-lg border-2 border-dashed border-border bg-muted/30 px-4 py-8 text-center text-xs text-muted-foreground transition hover:border-primary/50 hover:bg-muted/50"
                onClick={() => inputRef.current?.click()}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  void att.pickFiles(e.dataTransfer.files);
                }}
              >
                {att.uploading ? (
                  <Loader2 className="size-6 animate-spin" />
                ) : (
                  <Upload className="size-6" />
                )}
                <span className="font-medium text-foreground">
                  Tarik-lepas berkas ke sini atau klik untuk memilih
                </span>
                <span>
                  Format apa pun (PDF, DOCX, XLSX, ZIP, EPUB, teks, kode,
                  gambar…) — maks 4 MB per berkas
                </span>
              </button>
            </TabsContent>

            {/* ── Tab: Cloud ── */}
            <TabsContent value="cloud" className="pt-3">
              <div className="flex items-center gap-1.5" data-ai-import-cloud="1">
                <input
                  value={cloudVal}
                  onChange={(e) => setCloudVal(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      submitCloud();
                    }
                  }}
                  aria-label="URL materi cloud"
                  placeholder="Tautan cloud — https://drive.google.com/… atau URL langsung"
                  className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-xs outline-none focus:ring-1 focus:ring-ring"
                />
                <Button
                  type="button"
                  size="sm"
                  className="h-8 gap-1 text-xs"
                  aria-label="Impor dari cloud"
                  disabled={att.uploading || !cloudVal.trim()}
                  onClick={submitCloud}
                >
                  {att.uploading ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <Cloud className="size-3.5" />
                  )}
                  Impor
                </Button>
              </div>
              <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
                Mendukung tautan berbagi Google Drive, Dropbox, OneDrive,
                berkas GitHub, maupun URL langsung. Pastikan izin berbagi
                "siapa saja yang punya tautan". Berkas diunduh dan dibaca di
                server (maks 4 MB).
              </p>
            </TabsContent>

            {/* ── Tab: Mount (file explorer) ── */}
            <TabsContent value="mount" className="pt-3">
              <MountExplorer att={att} onBusy={setBusyModal} />
            </TabsContent>

            {/* ── Tab: Teks ── */}
            {allowText ? (
              <TabsContent value="teks" className="pt-3">
                <textarea
                  value={att.text}
                  onChange={(e) => att.setText(e.target.value)}
                  aria-label="Materi teks"
                  placeholder="Materi tambahan (teks) — tempel catatan, rangkuman, atau bahan apa pun…"
                  className="w-full min-h-[160px] rounded-md border border-border bg-background px-2.5 py-2 text-xs outline-none focus:ring-1 focus:ring-ring resize-y"
                />
              </TabsContent>
            ) : null}
          </Tabs>

          <DialogFooter className="flex items-center justify-between gap-2 sm:justify-between">
            <span className="text-[11px] text-muted-foreground">
              {att.files.length} lampiran aktif
              {att.text.trim() ? " + teks" : ""}
            </span>
            <Button
              type="button"
              size="sm"
              className="h-8 text-xs"
              aria-label="Selesai melampirkan"
              onClick={() => setOpen(false)}
            >
              Selesai
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
