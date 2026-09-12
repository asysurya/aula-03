"use client";

// Cloud Picker — dialog pilih file untuk dilampirkan ke chat. Dua sumber:
//
//  1. Tab "Cloud Kelas" — file yang sudah ada di cloud kelas (atau milik
//     sendiri untuk DM). Unggah baru tetap bisa — unggahan masuk ke cloud
//     (MEGA/S3) lewat jalur yang sama sehingga filenya bisa dipakai ulang.
//
//  2. Tab "Mount MEGA" — browse ISI akun MEGA (mount, hak akses diatur admin)
//     lalu pilih file di dalamnya. File TIDAK disalin: yang dilampirkan
//     adalah referensi ke node asli di MEGA (storageKey mega:<acct>:<node>).
//     Folder bisa dibuka-buka (breadcrumb); pilihan bertahan saat pindah
//     folder.
//
// Semua file yang dilampirkan bersifat PERMANEN (expiresAt null) — pesan
// dihapus TIDAK menghapus file-nya; file bisa dipakai ulang di pesan lain.

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Check,
  ChevronRight,
  Cloud,
  FileJson2,
  Folder,
  HardDrive,
  Loader2,
  Search,
  UploadCloud,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FileIcon } from "@/components/cloud/file-icon";
import { formatBytes } from "@/lib/file-constants";
import { mimetypeFromName, mimeToIcon } from "@/lib/cloud-format";
import { uploadSmart } from "@/lib/upload-client";
import { cn } from "@/lib/utils";

export interface CloudPickerFile {
  id: string;
  name: string;
  size: number;
  mimetype: string;
  storageKey: string;
  createdAt: string;
  folderName: string | null;
  uploader: { id: string; name: string; username: string };
}

// ── Tipe respons tree MEGA (subset yang dipakai picker) ──
interface MegaEntry {
  nodeId: string;
  name: string;
  isFolder: boolean;
  size: number;
  timestamp: number | null;
}

interface MegaTreeResponse {
  ok: boolean;
  account: {
    id: string;
    email: string | null;
    name: string;
    mountMode?: "READ" | "WRITE";
    mountVisibleTo?: "ADMIN" | "GURU" | "ALL";
    canWrite?: boolean;
  };
  nodeId: string;
  path: { id: string; name: string }[];
  entries: MegaEntry[];
}

type PickerTab = "cloud" | "mega";

