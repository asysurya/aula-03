"use client";

import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { id as localeId } from "date-fns/locale";
import { toast } from "sonner";
import {
  AlertTriangle,
  CheckSquare,
  ChevronRight,
  ClipboardPaste,
  Copy,
  Download,
  Eye,
  FilePlus2,
  Folder,
  FolderPlus,
  HardDrive,
  Loader2,
  MoreVertical,
  Pencil,
  RefreshCw,
  Scissors,
  SquareDashed,
  Trash2,
  UploadCloud,
  X,
  FolderInput,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
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
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";

import { FilePreview } from "@/components/cloud/file-preview";
import { MegaLogo } from "@/components/cloud/mega-logo";
import { TransferManagerButton } from "@/components/cloud/transfer-modal";
import { useTransferStore } from "@/lib/transfer-store";
import {
  formatBytes,
  mimetypeFromName,
  type CloudFileItem,
} from "@/lib/cloud-format";

// ───────────────────────── Types ─────────────────────────

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
    status: string | null;
    fileCount: number;
    spaceUsed: number | null;
    spaceTotal: number | null;
    spaceUsedLabel: string | null;
    spaceTotalLabel: string | null;
    /** Hak akses mount utk user ini: "READ" = baca-saja. */
    mountMode?: "READ" | "WRITE";
    mountVisibleTo?: "ADMIN" | "GURU" | "ALL";
    canWrite?: boolean;
  };
  nodeId: string;
  path: { id: string; name: string }[];
  entries: MegaEntry[];
  hint?: string;
}

interface MegaClipboard {
  mode: "copy" | "cut";
  entries: MegaEntry[];
}

// ───────────────────────── Component ─────────────────────────

/**
 * Tampilan "mount MEGA Cloud" — file explorer PENUH seperti drive pada
 * umumnya: 1 klik = pilih, 2 klik = buka; multi-select (Ctrl / Shift /
 * checkbox / Ctrl+A); copy/potong/tempel, rename, pindah, hapus permanen,
 * unggah (chunked utk file besar), unduh, pratinjau all-format + layar
 * penuh, context menu klik-kanan, shortcut keyboard, dan drag-and-drop.
 * Hak akses (siapa boleh membuka + baca-saja) diatur admin per-akun.
 */
