"use client";

import { useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { id as localeId } from "date-fns/locale";
import { toast } from "sonner";
import {
  AlertTriangle,
  ChevronRight,
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
  Trash2,
  X,
  FolderInput,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
  };
  nodeId: string;
  path: { id: string; name: string }[];
  entries: MegaEntry[];
  hint?: string;
}

// ───────────────────────── Component ─────────────────────────

/**
 * Tampilan "mount MEGA Cloud" — FULL AKSES dari dalam file browser:
 * unggah file, buat folder, rename, pindah, hapus permanen, unduh,
 * dan preview. Hanya guru/admin (dipaksa di API-nya).
 */
export function MegaMountView({
  onExit,
}: {
  onExit: () => void;
}) {
  const [nodeId, setNodeId] = useState<string | null>(null);
  const [previewFile, setPreviewFile] = useState<CloudFileItem | null>(null);

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

  // ── State dialog operasi ──
  const [mkdirOpen, setMkdirOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<MegaEntry | null>(null);
  const [moveTarget, setMoveTarget] = useState<MegaEntry | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<MegaEntry | null>(null);
  const uploadInputRef = useRef<HTMLInputElement>(null);

  const accountId = data?.account.id;

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
      toast.success("Operasi MEGA berhasil");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const uploadMut = useMutation({
    mutationFn: async (file: File) => {
      const fd = new FormData();
      fd.append("file", file);
      if (nodeId) fd.append("parentId", nodeId);
      const res = await fetch("/api/cloud/mega/upload", {
        method: "POST",
        body: fd,
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Upload gagal");
      return json;
    },
    onSuccess: () => {
      refetch();
      toast.success("File terunggah ke MEGA");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const onPickUpload = (f: File | null | undefined) => {
    if (!f) return;
    if (f.size > 100 * 1024 * 1024) {
      toast.error("File maksimal 100 MB");
      return;
    }
    uploadMut.mutate(f);
  };

  const usagePct =
    data?.account.spaceTotal && data.account.spaceUsed != null
      ? Math.min(100, (data.account.spaceUsed / data.account.spaceTotal) * 100)
      : null;

  const foldersInCurrentDir = (data?.entries ?? []).filter((e) => e.isFolder);

  const downloadUrl = (entry: MegaEntry) =>
    `/api/storage/mega:${accountId}:${entry.nodeId}?name=${encodeURIComponent(entry.name)}`;

  return (
    <div className="flex flex-col h-full">
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

      {/* Toolbar full-akses */}
      <div className="border-b border-border px-4 py-2 flex items-center gap-2 flex-wrap">
        <Button
          size="sm"
          className="gap-1.5"
          onClick={() => uploadInputRef.current?.click()}
          disabled={uploadMut.isPending || !data}
        >
          {uploadMut.isPending ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <FilePlus2 className="size-4" />
          )}
          Unggah File
        </Button>
        <input
          ref={uploadInputRef}
          type="file"
          className="hidden"
          onChange={(e) => {
            onPickUpload(e.target.files?.[0]);
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
          Folder Baru
        </Button>
        <p className="text-[11px] text-muted-foreground flex items-center gap-1.5 ml-auto">
          <AlertTriangle className="size-3 text-amber-500" />
          Akses penuh — hapus bersifat permanen.
        </p>
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
                        onClick={() =>
                          setNodeId(p.id === "root" ? null : p.id)
                        }
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
          <div className="p-4 space-y-4">
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
            ) : (data?.entries.length ?? 0) === 0 ? (
              <div className="text-center py-12 text-sm text-muted-foreground">
                <Folder className="size-8 mx-auto mb-2 opacity-50" />
                Folder ini kosong. Unggah file atau buat folder baru.
              </div>
            ) : (
              <div className="space-y-1">
                {data?.entries.map((entry) => {
                  if (entry.isFolder) {
                    return (
                      <div
                        key={entry.nodeId}
                        className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-secondary/60 text-left transition-colors group cursor-pointer"
                        onClick={() => setNodeId(entry.nodeId)}
                      >
                        <span className="rounded-md bg-red-500/10 p-1.5 shrink-0">
                          <Folder className="size-4 text-red-500" />
                        </span>
                        <span className="flex-1 min-w-0">
                          <span className="block text-sm font-medium truncate">
                            {entry.name}
                          </span>
                          <span className="block text-[11px] text-muted-foreground">
                            Folder
                            {entry.timestamp
                              ? ` · ${formatDistanceToNow(
                                  new Date(entry.timestamp),
                                  { addSuffix: true, locale: localeId }
                                )}`
                              : ""}
                          </span>
                        </span>
                        <RowMenu
                          entry={entry}
                          onRename={() => setRenameTarget(entry)}
                          onMove={() => setMoveTarget(entry)}
                          onDelete={() => setDeleteTarget(entry)}
                        />
                        <ChevronRight className="size-4 text-muted-foreground opacity-0 group-hover:opacity-100 shrink-0" />
                      </div>
                    );
                  }
                  const fileItem: CloudFileItem = {
                    id: `mega-node-${entry.nodeId}`,
                    name: entry.name,
                    size: entry.size,
                    mimetype: mimetypeFromName(entry.name),
                    storageKey: `mega:${data.account.id}:${entry.nodeId}`,
                    cloudAccountId: data.account.id,
                    createdAt: entry.timestamp
                      ? new Date(entry.timestamp).toISOString()
                      : new Date().toISOString(),
                    uploadedBy: "",
                    uploader: {
                      id: "",
                      name: data.account.name ?? "MEGA",
                      username: data.account.email ?? "mega",
                    },
                    visibility: "ALL",
                    raw: true,
                  };
                  return (
                    <div
                      key={entry.nodeId}
                      className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-secondary/60 text-left transition-colors cursor-pointer"
                      onClick={() => setPreviewFile(fileItem)}
                    >
                      <span className="rounded-md bg-secondary p-1.5 shrink-0 text-muted-foreground">
                        <HardDrive className="size-4" />
                      </span>
                      <span className="flex-1 min-w-0">
                        <span className="block text-sm font-medium truncate">
                          {entry.name}
                        </span>
                        <span className="block text-[11px] text-muted-foreground">
                          {formatBytes(entry.size)}
                          {entry.timestamp
                            ? ` · ${formatDistanceToNow(
                                new Date(entry.timestamp),
                                { addSuffix: true, locale: localeId }
                              )}`
                            : ""}
                        </span>
                      </span>
                      <RowMenu
                        entry={entry}
                        onRename={() => setRenameTarget(entry)}
                        onMove={() => setMoveTarget(entry)}
                        onDelete={() => setDeleteTarget(entry)}
                        downloadUrl={downloadUrl(entry)}
                      />
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </ScrollArea>
      </div>

      {/* Preview file MEGA (image/pdf/audio/video/teks/docx) */}
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
        pending={opsMut.isPending}
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
        pending={opsMut.isPending}
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
        pending={opsMut.isPending}
      />

      {/* Konfirmasi hapus permanen */}
      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(o) => !o && setDeleteTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Hapus permanen dari MEGA Cloud?
            </AlertDialogTitle>
            <AlertDialogDescription>
              <b>{deleteTarget?.name}</b>
              {deleteTarget?.isFolder
                ? " beserta SELURUH isi foldernya"
                : ""}{" "}
              akan dihapus permanen dari MEGA — tidak masuk trash dan tidak
              bisa dikembalikan. File tugas/lampiran yang terhubung dengannya
              juga ikut terhapus dari aplikasi.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Batal</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={opsMut.isPending}
              onClick={(e) => {
                e.preventDefault();
                if (!deleteTarget) return;
                opsMut.mutate({ action: "delete", nodeId: deleteTarget.nodeId });
                setDeleteTarget(null);
              }}
            >
              {opsMut.isPending ? (
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

// ───────────────────────── Row action menu ─────────────────────────

function RowMenu({
  entry,
  onRename,
  onMove,
  onDelete,
  downloadUrl,
}: {
  entry: MegaEntry;
  onRename: () => void;
  onMove: () => void;
  onDelete: () => void;
  downloadUrl?: string;
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
        <DropdownMenuContent align="end" className="w-44">
          {downloadUrl ? (
            <>
              <DropdownMenuItem asChild>
                <a href={downloadUrl} download={entry.name}>
                  <Download className="size-4" /> Unduh
                </a>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          ) : null}
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