export function AttachmentPicker({
  open,
  onOpenChange,
  conversation,
  pendingFileIds,
  maxAttachments,
  onAttach,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  conversation: { kind: "classroom" | "group" | "dm"; id: string };
  pendingFileIds: string[];
  maxAttachments: number;
  onAttach: (files: CloudPickerFile[]) => void;
}) {
  const [tab, setTab] = useState<PickerTab>("cloud");
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<CloudPickerFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // ── State tab Mount MEGA ──
  const [megaNodeId, setMegaNodeId] = useState<string | null>(null);
  const [megaSelected, setMegaSelected] = useState<MegaEntry[]>([]);
  const [registering, setRegistering] = useState(false);
  // Akun mount yang dipilih (null = default dari server — akun pertama
  // yang boleh dibuka user). Bisa diganti bila user punya akses >1 akun.
  const [megaAccountId, setMegaAccountId] = useState<string | null>(null);

  // Debounce pencarian.
  useEffect(() => {
    const t = setTimeout(() => setQ(search.trim().toLowerCase()), 250);
    return () => clearTimeout(t);
  }, [search]);

  // Reset pilihan saat dibuka.
  useEffect(() => {
    if (open) {
      setSelected([]);
      setMegaSelected([]);
      setSearch("");
      setTab("cloud");
      setMegaNodeId(null);
      setMegaAccountId(null);
    }
  }, [open]);

  // ── Query: file cloud kelas (tab cloud) ──
  const cloudQuery = useQuery<{
    files: CloudPickerFile[];
  }>({
    queryKey: ["cloud-picker", conversation.kind, conversation.id, q],
    queryFn: async () => {
      const params = new URLSearchParams({
        kind: conversation.kind,
        id: conversation.id,
      });
      if (q) params.set("q", q);
      const res = await fetch(
        `/api/cloud/files/picker?${params.toString()}`,
        { cache: "no-store" }
      );
      if (!res.ok) throw new Error("Gagal memuat file cloud");
      return res.json();
    },
    enabled: open && tab === "cloud",
  });

  // ── Daftar akun mount yang boleh dibuka (untuk switch akun) ──
  // Izin diperiksa server-side per-akun (per PERAN + PER ORANG).
  const megaAccessQuery = useQuery<{
    visible: boolean;
    accounts?: {
      id: string;
      name: string;
      email: string | null;
      status: string | null;
      canWrite: boolean;
    }[];
  }>({
    queryKey: ["mega-access"],
    queryFn: async () => {
      const res = await fetch("/api/cloud/mega/access", { cache: "no-store" });
      if (!res.ok) return { visible: false };
      return res.json();
    },
    staleTime: 30_000,
    enabled: open && tab === "mega",
  });
  const megaAccounts = megaAccessQuery.data?.accounts ?? [];

  // ── Query: tree mount MEGA (tab mega) ──
  const megaQuery = useQuery<MegaTreeResponse>({
    queryKey: ["mega-attach-tree", megaAccountId ?? "auto", megaNodeId ?? "root"],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (megaAccountId) params.set("accountId", megaAccountId);
      if (megaNodeId) params.set("nodeId", megaNodeId);
      const res = await fetch(
        `/api/cloud/mega/tree?${params.toString()}`,
        { cache: "no-store" }
      );
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || "Gagal memuat MEGA");
      return json as MegaTreeResponse;
    },
    enabled: open && tab === "mega",
  });

  /** Ganti akun mount di picker — reset folder & pilihan. */
  function switchMegaAccount(id: string) {
    if (id === (megaAccountId ?? megaAccounts[0]?.id)) return;
    setMegaAccountId(id);
    setMegaNodeId(null);
    setMegaSelected([]);
  }

  const alreadyPending = new Set(pendingFileIds);
  const totalSelected = selected.length + megaSelected.length;
  const room = maxAttachments - pendingFileIds.length - totalSelected;

  function toggle(f: CloudPickerFile) {
    if (alreadyPending.has(f.id)) return;
    setSelected((prev) => {
      if (prev.some((p) => p.id === f.id)) return prev.filter((p) => p.id !== f.id);
      if (room <= 0) {
        toast.error(`Maks ${maxAttachments} lampiran per pesan`);
        return prev;
      }
      return [...prev, f];
    });
  }

  function toggleMega(e: MegaEntry) {
    setMegaSelected((prev) => {
      if (prev.some((p) => p.nodeId === e.nodeId)) {
        return prev.filter((p) => p.nodeId !== e.nodeId);
      }
      if (room <= 0) {
        toast.error(`Maks ${maxAttachments} lampiran per pesan`);
        return prev;
      }
      return [...prev, e];
    });
  }

  // Filter isi folder MEGA aktif berdasarkan pencarian (sisi klien —
  // tree API tidak punya pencarian server-side).
  const megaEntries = useMemo(() => {
    const entries = megaQuery.data?.entries ?? [];
    if (!q) return entries;
    return entries.filter((e) => e.name.toLowerCase().includes(q));
  }, [megaQuery.data, q]);

  async function uploadNew(files: FileList | null) {
    const f = files?.[0];
    if (!f) return;
    if (fileInputRef.current) fileInputRef.current.value = "";
    if (f.size === 0) {
      toast.error("File kosong");
      return;
    }
    if (room <= 0) {
      toast.error(`Maks ${maxAttachments} lampiran per pesan`);
      return;
    }
    setUploading(true);
    try {
      const res = await uploadSmart<{
        fileId?: string;
        name?: string;
        size?: number;
        mimetype?: string;
        storageKey?: string;
        error?: string;
      }>(f, {
        kind: "attachment",
        convKind: conversation.kind,
        convId: conversation.id,
      });
      const json = res.json;
      if (!res.ok || !json?.fileId) {
        throw new Error(json?.error || "Upload gagal");
      }
      // Setelah terunggah ke cloud (permanen), langsung tersedia sebagai
      // lampiran dan bisa dipakai ulang di pesan lain.
      onAttach([
        {
          id: json.fileId,
          name: json.name ?? f.name,
          size: json.size ?? f.size,
          mimetype: json.mimetype ?? f.type,
          storageKey: json.storageKey ?? "",
          createdAt: new Date().toISOString(),
          folderName: "Lampiran chat",
          uploader: { id: "", name: "Baru diunggah", username: "" },
        },
      ]);
      onOpenChange(false);
      toast.success("File diunggah ke cloud & dilampirkan");
      void cloudQuery.refetch();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Gagal mengunggah");
    } finally {
      setUploading(false);
    }
  }

  // Lampirkan file-file terpilih dari mount MEGA: daftarkan tiap node
  // sebagai baris CloudFile permanen (referensi) → lalu serahkan ke
  // onAttach seperti file cloud biasa.
  async function attachMega() {
    if (megaSelected.length === 0) return;
    setRegistering(true);
    try {
      const accountId = megaQuery.data?.account.id ?? null;
      const registered: CloudPickerFile[] = [];
      for (const entry of megaSelected) {
        const res = await fetch("/api/cloud/mega/attach", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ accountId, nodeId: entry.nodeId }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok || !json?.file) {
          throw new Error(
            json?.error || `Gagal melampirkan "${entry.name}" dari MEGA`
          );
        }
        registered.push(json.file as CloudPickerFile);
      }
      const fresh = registered.filter((f) => !alreadyPending.has(f.id));
      if (fresh.length === 0) {
        toast.info("Semua file terpilih sudah dilampirkan");
        onOpenChange(false);
        return;
      }
      onAttach(fresh);
      onOpenChange(false);
      toast.success(
        fresh.length === 1
          ? "File MEGA dilampirkan"
          : `${fresh.length} file MEGA dilampirkan`
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Gagal melampirkan dari MEGA");
    } finally {
      setRegistering(false);
    }
  }

  const busy = uploading || registering;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Cloud className="size-5 text-primary" /> Lampirkan File
          </DialogTitle>
          <DialogDescription>
            Pilih dari cloud {conversation.kind === "dm" ? "(milikmu)" : "kelas"}
            , dari mount MEGA, atau unggah baru — semua tersimpan permanen di
            cloud dan bisa dipakai ulang.
          </DialogDescription>
        </DialogHeader>

        {/* ── Tab sumber file ── */}
        <div className="grid grid-cols-2 gap-1 rounded-lg bg-muted p-1">
          <button
            type="button"
            onClick={() => setTab("cloud")}
            className={cn(
              "flex items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
              tab === "cloud"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            <Cloud className="size-4" /> Cloud Kelas
          </button>
          <button
            type="button"
            onClick={() => setTab("mega")}
            className={cn(
              "flex items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
              tab === "mega"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            <HardDrive className="size-4" /> Mount MEGA
          </button>
        </div>

        {/* ── Bar pencarian (+ unggah baru di tab cloud) ── */}
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={
                tab === "cloud"
                  ? "Cari nama file…"
                  : "Cari di folder MEGA ini…"
              }
              className="pl-8 h-9"
            />
          </div>
          {tab === "cloud" ? (
            <>
              <Button
                variant="outline"
                size="sm"
                disabled={busy || room <= 0}
                onClick={() => fileInputRef.current?.click()}
                className="gap-1.5 shrink-0"
              >
                {uploading ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <UploadCloud className="size-3.5" />
                )}
                Unggah baru
              </Button>
              <input
                ref={fileInputRef}
                type="file"
                className="hidden"
                onChange={(e) => void uploadNew(e.target.files)}
              />
            </>
          ) : null}
        </div>

        {/* ── Pemilih akun mount (hanya bila >1 akun boleh dibuka) ── */}
        {tab === "mega" && megaAccounts.length > 1 ? (
          <Select
            value={megaAccountId ?? megaAccounts[0]?.id}
            onValueChange={switchMegaAccount}
          >
            <SelectTrigger className="h-9 text-sm">
              <span className="text-muted-foreground text-xs">Akun:</span>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {megaAccounts.map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  {a.name}
                  {a.canWrite ? "" : " (baca-saja)"}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}

        {/* ── Breadcrumb mount MEGA ── */}
        {tab === "mega" && megaQuery.data ? (
          <div className="flex items-center flex-wrap gap-0.5 text-xs">
            {megaQuery.data.path.map((seg, i) => {
              const isLast = i === megaQuery.data!.path.length - 1;
              return (
                <span key={seg.id} className="flex items-center">
                  {i > 0 ? (
                    <ChevronRight className="size-3 text-muted-foreground/60" />
                  ) : null}
                  <button
                    type="button"
                    disabled={isLast}
                    onClick={() => setMegaNodeId(seg.id === "root" ? null : seg.id)}
                    className={cn(
                      "max-w-[160px] truncate rounded px-1.5 py-0.5",
                      isLast
                        ? "font-semibold text-foreground"
                        : "text-muted-foreground hover:bg-accent hover:text-foreground"
                    )}
                  >
                    {seg.name || "MEGA"}
                  </button>
                </span>
              );
            })}
          </div>
        ) : null}

        {/* ── Daftar file ── */}
        <div className="flex-1 min-h-0 overflow-y-auto rounded-lg border border-border divide-y divide-border">
          {tab === "cloud" ? (
            cloudQuery.isLoading ? (
              <div className="p-3 space-y-2">
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
              </div>
            ) : cloudQuery.error || !cloudQuery.data ? (
              <div className="p-4 text-center text-sm text-destructive">
                Gagal memuat file cloud.{" "}
                <Button variant="link" onClick={() => cloudQuery.refetch()}>
                  Coba lagi
                </Button>
              </div>
            ) : cloudQuery.data.files.length === 0 ? (
              <div className="p-6 text-center text-sm text-muted-foreground space-y-1">
                <FileJson2 className="size-6 mx-auto opacity-50" />
                <p>
                  {q
                    ? `Tidak ada file yang cocok dengan "${q}".`
                    : "Belum ada file di cloud ini — unggah yang baru di atas."}
                </p>
              </div>
            ) : (
              cloudQuery.data.files.map((f) => {
                const isSelected = selected.some((p) => p.id === f.id);
                const isPending = alreadyPending.has(f.id);
                return (
                  <button
                    key={f.id}
                    type="button"
                    disabled={isPending}
                    onClick={() => toggle(f)}
                    className={cn(
                      "flex items-center gap-2.5 w-full px-3 py-2.5 text-left transition-colors",
                      isPending
                        ? "opacity-40 cursor-not-allowed"
                        : isSelected
                          ? "bg-primary/10"
                          : "hover:bg-accent/50"
                    )}
                  >
                    <FileIcon
                      name={mimeToIcon(f.mimetype)}
                      className="size-5 shrink-0 text-muted-foreground"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium truncate">{f.name}</p>
                      <p className="text-[10px] text-muted-foreground truncate">
                        {formatBytes(f.size)}
                        {f.folderName ? ` · ${f.folderName}` : ""}
                        {f.uploader?.name ? ` · ${f.uploader.name}` : ""}
                      </p>
                    </div>
                    {isPending ? (
                      <Badge variant="secondary" className="text-[10px] shrink-0">
                        sudah dilampirkan
                      </Badge>
                    ) : isSelected ? (
                      <span className="inline-flex items-center justify-center size-5 rounded-full bg-primary text-primary-foreground shrink-0">
                        <Check className="size-3" />
                      </span>
                    ) : (
                      <span className="inline-flex items-center justify-center size-5 rounded-full border border-border shrink-0" />
                    )}
                  </button>
                );
              })
            )
          ) : (
            // ── Tab Mount MEGA ──
            megaQuery.isLoading ? (
              <div className="p-3 space-y-2">
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
              </div>
            ) : megaQuery.error ? (
              <div className="p-4 text-center text-sm text-destructive space-y-1">
                <p>{(megaQuery.error as Error).message}</p>
                <Button variant="link" onClick={() => megaQuery.refetch()}>
                  Coba lagi
                </Button>
              </div>
            ) : megaEntries.length === 0 ? (
              <div className="p-6 text-center text-sm text-muted-foreground space-y-1">
                <HardDrive className="size-6 mx-auto opacity-50" />
                <p>
                  {q
                    ? `Tidak ada item yang cocok dengan "${q}".`
                    : "Folder ini kosong."}
                </p>
              </div>
            ) : (
              megaEntries.map((e) => {
                const isSel = megaSelected.some((p) => p.nodeId === e.nodeId);
                if (e.isFolder) {
                  return (
                    <button
                      key={e.nodeId}
                      type="button"
                      onClick={() => setMegaNodeId(e.nodeId)}
                      className="flex items-center gap-2.5 w-full px-3 py-2.5 text-left hover:bg-accent/50 transition-colors"
                    >
                      <Folder className="size-5 shrink-0 text-amber-500" />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium truncate">{e.name}</p>
                        <p className="text-[10px] text-muted-foreground">
                          Folder — klik untuk membuka
                        </p>
                      </div>
                      <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                    </button>
                  );
                }
                return (
                  <button
                    key={e.nodeId}
                    type="button"
                    onClick={() => toggleMega(e)}
                    className={cn(
                      "flex items-center gap-2.5 w-full px-3 py-2.5 text-left transition-colors",
                      isSel ? "bg-primary/10" : "hover:bg-accent/50"
                    )}
                  >
                    <FileIcon
                      name={mimeToIcon(mimetypeFromName(e.name))}
                      className="size-5 shrink-0 text-muted-foreground"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium truncate">{e.name}</p>
                      <p className="text-[10px] text-muted-foreground truncate">
                        {formatBytes(e.size)} · Mount MEGA
                      </p>
                    </div>
                    {isSel ? (
                      <span className="inline-flex items-center justify-center size-5 rounded-full bg-primary text-primary-foreground shrink-0">
                        <Check className="size-3" />
                      </span>
                    ) : (
                      <span className="inline-flex items-center justify-center size-5 rounded-full border border-border shrink-0" />
                    )}
                  </button>
                );
              })
            )
          )}
        </div>

        {/* ── Info akun MEGA (tab mega) ── */}
        {tab === "mega" && megaQuery.data ? (
          <p className="text-[10px] text-muted-foreground -mt-1 px-0.5">
            Akun: {megaQuery.data.account.email ?? megaQuery.data.account.name}
            {megaQuery.data.account.mountMode === "READ"
              ? " · mount baca-saja (file tetap bisa dilampirkan)"
              : ""}
            {" · "}
            file dilampirkan sebagai referensi — tidak disalin, file asli
            tetap di MEGA.
          </p>
        ) : null}

        <DialogFooter className="gap-2 sm:justify-between sm:flex-row">
          <span className="text-xs text-muted-foreground">
            {totalSelected} dipilih · maks {maxAttachments} per pesan
            {megaSelected.length > 0 ? " · lintas folder" : ""}
          </span>
          <div className="flex items-center gap-2">
            {totalSelected > 0 ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setSelected([]);
                  setMegaSelected([]);
                }}
                className="gap-1"
              >
                <X className="size-3.5" /> Bersihkan
              </Button>
            ) : null}
            <Button
              disabled={totalSelected === 0 || busy}
              onClick={() => {
                if (tab === "mega" && megaSelected.length > 0) {
                  void attachMega();
                  return;
                }
                onAttach(selected);
                onOpenChange(false);
              }}
              className="gap-1.5"
            >
              {busy ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Check className="size-4" />
              )}
              Lampirkan ({totalSelected})
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