export function MegaMountView({
  onExit,
}: {
  onExit: () => void;
}) {
  const [nodeId, setNodeId] = useState<string | null>(null);
  const [previewFile, setPreviewFile] = useState<CloudFileItem | null>(null);

  // ── Explorer state ──
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [anchorId, setAnchorId] = useState<string | null>(null); // awal seleksi Shift
  const [clipboard, setClipboard] = useState<MegaClipboard | null>(null);
  const [renameTarget, setRenameTarget] = useState<MegaEntry | null>(null);
  const [moveTarget, setMoveTarget] = useState<MegaEntry | null>(null);
  const [deleteTargets, setDeleteTargets] = useState<MegaEntry[] | null>(null);
  const [mkdirOpen, setMkdirOpen] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const uploadInputRef = useRef<HTMLInputElement>(null);

  const { data, isLoading, error, refetch, isFetching } =
    useQuery<MegaTreeResponse>({
      queryKey: ["mega-tree", nodeId ?? "root"],
      queryFn: async () => {
        const params = new URLSearchParams();
        if (nodeId) params.set("nodeId", nodeId);
        const res = await fetch(
          `/api/cloud/mega/tree?${params.toString()}`,
          { cache: "no-store" }
        );
        const json = await res.json();
        if (!res.ok) {
          const err = new Error(json?.error || "Gagal memuat MEGA");
          (err as Error & { hint?: string }).hint = json?.hint;
          throw err;
        }
        return json as MegaTreeResponse;
      },
    });

  const accountId = data?.account.id;
  const entries = data?.entries ?? [];
  // Hak akses efektif untuk user ini (dari pengaturan admin per-akun).
  const canWrite = data?.account.canWrite ?? true;
  const isReadOnly = !canWrite;

  const opsMut = useMutation({
    mutationFn: async (payload: Record<string, unknown>) => {
      const res = await fetch("/api/cloud/mega/ops", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload, accountId }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Operasi gagal");
      return json;
    },
    onSuccess: () => {
      refetch();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // ── Upload — berjalan di latar belakang lewat Manajer Transfer ──
  // (pause/resume/cancel/antrean + progress tiap 2 detik; file besar
  // otomatis chunked). Daftar mount di-refresh saat tiap upload selesai.
  const enqueueUpload = useTransferStore((s) => s.enqueueUpload);
  const enqueueDownload = useTransferStore((s) => s.enqueueDownload);
  const allJobs = useTransferStore((s) => s.jobs);
  // Filter di luar selector supaya referensi stabil (anti re-render loop).
  const mountUploads = useMemo(
    () => allJobs.filter((j) => j.kind === "upload" && j.context === "Mount MEGA"),
    [allJobs]
  );

  const onPickUpload = (f: File | null | undefined) => {
    if (!f) return;
    if (f.size > 100 * 1024 * 1024) {
      toast.error("File maksimal 100 MB");
      return;
    }
    enqueueUpload({
      file: f,
      target: { kind: "mega", parentId: nodeId, accountId },
      context: "Mount MEGA",
      onFileOps: () => refetch(),
    });
    toast.info(
      `"${f.name}" diunggah ke MEGA di latar belakang — pantau di tombol Transfer.`
    );
  };

  const usagePct =
    data?.account.spaceTotal && data.account.spaceUsed != null
      ? Math.min(100, (data.account.spaceUsed / data.account.spaceTotal) * 100)
      : null;

  const foldersInCurrentDir = entries.filter((e) => e.isFolder);

  const downloadUrl = (entry: MegaEntry) =>
    `/api/storage/mega:${accountId}:${entry.nodeId}?name=${encodeURIComponent(entry.name)}&download=1`;

  // Unduh berjalan di latar belakang via Manajer Transfer (pause/resume/
  // cancel + progress tiap 2 detik), bukan <a download> yang memblokir.
  const downloadBackground = (entry: MegaEntry) => {
    enqueueDownload({
      url: downloadUrl(entry),
      name: entry.name,
      size: entry.isFolder ? 0 : entry.size,
      context: "Mount MEGA",
      autoSave: true,
    });
  };

  // ── Selection helpers (perilaku drive standar) ──
  // 1 klik = pilih (ganti seleksi) · Ctrl/Cmd+klik = toggle ·
  // Shift+klik = rentang dari item jangkar. Checkbox = toggle.
  function selectEntry(
    nodeId: string,
    mode: "single" | "toggle" | "range"
  ) {
    if (mode === "range" && anchorId) {
      const ids = entries.map((e) => e.nodeId);
      const from = ids.indexOf(anchorId);
      const to = ids.indexOf(nodeId);
      if (from !== -1 && to !== -1) {
        const [start, end] = from <= to ? [from, to] : [to, from];
        const rangeIds = new Set(ids.slice(start, end + 1));
        setSelected(rangeIds);
        return;
      }
    }
    if (mode === "toggle") {
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(nodeId)) next.delete(nodeId);
        else next.add(nodeId);
        return next;
      });
    } else {
      setSelected(new Set([nodeId]));
    }
    setAnchorId(nodeId);
  }
  function toggleSelect(nodeId: string, additive: boolean) {
    selectEntry(nodeId, additive ? "toggle" : "single");
  }
  function clearSelection() {
    setSelected(new Set());
    setAnchorId(null);
  }
  const selectedEntries = entries.filter((e) => selected.has(e.nodeId));
  const totalSelected = selectedEntries.length;

  function openEntry(entry: MegaEntry) {
    if (entry.isFolder) {
      setNodeId(entry.nodeId);
      clearSelection();
    } else {
      setPreviewFile(entryToFileItem(entry));
    }
  }

  function entryToFileItem(entry: MegaEntry): CloudFileItem {
    return {
      id: `mega-node-${entry.nodeId}`,
      name: entry.name,
      size: entry.size,
      mimetype: mimetypeFromName(entry.name),
      storageKey: `mega:${data?.account.id}:${entry.nodeId}`,
      cloudAccountId: data?.account.id ?? null,
      createdAt: entry.timestamp
        ? new Date(entry.timestamp).toISOString()
        : new Date().toISOString(),
      uploadedBy: "",
      uploader: {
        id: "",
        name: data?.account.name ?? "MEGA",
        username: data?.account.email ?? "mega",
      },
      visibility: "ALL",
      raw: true,
    };
  }

  // ── Copy / Cut / Paste ──
  function onCopySelection() {
    if (totalSelected === 0 || isReadOnly) return;
    setClipboard({ mode: "copy", entries: selectedEntries });
    toast.success(
      `${totalSelected} item disalin. Buka folder tujuan lalu Tempel.`
    );
  }
  function onCutSelection() {
    if (totalSelected === 0 || isReadOnly) return;
    setClipboard({ mode: "cut", entries: selectedEntries });
    toast.success(
      `${totalSelected} item dipotong. Buka folder tujuan lalu Tempel.`
    );
  }
  async function pasteInto(targetParentId: string | null) {
    if (!clipboard || clipboard.entries.length === 0 || isReadOnly) return;
    let okCount = 0;
    let failCount = 0;
    for (const entry of clipboard.entries) {
      try {
        if (clipboard.mode === "copy") {
          await opsMut.mutateAsync({
            action: "copy",
            nodeId: entry.nodeId,
            targetParentId,
          });
        } else {
          // cut → move; jangan pindahkan folder ke dalam dirinya sendiri
          if (entry.isFolder && entry.nodeId === targetParentId) {
            failCount++;
            continue;
          }
          await opsMut.mutateAsync({
            action: "move",
            nodeId: entry.nodeId,
            targetParentId,
          });
        }
        okCount++;
      } catch {
        failCount++;
      }
    }
    if (okCount > 0)
      toast.success(
        clipboard.mode === "cut"
          ? `Berhasil memindahkan ${okCount} item.`
          : `Berhasil menyalin ${okCount} item.`
      );
    if (failCount > 0)
      toast.error(`${failCount} item gagal ditempel.`);
    if (clipboard.mode === "cut") setClipboard(null);
    clearSelection();
  }
  async function onPaste() {
    await pasteInto(nodeId);
  }

  // ── Delete multi ──
  function askDeleteSelection() {
    if (totalSelected === 0 || isReadOnly) return;
    setDeleteTargets(selectedEntries);
  }
  async function doDelete(targets: MegaEntry[]) {
    let okCount = 0;
    let failCount = 0;
    for (const t of targets) {
      try {
        await opsMut.mutateAsync({ action: "delete", nodeId: t.nodeId });
        okCount++;
      } catch {
        failCount++;
      }
    }
    toast[failCount > 0 ? "error" : "success"](
      failCount > 0
        ? `${okCount} terhapus, ${failCount} gagal.`
        : `${okCount} item dihapus permanen.`
    );
    clearSelection();
  }

  // ── Keyboard shortcuts (drive standar) ──
  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    const target = e.target as HTMLElement | null;
    if (
      target &&
      (target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable)
    ) {
      return;
    }
    if (e.key === "Escape") {
      if (totalSelected > 0) {
        e.preventDefault();
        clearSelection();
      }
      return;
    }
    if (e.key === "F2" && totalSelected === 1 && !isReadOnly) {
      e.preventDefault();
      setRenameTarget(selectedEntries[0]);
      return;
    }
    if (
      (e.key === "Delete" || e.key === "Backspace") &&
      totalSelected > 0 &&
      !isReadOnly
    ) {
      e.preventDefault();
      askDeleteSelection();
      return;
    }
    if (e.key === "Enter" && totalSelected === 1) {
      e.preventDefault();
      openEntry(selectedEntries[0]);
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
      e.preventDefault();
      setSelected(new Set(entries.map((en) => en.nodeId)));
      return;
    }
    if (isReadOnly) return; // sisanya = operasi tulis
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c" && totalSelected > 0) {
      e.preventDefault();
      onCopySelection();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "x" && totalSelected > 0) {
      e.preventDefault();
      onCutSelection();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "v" && clipboard) {
      e.preventDefault();
      void onPaste();
      return;
    }
  }

  const opsPending = opsMut.isPending;

  return (
    <div
      className="flex flex-col h-full outline-none"
      tabIndex={0}
      onKeyDown={onKeyDown}
      onMouseDown={(e) => {
        const target = e.target as HTMLElement;
        // Klik area kosong (bukan baris/menu) → kosongkan seleksi.
        if (target.dataset.clearsel === "1") clearSelection();
      }}
    >
      {/* Header MEGA */}
      <div className="border-b border-border px-4 py-3 flex items-center gap-3 flex-wrap">
        <div className="rounded-md bg-red-500/10 p-1.5">
          <MegaLogo className="size-5" />
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="font-semibold leading-tight truncate">
              MEGA Cloud
            </h2>
            {isReadOnly ? (
              <Badge
                className="bg-amber-500/15 text-amber-600 dark:text-amber-400 border-0 text-[10px]"
                title="Hak akses diatur admin — kamu hanya bisa melihat, pratinjau, dan mengunduh"
              >
                Baca-saja
              </Badge>
            ) : null}
            {data?.account.status === "connected" ? (
              <Badge className="bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-0 text-[10px]">
                Terhubung
              </Badge>
            ) : null}
          </div>
          <p className="text-xs text-muted-foreground truncate">
            {data?.account.name ?? "MEGA"}
            {data?.account.email ? ` · ${data.account.email}` : ""}
          </p>
        </div>

        {/* Kuota */}
        {data?.account.spaceTotalLabel ? (
          <div className="ml-auto hidden sm:flex items-center gap-2 min-w-[180px] max-w-[260px]">
            <HardDrive className="size-4 text-muted-foreground shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="flex justify-between text-[10px] text-muted-foreground mb-0.5">
                <span>{data.account.spaceUsedLabel ?? "—"}</span>
                <span>/ {data.account.spaceTotalLabel}</span>
              </div>
              <div className="h-1.5 rounded-full bg-secondary overflow-hidden">
                <div
                  className="h-full rounded-full bg-red-500"
                  style={{ width: `${usagePct ?? 0}%` }}
                />
              </div>
            </div>
          </div>
        ) : null}

        <div className="ml-auto sm:ml-0 flex items-center gap-1">
          <TransferManagerButton />
          <Button
            size="sm"
            variant="ghost"
            onClick={() => refetch()}
            title="Muat ulang"
          >
            <RefreshCw
              className={`size-4 ${isFetching ? "animate-spin" : ""}`}
            />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={onExit}
            title="Tutup mount MEGA"
          >
            <X className="size-4" />
          </Button>
        </div>
      </div>

      {/* Toolbar explorer */}
      <div className="border-b border-border px-4 py-2 flex items-center gap-1.5 flex-wrap">
        {isReadOnly ? (
          <p className="text-[11px] text-muted-foreground flex items-center gap-1.5">
            <Eye className="size-3" />
            Mode baca-saja — pratinjau &amp; unduh tersedia, perubahan dinonaktifkan.
          </p>
        ) : (
          <>
          <Button
            size="sm"
            className="gap-1.5"
            onClick={() => uploadInputRef.current?.click()}
            disabled={!data}
          >
            <FilePlus2 className="size-4" />
            Unggah
          </Button>
          <input
            ref={uploadInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              Array.from(e.target.files ?? []).forEach(onPickUpload);
              e.target.value = "";
            }}
          />
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5"
            onClick={() => setMkdirOpen(true)}
            disabled={!data}
          >
            <FolderPlus className="size-4" />
            <span className="hidden sm:inline">Folder Baru</span>
          </Button>
          <span className="w-px h-5 bg-border mx-1" aria-hidden />
          <Button
            size="sm"
            variant="ghost"
            className="gap-1.5"
            onClick={onCopySelection}
            disabled={totalSelected === 0 || opsPending}
            title="Salin (Ctrl+C)"
          >
            <Copy className="size-4" />
            <span className="hidden sm:inline">Salin</span>
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="gap-1.5"
            onClick={onCutSelection}
            disabled={totalSelected === 0 || opsPending}
            title="Potong (Ctrl+X)"
          >
            <Scissors className="size-4" />
            <span className="hidden sm:inline">Potong</span>
          </Button>
          <Button
            size="sm"
            variant={clipboard ? "secondary" : "ghost"}
            className="gap-1.5"
            onClick={onPaste}
            disabled={!clipboard || opsPending}
            title="Tempel ke folder ini (Ctrl+V)"
          >
            <ClipboardPaste className="size-4" />
            Tempel
            {clipboard ? (
              <Badge variant="secondary" className="ml-1 text-[10px]">
                {clipboard.entries.length}
              </Badge>
            ) : null}
          </Button>
          <span className="w-px h-5 bg-border mx-1" aria-hidden />
          <Button
            size="sm"
            variant="ghost"
            className="gap-1.5 text-destructive hover:text-destructive"
            onClick={askDeleteSelection}
            disabled={totalSelected === 0 || opsPending}
            title="Hapus permanen (Del)"
          >
            <Trash2 className="size-4" />
            <span className="hidden sm:inline">Hapus</span>
          </Button>
          </>
        )}

        {mountUploads.length > 0 ? (
          <div className="ml-2 flex items-center gap-2 min-w-[160px] max-w-[260px] flex-1">
            <Progress
              value={
                mountUploads[0].size > 0
                  ? Math.min(
                      100,
                      Math.round(
                        (mountUploads[0].loaded / mountUploads[0].size) * 100
                      )
                    )
                  : 0
              }
              className="h-1.5"
            />
            <span className="text-[10px] text-muted-foreground whitespace-nowrap">
              {mountUploads.length > 1
                ? `${mountUploads.length} berjalan`
                : `${formatBytes(mountUploads[0].loaded)}`}
            </span>
          </div>
        ) : (
          <p className="text-[11px] text-muted-foreground flex items-center gap-1.5 ml-auto">
            {totalSelected > 0 ? (
              <>
                <CheckSquare className="size-3 text-primary" />
                {totalSelected} dipilih
              </>
            ) : isReadOnly ? (
              <>
                <Eye className="size-3" />
                1 klik memilih · 2 klik membuka
              </>
            ) : (
              <>
                <AlertTriangle className="size-3 text-amber-500" />
                Akses penuh — hapus permanen
              </>
            )}
          </p>
        )}
      </div>

      {/* Breadcrumb */}
      <div className="border-b border-border px-4 py-2">
        <Breadcrumb>
          <BreadcrumbList>
            {(data?.path ?? [{ id: "root", name: "MEGA" }]).map((p, i, arr) => {
              const isLast = i === arr.length - 1;
              return (
                <span key={p.id} className="contents">
                  {i > 0 ? <BreadcrumbSeparator /> : null}
                  <BreadcrumbItem>
                    {isLast ? (
                      <BreadcrumbPage className="flex items-center gap-1.5">
                        {i === 0 ? (
                          <MegaLogo className="size-3.5" />
                        ) : null}
                        {p.name}
                      </BreadcrumbPage>
                    ) : (
                      <BreadcrumbLink
                        className="cursor-pointer flex items-center gap-1.5"
                        onClick={() => {
                          setNodeId(p.id === "root" ? null : p.id);
                          clearSelection();
                        }}
                      >
                        {i === 0 ? (
                          <MegaLogo className="size-3.5" />
                        ) : null}
                        {p.name}
                      </BreadcrumbLink>
                    )}
                  </BreadcrumbItem>
                </span>
              );
            })}
          </BreadcrumbList>
        </Breadcrumb>
      </div>

      {/* Body */}
      <div className="flex-1 min-h-0">
        <ScrollArea className="h-full">
          <div
            data-clearsel="1"
            className={`p-4 space-y-4 min-h-full transition-colors ${
              dragOver ? "bg-primary/5 ring-2 ring-inset ring-primary/40 rounded-lg" : ""
            }`}
            onDragOver={(e) => {
              e.preventDefault();
              if (isReadOnly) return;
              if (e.dataTransfer.types.includes("Files")) setDragOver(true);
            }}
            onDragLeave={(e) => {
              if (e.currentTarget.contains(e.relatedTarget as Node)) return;
              setDragOver(false);
            }}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              if (isReadOnly) return;
              const files = Array.from(e.dataTransfer.files ?? []);
              files.forEach((f) => {
                if (f.size > 100 * 1024 * 1024) {
                  toast.error(`"${f.name}" melebihi 100 MB`);
                  return;
                }
                onPickUpload(f);
              });
            }}
          >
            {isLoading ? (
              <div className="space-y-2">
                {Array.from({ length: 6 }).map((_, i) => (
                  <Skeleton key={i} className="h-12 rounded-lg" />
                ))}
              </div>
            ) : error ? (
              <div className="text-center py-12 text-sm max-w-md mx-auto">
                <AlertTriangle className="size-10 mx-auto mb-3 text-destructive/60" />
                <p className="text-destructive mb-2">
                  {error instanceof Error ? error.message : "Gagal memuat"}
                </p>
                {(error as Error & { hint?: string }).hint ? (
                  <p className="text-xs text-muted-foreground mb-3">
                    {(error as Error & { hint?: string }).hint}
                  </p>
                ) : null}
                <Button size="sm" variant="outline" onClick={() => refetch()}>
                  <RefreshCw className="size-4" /> Coba lagi
                </Button>
              </div>
            ) : entries.length === 0 ? (
              <div className="text-center py-12 text-sm text-muted-foreground">
                {dragOver ? (
                  <div className="flex flex-col items-center gap-2 py-6">
                    <UploadCloud className="size-10 text-primary animate-bounce" />
                    <p className="font-medium text-foreground">
                      Lepaskan file untuk diunggah ke folder ini
                    </p>
                  </div>
                ) : (
                  <>
                    <Folder className="size-8 mx-auto mb-2 opacity-50" />
                    Folder ini kosong. Unggah file (bisa drag & drop), buat
                    folder, atau tempel item.
                  </>
                )}
              </div>
            ) : (
              <div className="space-y-1">
                {entries.map((entry) => {
                  const isSelected = selected.has(entry.nodeId);
                  return (
                    <MegaRow
                      key={entry.nodeId}
                      entry={entry}
                      accountId={accountId ?? ""}
                      selected={isSelected}
                      canWrite={canWrite}
                      onOpen={() => openEntry(entry)}
                      onToggleSelect={(additive) =>
                        toggleSelect(entry.nodeId, additive)
                      }
                      onSelectRange={() => selectEntry(entry.nodeId, "range")}
                      onPreview={() => setPreviewFile(entryToFileItem(entry))}
                      onRename={() => setRenameTarget(entry)}
                      onMove={() => setMoveTarget(entry)}
                      onDelete={() => setDeleteTargets([entry])}
                      onCopyOne={() => {
                        setClipboard({ mode: "copy", entries: [entry] });
                        toast.success("1 item disalin. Buka folder tujuan lalu Tempel.");
                      }}
                      onCutOne={() => {
                        setClipboard({ mode: "cut", entries: [entry] });
                        toast.success("1 item dipotong. Buka folder tujuan lalu Tempel.");
                      }}
                      onPasteInto={() => {
                        if (entry.isFolder) {
                          void pasteInto(entry.nodeId);
                        }
                      }}
                      canPaste={!!clipboard && canWrite}
                      onDownload={() => downloadBackground(entry)}
                    />
                  );
                })}
              </div>
            )}
          </div>
        </ScrollArea>
      </div>

      {/* Preview file MEGA (semua tipe + fullscreen) */}
      <FilePreview file={previewFile} onClose={() => setPreviewFile(null)} />

      {/* Dialog: folder baru */}
      <NameDialog
        open={mkdirOpen}
        onOpenChange={setMkdirOpen}
        title="Folder Baru"
        description={`Dibuat di dalam ${
          data?.path?.[data.path.length - 1]?.name ?? "MEGA root"
        }.`}
        submitLabel="Buat"
        onSubmit={(name) => {
          opsMut.mutate({
            action: "mkdir",
            parentNodeId: nodeId,
            name,
          });
          setMkdirOpen(false);
        }}
        pending={opsPending}
      />

      {/* Dialog: rename */}
      <NameDialog
        open={!!renameTarget}
        onOpenChange={(o) => !o && setRenameTarget(null)}
        title="Ganti Nama"
        description={`Rename "${renameTarget?.name ?? ""}".`}
        initial={renameTarget?.name ?? ""}
        submitLabel="Rename"
        onSubmit={(name) => {
          if (!renameTarget) return;
          opsMut.mutate({
            action: "rename",
            nodeId: renameTarget.nodeId,
            name,
          });
          setRenameTarget(null);
        }}
        pending={opsPending}
      />

      {/* Dialog: pindah */}
      <MoveDialog
        open={!!moveTarget}
        onOpenChange={(o) => !o && setMoveTarget(null)}
        entry={moveTarget}
        folders={foldersInCurrentDir}
        currentRootId={nodeId}
        onMove={(targetParentId) => {
          if (!moveTarget) return;
          opsMut.mutate({
            action: "move",
            nodeId: moveTarget.nodeId,
            targetParentId,
          });
          setMoveTarget(null);
        }}
        pending={opsPending}
      />

      {/* Konfirmasi hapus permanen (bisa multi) */}
      <AlertDialog
        open={!!deleteTargets}
        onOpenChange={(o) => !o && setDeleteTargets(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Hapus permanen dari MEGA Cloud?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {(deleteTargets?.length ?? 0) === 1 ? (
                <>
                  <b>{deleteTargets?.[0]?.name}</b>
                  {deleteTargets?.[0]?.isFolder
                    ? " beserta SELURUH isi foldernya"
                    : ""}{" "}
                  akan dihapus permanen.
                </>
              ) : (
                <>
                  <b>{deleteTargets?.length ?? 0} item</b> akan dihapus permanen
                  dari MEGA — tidak masuk trash dan tidak bisa dikembalikan.
                </>
              )}{" "}
              File tugas/lampiran yang terhubung dengannya juga ikut terhapus
              dari aplikasi.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Batal</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={opsPending}
              onClick={(e) => {
                e.preventDefault();
                const targets = deleteTargets ?? [];
                setDeleteTargets(null);
                void doDelete(targets);
              }}
            >
              {opsPending ? (
                <Loader2 className="size-4 animate-spin mr-2" />
              ) : null}
              Hapus Permanen
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ───────────────────────── Baris file/folder + context menu ─────────────────────────

function MegaRow({
  entry,
  accountId,
  selected,
  canWrite,
  onOpen,
  onToggleSelect,
  onSelectRange,
  onPreview,
  onDownload,
  onRename,
  onMove,
  onDelete,
  onCopyOne,
  onCutOne,
  onPasteInto,
  canPaste,
}: {
  entry: MegaEntry;
  accountId: string;
  selected: boolean;
  canWrite: boolean;
  onOpen: () => void;
  onToggleSelect: (additive: boolean) => void;
  onSelectRange: () => void;
  onPreview: () => void;
  onDownload: () => void;
  onRename: () => void;
  onMove: () => void;
  onDelete: () => void;
  onCopyOne: () => void;
  onCutOne: () => void;
  onPasteInto: () => void;
  canPaste: boolean;
}) {
  const timeLabel = entry.timestamp
    ? formatDistanceToNow(new Date(entry.timestamp), {
        addSuffix: true,
        locale: localeId,
      })
    : "";

  // ── Perilaku klik standar explorer/drive ──
  // 1 klik = pilih · Ctrl/Cmd+klik = toggle · Shift+klik = rentang ·
  // 2 klik = buka (folder) / pratinjau (file).
  function handleClick(e: React.MouseEvent) {
    if (e.shiftKey) {
      e.preventDefault(); // cegah seleksi teks bawaan browser
      onSelectRange();
      return;
    }
    onToggleSelect(e.ctrlKey || e.metaKey);
  }
  function handleDoubleClick(e: React.MouseEvent) {
    onOpen();
  }
  // Klik kanan: pastikan baris ini terpilih dulu sebelum menu muncul.
  function handleContextMenu(e: React.MouseEvent) {
    if (!selected) onToggleSelect(false);
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          className={`w-full flex items-center gap-2 px-3 py-2.5 rounded-lg text-left transition-colors group cursor-pointer select-none ${
            selected
              ? "bg-primary/10 ring-1 ring-inset ring-primary/30"
              : "hover:bg-secondary/60"
          }`}
          onClick={handleClick}
          onDoubleClick={handleDoubleClick}
          onContextMenu={handleContextMenu}
          title={`${entry.name} — 2 klik untuk ${entry.isFolder ? "membuka" : "pratinjau"}`}
        >
          {/* Checkbox select */}
          <button
            type="button"
            className={`shrink-0 rounded border transition-colors ${
              selected
                ? "bg-primary border-primary text-primary-foreground"
                : "border-muted-foreground/40 opacity-0 group-hover:opacity-100 focus:opacity-100"
            } h-4 w-4 flex items-center justify-center`}
            title="Pilih"
            onClick={(e) => {
              e.stopPropagation();
              onToggleSelect(true);
            }}
          >
            {selected ? <CheckSquare className="size-3" /> : null}
          </button>

          {entry.isFolder ? (
            <span className="rounded-md bg-red-500/10 p-1.5 shrink-0">
              <Folder className="size-4 text-red-500" />
            </span>
          ) : (
            <span className="rounded-md bg-secondary p-1.5 shrink-0 text-muted-foreground">
              <HardDrive className="size-4" />
            </span>
          )}

          <span className="flex-1 min-w-0">
            <span className="block text-sm font-medium truncate">
              {entry.name}
            </span>
            <span className="block text-[11px] text-muted-foreground">
              {entry.isFolder ? "Folder" : formatBytes(entry.size)}
              {timeLabel ? ` · ${timeLabel}` : ""}
            </span>
          </span>

          <RowMenu
            entry={entry}
            canWrite={canWrite}
            onPreview={onPreview}
            onRename={onRename}
            onMove={onMove}
            onDelete={onDelete}
            onCopyOne={onCopyOne}
            onCutOne={onCutOne}
            onDownload={onDownload}
          />
          <ChevronRight className="size-4 text-muted-foreground opacity-0 group-hover:opacity-100 shrink-0" />
        </div>
      </ContextMenuTrigger>

      {/* Klik kanan — menu explorer lengkap */}
      <ContextMenuContent className="w-52">
        <ContextMenuItem onClick={onOpen}>
          {entry.isFolder ? (
            <Folder className="size-4" />
          ) : (
            <Eye className="size-4" />
          )}
          {entry.isFolder ? "Buka" : "Pratinjau"}
        </ContextMenuItem>
        {!entry.isFolder ? (
          <ContextMenuItem onClick={onDownload}>
            <Download className="size-4" /> Unduh
          </ContextMenuItem>
        ) : null}
        {canWrite ? (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem onClick={onCopyOne}>
              <Copy className="size-4" /> Salin
            </ContextMenuItem>
            <ContextMenuItem onClick={onCutOne}>
              <Scissors className="size-4" /> Potong
            </ContextMenuItem>
            <ContextMenuItem onClick={onRename}>
              <Pencil className="size-4" /> Ganti nama (F2)
            </ContextMenuItem>
            <ContextMenuItem onClick={onMove}>
              <FolderInput className="size-4" /> Pindahkan…
            </ContextMenuItem>
            {entry.isFolder && canPaste ? (
              <ContextMenuItem onClick={onPasteInto}>
                <ClipboardPaste className="size-4" /> Tempel ke sini
              </ContextMenuItem>
            ) : null}
            <ContextMenuSeparator />
            <ContextMenuItem
              className="text-destructive focus:text-destructive"
              onClick={onDelete}
            >
              <Trash2 className="size-4" /> Hapus permanen
            </ContextMenuItem>
          </>
        ) : null}
      </ContextMenuContent>
    </ContextMenu>
  );
}

// ───────────────────────── Menu titik-tiga per baris ─────────────────────────

function RowMenu({
  entry,
  canWrite,
  onPreview,
  onRename,
  onMove,
  onDelete,
  onCopyOne,
  onCutOne,
  onDownload,
}: {
  entry: MegaEntry;
  canWrite: boolean;
  onPreview: () => void;
  onRename: () => void;
  onMove: () => void;
  onDelete: () => void;
  onCopyOne: () => void;
  onCutOne: () => void;
  onDownload: () => void;
}) {
  return (
    <span
      className="shrink-0"
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="size-7 opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100"
            title="Aksi"
          >
            <MoreVertical className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          {entry.isFolder ? null : (
            <>
              <DropdownMenuItem onClick={onPreview}>
                <Eye className="size-4" /> Pratinjau
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onDownload}>
                <Download className="size-4" /> Unduh
              </DropdownMenuItem>
            </>
          )}
          {canWrite ? (
            <>
              {entry.isFolder ? null : <DropdownMenuSeparator />}
              <DropdownMenuItem onClick={onCopyOne}>
                <Copy className="size-4" /> Salin
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onCutOne}>
                <Scissors className="size-4" /> Potong
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onRename}>
                <Pencil className="size-4" /> Rename
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onMove}>
                <FolderInput className="size-4" /> Pindahkan
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="text-destructive focus:text-destructive"
                onClick={onDelete}
              >
                <Trash2 className="size-4" /> Hapus permanen
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  );
}

