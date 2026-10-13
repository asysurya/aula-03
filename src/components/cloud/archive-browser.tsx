"use client";

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  AlertTriangle,
  ArchiveRestore,
  ChevronRight,
  Download,
  Eye,
  FileArchive,
  Folder,
  FolderUp,
  Loader2,
  Search,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { FilePreview } from "@/components/cloud/file-preview";
import { useTransferStore } from "@/lib/transfer-store";
import { formatBytes, type CloudFileItem } from "@/lib/cloud-format";
import {
  archiveFormatLabel,
  extOf,
  isSupportedArchiveName,
  stripArchiveExt,
} from "@/lib/archive-names";

// ─────────────────────────────────────────────────────────────────────────
// ArchiveBrowserDialog — penjelajah isi ARSIP di mount MEGA Cloud.
//
// Membuka zip/epub/tar/tar.gz/gz TANPA mengekstraknya:
//   · listing = metadata saja (server membaca central directory — cepat);
//   · menavigasi folder di dalam arsip (virtual);
//   · men-KLIK berkas di dalamnya → dipratinjau/dibuka langsung (server
//     men-dekompresi HANYA berkas itu dari arsip);
//   · tombol "Ekstrak di Sini…" → seluruh arsip dijadikan folder + berkas
//     asli di mount (butuh hak tulis).
// ─────────────────────────────────────────────────────────────────────────

export interface ArchiveTarget {
  nodeId: string;
  name: string;
  size: number;
}

interface ArchiveEntry {
  path: string;
  size: number;
  isFile: boolean;
  compressedSize?: number;
}

interface ArchiveResponse {
  ok: boolean;
  name: string;
  size: number;
  format: string;
  entryCount: number;
  truncated: boolean;
  totalBytes: number;
  canWrite?: boolean;
  entries: ArchiveEntry[];
}

interface InnerPreview {
  path: string;
  name: string;
  size: number;
  url: string;
}

export function ArchiveBrowserDialog({
  open,
  onOpenChange,
  accountId,
  archive,
  canWrite,
  /** Label folder mount tempat arsip berada (untuk konfirmasi ekstraksi). */
  targetLabel,
  targetParentId,
  onExtracted,
  /** Buka dialog ekstraksi begitu browser terbuka (dari menu konteks). */
  autoExtract = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accountId: string | null;
  archive: ArchiveTarget | null;
  canWrite: boolean;
  targetLabel?: string;
  targetParentId?: string | null;
  onExtracted?: () => void;
  autoExtract?: boolean;
}) {
  const [dir, setDir] = useState("");
  const [query, setQuery] = useState("");
  const [inner, setInner] = useState<InnerPreview | null>(null);
  const [extractOpen, setExtractOpen] = useState(false);
  const [folderName, setFolderName] = useState("");
  const [extractDone, setExtractDone] = useState<string | null>(null);
  const enqueueDownload = useTransferStore((s) => s.enqueueDownload);

  const supported = archive ? isSupportedArchiveName(archive.name) : false;

  // Reset state saat ganti arsip / buka ulang.
  useEffect(() => {
    if (open && archive) {
      setDir("");
      setQuery("");
      setInner(null);
      setExtractDone(null);
      setFolderName(stripArchiveExt(archive.name.split(/[\\/]/).pop() ?? "") || "ekstrak");
      if (autoExtract && canWrite && supported) {
        // Tunda sebentar supaya dialog utama sempat ter-render.
        const t = setTimeout(() => setExtractOpen(true), 150);
        return () => clearTimeout(t);
      }
    }
  }, [open, archive?.nodeId, autoExtract]); // eslint-disable-line react-hooks/exhaustive-deps

  const { data, isLoading, error, refetch } = useQuery<ArchiveResponse>({
    queryKey: ["mega-archive", accountId ?? "auto", archive?.nodeId ?? "-", open],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (accountId) params.set("accountId", accountId);
      params.set("nodeId", archive!.nodeId);
      const res = await fetch(
        `/api/cloud/mega/archive?${params.toString()}`,
        { cache: "no-store" }
      );
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || "Gagal membuka arsip");
      return json as ArchiveResponse;
    },
    enabled: open && !!archive && supported,
  });

  const entryUrl = (path: string, download: boolean) => {
    const params = new URLSearchParams();
    if (accountId) params.set("accountId", accountId);
    params.set("nodeId", archive!.nodeId);
    params.set("entry", path);
    if (download) params.set("download", "1");
    return `/api/cloud/mega/archive?${params.toString()}`;
  };

  // ── Pohon virtual dari daftar path ──
  const children = useMemo(() => {
    const entries = data?.entries ?? [];
    const prefix = dir ? `${dir}/` : "";
    const folders = new Map<string, number>();
    const files: ArchiveEntry[] = [];
    for (const e of entries) {
      if (!e.path.startsWith(prefix)) continue;
      const rest = e.path.slice(prefix.length);
      if (!rest) continue;
      const slash = rest.indexOf("/");
      if (slash === -1) {
        if (e.isFile) files.push(e);
      } else {
        const name = rest.slice(0, slash);
        folders.set(name, (folders.get(name) ?? 0) + 1);
      }
    }
    const folderRows = Array.from(folders.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const fileRows = files.sort((a, b) => a.path.localeCompare(b.path));
    return { folderRows, fileRows };
  }, [data, dir]);

  const filteredFiles = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return children.fileRows;
    return children.fileRows.filter((f) =>
      f.path.toLowerCase().includes(q)
    );
  }, [children.fileRows, query]);

  const fileCount = useMemo(
    () => (data?.entries ?? []).filter((e) => e.isFile).length,
    [data]
  );

  function openInner(e: ArchiveEntry) {
    setInner({
      path: e.path,
      name: e.path.split("/").pop() || "berkas",
      size: e.size,
      url: entryUrl(e.path, false),
    });
  }

  function downloadInner(e: ArchiveEntry) {
    enqueueDownload({
      url: entryUrl(e.path, true),
      name: e.path.split("/").pop() || "berkas",
      size: e.size,
      context: "Arsip MEGA",
      autoSave: true,
    });
    toast.info(
      `"${e.path.split("/").pop()}" diunduh dari dalam arsip — pantau di tombol Transfer.`
    );
  }

  // ── Ekstraksi ──
  const extractMut = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/cloud/mega/archive", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId,
          nodeId: archive!.nodeId,
          targetParentId: targetParentId ?? null,
          folderName: folderName.trim() || undefined,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Ekstraksi gagal");
      return json as {
        ok: boolean;
        folderName: string;
        fileCount: number;
        folderCount: number;
        failed: number;
        skippedUnsafe?: number;
        skippedOversize?: number;
      };
    },
    onSuccess: (r) => {
      setExtractOpen(false);
      setExtractDone(
        `${r.fileCount} berkas + ${r.folderCount} folder diekstrak ke "${r.folderName}"${
          r.failed > 0 ? ` (${r.failed} gagal)` : ""
        }.`
      );
      toast.success(
        `Arsip diekstrak — ${r.fileCount} berkas ke folder "${r.folderName}".`
      );
      onExtracted?.();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // ── Berkas dalam arsip → objek preview FilePreview ──
  function innerPreviewFile(): CloudFileItem | null {
    if (!inner || !archive || !accountId) return null;
    return {
      id: `archive-entry-${archive.nodeId}-${inner.path}`,
      name: inner.name,
      size: inner.size,
      mimetype: "",
      storageKey: `mega:${accountId}:${archive.nodeId}!${inner.path}`,
      cloudAccountId: accountId,
      createdAt: new Date().toISOString(),
      uploadedBy: "",
      uploader: { id: "", name: archive.name, username: "mega" },
      visibility: "ALL",
      raw: false,
      previewUrl: inner.url,
    };
  }

  const previewFile = inner ? innerPreviewFile() : null;

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-2xl max-h-[85vh] flex flex-col" data-archive-dialog="1">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 pr-6">
              <FileArchive className="size-5 text-amber-500 shrink-0" />
              <span className="truncate">{archive?.name ?? "Arsip"}</span>
              {archive ? (
                <Badge variant="secondary" className="text-[10px] shrink-0">
                  {archiveFormatLabel(archive.name)}
                </Badge>
              ) : null}
            </DialogTitle>
            <DialogDescription>
              {supported
                ? "Buka berkas di dalamnya tanpa ekstrak — klik untuk pratinjau."
                : "Format arsip ini tidak bisa dibuka langsung di aplikasi."}
            </DialogDescription>
          </DialogHeader>

          {/* Info + pencarian */}
          <div className="flex items-center gap-2 flex-wrap">
            {data ? (
              <p className="text-[11px] text-muted-foreground" data-archive-info="1">
                {fileCount} berkas · {data.entryCount - fileCount} folder · isi{" "}
                {formatBytes(data.totalBytes)}
                {data.truncated ? " · daftar dipotong 1000 entri" : ""}
              </p>
            ) : (
              <span className="text-[11px] text-muted-foreground">
                {archive ? formatBytes(archive.size) : ""}
              </span>
            )}
            <div className="relative ml-auto">
              <Search className="size-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Cari dalam arsip…"
                aria-label="Cari dalam arsip"
                className="h-8 pl-7 pr-2 rounded-md border border-input bg-card text-xs w-44 sm:w-56"
              />
            </div>
          </div>

          {/* Breadcrumb dalam arsip */}
          {supported && (data || isLoading) ? (
            <div className="flex items-center gap-1 text-xs flex-wrap min-h-7">
              <button
                className="flex items-center gap-1 hover:text-primary"
                onClick={() => setDir("")}
                data-archive-root="1"
              >
                <FileArchive className="size-3.5" />
                <span className="max-w-[160px] truncate">
                  {archive?.name ?? "arsip"}
                </span>
              </button>
              {dir
                ? dir.split("/").map((seg, i, arr) => (
                    <span key={i} className="flex items-center gap-1">
                      <ChevronRight className="size-3 text-muted-foreground" />
                      {i === arr.length - 1 ? (
                        <span className="font-medium max-w-[140px] truncate">
                          {seg}
                        </span>
                      ) : (
                        <button
                          className="hover:text-primary"
                          onClick={() =>
                            setDir(arr.slice(0, i + 1).join("/"))
                          }
                        >
                          {seg}
                        </button>
                      )}
                    </span>
                  ))
                : null}
              {dir ? (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 px-2 ml-auto gap-1 text-[11px]"
                  onClick={() => setDir(dir.includes("/") ? dir.slice(0, dir.lastIndexOf("/")) : "")}
                  title="Naik satu folder"
                >
                  <FolderUp className="size-3.5" /> Naik
                </Button>
              ) : null}
            </div>
          ) : null}

          {/* Isi */}
          <div className="flex-1 min-h-[240px] border rounded-md overflow-hidden">
            <ScrollArea className="h-[46vh]">
              <div className="p-2">
                {!supported ? (
                  <div className="flex flex-col items-center justify-center gap-3 p-8 text-center min-h-[240px]">
                    <AlertTriangle className="size-10 text-muted-foreground/60" />
                    <p className="text-sm">
                      Arsip <b>.{archive ? extOf(archive.name) : "?"}</b> tidak
                      bisa dibuka langsung — didukung: ZIP, EPUB, TAR, TAR.GZ,
                      GZ.
                    </p>
                    <p className="text-xs text-muted-foreground max-w-sm">
                      Unduh arsipnya lalu ekstrak di perangkat Anda.
                    </p>
                  </div>
                ) : isLoading ? (
                  <div className="space-y-2 p-1">
                    {Array.from({ length: 6 }).map((_, i) => (
                      <Skeleton key={i} className="h-10 rounded-md" />
                    ))}
                  </div>
                ) : error ? (
                  <div className="flex flex-col items-center justify-center gap-3 p-8 text-center min-h-[240px]">
                    <AlertTriangle className="size-10 text-destructive/60" />
                    <p className="text-sm text-destructive max-w-md">
                      {error instanceof Error
                        ? error.message
                        : "Gagal membuka arsip"}
                    </p>
                    <Button size="sm" variant="outline" onClick={() => refetch()}>
                      <Loader2 className="size-4" /> Coba lagi
                    </Button>
                  </div>
                ) : children.folderRows.length === 0 &&
                  filteredFiles.length === 0 ? (
                  <p className="text-xs text-muted-foreground p-8 text-center">
                    {query
                      ? "Tidak ada berkas yang cocok dengan pencarian."
                      : "Folder ini kosong."}
                  </p>
                ) : (
                  <>
                    {children.folderRows.map((f) => (
                      <button
                        key={f.name}
                        className="w-full flex items-center gap-2 px-2 py-2 rounded-md hover:bg-accent/60 text-sm text-left"
                        onClick={() => setDir(dir ? `${dir}/${f.name}` : f.name)}
                        data-archive-folder={f.name}
                      >
                        <Folder className="size-4 text-sky-500 shrink-0" />
                        <span className="flex-1 min-w-0 truncate">{f.name}</span>
                        <span className="text-[11px] text-muted-foreground shrink-0">
                          {f.count} item
                        </span>
                      </button>
                    ))}
                    {filteredFiles.map((f) => (
                      <div
                        key={f.path}
                        className="flex items-center gap-2 px-2 py-2 rounded-md hover:bg-accent/60 text-sm group"
                        data-archive-file={f.path}
                      >
                        <FileArchive className="size-4 text-muted-foreground shrink-0" />
                        <span
                          className="flex-1 min-w-0 truncate cursor-pointer"
                          title={f.path}
                          onClick={() => openInner(f)}
                        >
                          {f.path.split("/").pop()}
                        </span>
                        <span className="text-[11px] text-muted-foreground tabular-nums shrink-0">
                          {formatBytes(f.size)}
                        </span>
                        <span className="flex items-center gap-1 shrink-0 opacity-60 group-hover:opacity-100">
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 px-2 gap-1 text-[11px]"
                            onClick={() => openInner(f)}
                            title="Buka berkas ini (tanpa ekstrak)"
                            data-archive-open="1"
                          >
                            <Eye className="size-3.5" /> Buka
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 px-2 gap-1 text-[11px]"
                            onClick={() => downloadInner(f)}
                            title="Unduh berkas ini saja"
                          >
                            <Download className="size-3.5" />
                          </Button>
                        </span>
                      </div>
                    ))}
                  </>
                )}
              </div>
            </ScrollArea>
          </div>

          {/* Banner hasil ekstraksi */}
          {extractDone ? (
            <p
              className="text-xs text-emerald-600 dark:text-emerald-400 flex items-center gap-1.5"
              data-archive-extracted="1"
            >
              <ArchiveRestore className="size-3.5 shrink-0" />
              <span className="truncate">{extractDone}</span>
            </p>
          ) : null}

          <DialogFooter className="flex items-center gap-2 sm:justify-between">
            <p className="text-[10px] text-muted-foreground hidden sm:block">
              Membuka berkas tidak mengekstrak arsip — isi mount tidak berubah.
            </p>
            <div className="flex items-center gap-2">
              {canWrite && supported && data && data.entryCount > 0 &&
              data.canWrite !== false ? (
                <Button
                  size="sm"
                  className="gap-1.5"
                  onClick={() => setExtractOpen(true)}
                  disabled={extractMut.isPending}
                  data-archive-extract-btn="1"
                >
                  {extractMut.isPending ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <ArchiveRestore className="size-4" />
                  )}
                  Ekstrak di Sini…
                </Button>
              ) : null}
              <Button
                size="sm"
                variant="outline"
                onClick={() => onOpenChange(false)}
              >
                Tutup
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Konfirmasi ekstraksi */}
      <AlertDialog open={extractOpen} onOpenChange={setExtractOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <ArchiveRestore className="size-5 text-primary" />
              Ekstrak arsip ke mount MEGA?
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3">
                <p>
                  <b>{archive?.name}</b> ({fileCount} berkas ·{" "}
                  {data ? formatBytes(data.totalBytes) : "—"}) akan diekstrak
                  menjadi folder baru di{" "}
                  <b>{targetLabel ?? "root MEGA"}</b>. Arsip aslinya tetap ada.
                </p>
                <div className="space-y-1.5">
                  <p className="text-xs font-medium">Nama folder hasil:</p>
                  <Input
                    value={folderName}
                    onChange={(e) => setFolderName(e.target.value)}
                    aria-label="Nama folder hasil ekstraksi"
                    maxLength={120}
                    data-archive-folder-name="1"
                  />
                </div>
                <p className="text-[11px] text-muted-foreground">
                  Batas: 1000 entri · 4 GB total isi · 1 GB per berkas.
                  Berkas terlalu besar otomatis dilewati.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Batal</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                extractMut.mutate();
              }}
              disabled={extractMut.isPending || !folderName.trim()}
            >
              {extractMut.isPending ? (
                <Loader2 className="size-4 animate-spin mr-2" />
              ) : null}
              Ekstrak
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Pratinjau berkas DI DALAM arsip (tanpa ekstrak) */}
      {previewFile ? (
        <FilePreview file={previewFile} onClose={() => setInner(null)} />
      ) : null}
    </>
  );
}