// ───────────────────────── Name dialog (mkdir / rename) ─────────────────────────

function NameDialog({
  open,
  onOpenChange,
  title,
  description,
  initial = "",
  submitLabel,
  onSubmit,
  pending,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  description: string;
  initial?: string;
  submitLabel: string;
  onSubmit: (name: string) => void;
  pending: boolean;
}) {
  const [value, setValue] = useState(initial);
  const [prevOpen, setPrevOpen] = useState(open);
  const [prevInitial, setPrevInitial] = useState(initial);
  if (prevOpen !== open || prevInitial !== initial) {
    setPrevOpen(open);
    setPrevInitial(initial);
    if (open) setValue(initial);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label>Nama</Label>
          <Input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            maxLength={120}
            autoFocus
            onKeyDown={(e) => {
              if (e.key === "Enter" && value.trim()) {
                onSubmit(value.trim());
              }
            }}
          />
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
          >
            Batal
          </Button>
          <Button
            type="button"
            disabled={pending || !value.trim()}
            onClick={() => onSubmit(value.trim())}
          >
            {pending ? <Loader2 className="size-4 animate-spin mr-2" /> : null}
            {submitLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ───────────────────────── Move dialog ─────────────────────────

function MoveDialog({
  open,
  onOpenChange,
  entry,
  folders,
  currentRootId,
  onMove,
  pending,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  entry: MegaEntry | null;
  folders: MegaEntry[];
  currentRootId: string | null;
  onMove: (targetParentId: string | null) => void;
  pending: boolean;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [prevOpen, setPrevOpen] = useState(open);
  if (prevOpen !== open) {
    setPrevOpen(open);
    if (open) setSelected(null);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Pindahkan</DialogTitle>
          <DialogDescription>
            Pilih folder tujuan untuk “{entry?.name ?? ""}”. Folder lain bisa
            dipilih setelah pindah ke sana.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5 max-h-64 overflow-y-auto">
          {currentRootId ? (
            <button
              type="button"
              onClick={() => setSelected(null)}
              className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-left text-sm ${
                selected === null
                  ? "bg-primary/10 text-primary"
                  : "hover:bg-secondary"
              }`}
            >
              <MegaLogo className="size-3.5" /> MEGA (root)
            </button>
          ) : null}
          {folders
            .filter((f) => f.nodeId !== entry?.nodeId)
            .map((f) => (
              <button
                key={f.nodeId}
                type="button"
                onClick={() => setSelected(f.nodeId)}
                className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-left text-sm ${
                  selected === f.nodeId
                    ? "bg-primary/10 text-primary"
                    : "hover:bg-secondary"
                }`}
              >
                <Folder className="size-4" /> {f.name}
              </button>
            ))}
          {currentRootId && folders.length === 0 ? (
            <p className="text-xs text-muted-foreground text-center py-4">
              Belum ada folder lain di folder ini.
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
          >
            Batal
          </Button>
          <Button
            type="button"
            disabled={pending}
            onClick={() => onMove(selected)}
          >
            {pending ? <Loader2 className="size-4 animate-spin mr-2" /> : null}
            Pindahkan
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
