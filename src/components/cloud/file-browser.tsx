"use client";

import { useCallback, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { id as localeId } from "date-fns/locale";
import { toast } from "sonner";
import {
  ChevronRight,
  Folder,
  FolderPlus,
  ListChecks,
  Plus,
  Trash2,
  FileText,
  Loader2,
  Download,
  Shield,
  Lock,
  EyeOff,
  X,
  Pencil,
  FolderInput,
  FolderOpen,
  Copy,
  ClipboardPaste,
  FolderTree,
  Eye,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Checkbox } from "@/components/ui/checkbox";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";

import { FileUpload } from "@/components/cloud/file-upload";
import { FileIcon } from "@/components/cloud/file-icon";
import { AssignmentDetail } from "@/components/cloud/assignment-detail";
import { FilePreview } from "@/components/cloud/file-preview";
import {
  formatBytes,
  mimeToIcon,
  type CloudDocItem,
  type CloudFileItem,
  type CloudFolderItem,
  type FolderTreeNode,
  type FolderPermissionInfo,
  type FilePermissionInfo,
  type ClassroomMemberOption,
  type Visibility,
  type FoldersListResponse,
} from "@/lib/cloud-format";
import { useUIStore } from "@/stores/ui-store";
import type { MeResponse } from "@/hooks/use-me";

function fmtRelative(iso: string) {
  try {
    return formatDistanceToNow(new Date(iso), {
      addSuffix: true,
      locale: localeId,
    });
  } catch {
    return iso;
  }
}

// ───────────────────────── Clipboard state ─────────────────────────

type Clipboard = {
  mode: "cut" | "copy";
  kind: "file" | "folder";
  ids: string[];
} | null;

// ───────────────────────── Permission helpers ─────────────────────────

function canManage(
  me: MeResponse,
  classroomId: string,
  ownerId: string
): boolean {
  if (me.user?.role === "ADMIN" || me.user?.role === "GURU") return true;
  if (me.user?.id === ownerId) return true;
  return false;
}

function isTeacher(me: MeResponse, classroomId: string): boolean {
  if (me.user?.role === "ADMIN") return true;
  const c = me.classrooms.find((c) => c.id === classroomId);
  return c?.memberRole === "TEACHER";
}

// Permissions (visibility + grants) UI is admin + owner only, per the user
// requirement "cuman admin dan ownernya". Distinct from `canManage` which
// includes GURU + classroom teachers for content edits (rename/move/delete).
function canManagePermissions(me: MeResponse, ownerId: string): boolean {
  if (me.user?.role === "ADMIN") return true;
  if (me.user?.id === ownerId) return true;
  return false;
}

// ───────────────────────── Main component ─────────────────────────

export function FileBrowser({
  classroomId,
  folderId,
  me,
}: {
  classroomId: string;
  folderId: string | null;
  me: MeResponse;
}) {
  const qc = useQueryClient();
  const openCloudFolder = useUIStore((s) => s.openCloudFolder);
  const openCloudDoc = useUIStore((s) => s.openCloudDoc);

  const [selectedFolders, setSelectedFolders] = useState<Set<string>>(new Set());
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());
  const [clipboard, setClipboard] = useState<Clipboard>(null);
  const [previewFile, setPreviewFile] = useState<CloudFileItem | null>(null);

  // Single-item action dialogs.
  const [renameTarget, setRenameTarget] = useState<
    | { kind: "folder"; item: CloudFolderItem }
    | { kind: "file"; item: CloudFileItem }
    | null
  >(null);
  const [permTarget, setPermTarget] = useState<
    | { kind: "folder"; item: CloudFolderItem }
    | { kind: "file"; item: CloudFileItem }
    | null
  >(null);
  const [moveTarget, setMoveTarget] = useState<
    | { kind: "folder"; ids: string[] }
    | { kind: "file"; ids: string[] }
    | null
  >(null);
  const [copyTarget, setCopyTarget] = useState<
    | { kind: "folder"; ids: string[] }
    | { kind: "file"; ids: string[] }
    | null
  >(null);
  const [deleteTarget, setDeleteTarget] = useState<{
    files: CloudFileItem[];
    folders: CloudFolderItem[];
  } | null>(null);

  const queryKey = ["cloud", "folder", classroomId, folderId ?? "root"];
  const { data, isLoading, error, refetch } = useQuery<FoldersListResponse>({
    queryKey,
    queryFn: async () => {
      const params = new URLSearchParams();
      params.set("folderId", folderId ?? "null");
      params.set("classroomId", classroomId);
      const res = await fetch(`/api/cloud/folders?${params.toString()}`, {
        cache: "no-store",
      });
      if (!res.ok) throw new Error("Gagal memuat folder");
      return res.json();
    },
  });

  function invalidateAll() {
    // Invalidate the current folder + classroom root + (best-effort) others.
    qc.invalidateQueries({ queryKey: ["cloud", "folder"] });
  }

  const clearSelection = useCallback(() => {
    setSelectedFolders(new Set());
    setSelectedFiles(new Set());
  }, []);

  // Reset selection whenever the user navigates into another folder — a stale
  // selection from the previous folder lingering in the toolbar would be
  // confusing. We use the "adjust state during render" pattern (per React
  // docs) rather than useEffect to avoid cascading renders.
  const currentFolderKey = `${classroomId}:${folderId ?? "root"}`;
  const [prevFolderKey, setPrevFolderKey] = useState<string>(currentFolderKey);
  if (prevFolderKey !== currentFolderKey) {
    setPrevFolderKey(currentFolderKey);
    setSelectedFolders(new Set());
    setSelectedFiles(new Set());
  }

  // ── Assignment folder detection ──────────────────────────────────
  if (data?.assignment && folderId) {
    return (
      <AssignmentDetail
        folderId={folderId}
        classroomId={classroomId}
        me={me}
        ancestors={data.ancestors}
        onNavigateUp={(target) => openCloudFolder(target, classroomId)}
      />
    );
  }

  const folders = data?.folders ?? [];
  const files = data?.files ?? [];
  const docs = data?.docs ?? [];
  const ancestors = data?.ancestors ?? [];

  const totalSelected = selectedFolders.size + selectedFiles.size;

  // Resolve the currently-selected items (for the contextual toolbar + open).
  const selectedFolderItems = folders.filter((f) => selectedFolders.has(f.id));
  const selectedFileItems = files.filter((f) => selectedFiles.has(f.id));

  const singleSelected:
    | { kind: "folder"; item: CloudFolderItem }
    | { kind: "file"; item: CloudFileItem }
    | null =
    totalSelected === 1
      ? selectedFolderItems.length === 1
        ? { kind: "folder", item: selectedFolderItems[0] }
        : selectedFileItems.length === 1
          ? { kind: "file", item: selectedFileItems[0] }
          : null
      : null;

  // ── Selection helpers (Mega-style) ──────────────────────────────
  // Single-click selects (replaces previous selection). Ctrl/Cmd+click adds
  // to the existing selection (multi-select). Clicking an already-selected
  // item with Ctrl/Cmd held deselects just that item.
  function selectFolder(folder: CloudFolderItem, multi: boolean) {
    if (multi) {
      setSelectedFolders((prev) => {
        const next = new Set(prev);
        if (next.has(folder.id)) next.delete(folder.id);
        else next.add(folder.id);
        return next;
      });
    } else {
      setSelectedFolders(new Set([folder.id]));
      setSelectedFiles(new Set());
    }
  }
  function selectFile(file: CloudFileItem, multi: boolean) {
    if (multi) {
      setSelectedFiles((prev) => {
        const next = new Set(prev);
        if (next.has(file.id)) next.delete(file.id);
        else next.add(file.id);
        return next;
      });
    } else {
      setSelectedFiles(new Set([file.id]));
      setSelectedFolders(new Set());
    }
  }

  function selectAll() {
    setSelectedFolders(new Set(folders.map((f) => f.id)));
    setSelectedFiles(new Set(files.map((f) => f.id)));
  }

  // ── Open the sole-selected item ────────────────────────────────
  // Folder → navigate into. File → open preview dialog.
  function openSelectedItem() {
    if (totalSelected !== 1 || !singleSelected) return;
    if (singleSelected.kind === "folder") {
      openCloudFolder(singleSelected.item.id, classroomId);
    } else {
      setPreviewFile(singleSelected.item);
    }
  }

  // ── Toolbar action dispatchers ─────────────────────────────────
  function onToolbarRename() {
    if (!singleSelected) return;
    setRenameTarget(singleSelected);
  }
  function onToolbarPermissions() {
    if (!singleSelected) return;
    setPermTarget(singleSelected);
  }
  function onToolbarMove() {
    if (totalSelected === 0) return;
    if (selectedFiles.size > 0) {
      setMoveTarget({ kind: "file", ids: Array.from(selectedFiles) });
    } else if (selectedFolders.size > 0) {
      setMoveTarget({ kind: "folder", ids: Array.from(selectedFolders) });
    }
  }
  function onToolbarCopy() {
    if (totalSelected === 0) return;
    if (selectedFiles.size > 0) {
      setCopyTarget({ kind: "file", ids: Array.from(selectedFiles) });
    } else if (selectedFolders.size > 0) {
      // Folder copy not supported in this iteration; show a hint.
      toast.info("Salin folder belum didukung. Pindahkan saja, atau pilih file.");
    }
  }
  function onToolbarDelete() {
    if (totalSelected === 0) return;
    const selFiles = files.filter((f) => selectedFiles.has(f.id));
    const selFolders = folders.filter((f) => selectedFolders.has(f.id));
    if (selFiles.length === 0 && selFolders.length === 0) return;
    setDeleteTarget({ files: selFiles, folders: selFolders });
  }

  // ── Cut/Copy clipboard ───────────────────────────────────────────
  function onCut() {
    if (totalSelected === 0) return;
    if (selectedFiles.size > 0) {
      setClipboard({
        mode: "cut",
        kind: "file",
        ids: Array.from(selectedFiles),
      });
      toast.success(`${selectedFiles.size} file dipotong. Tempel di folder tujuan.`);
    } else if (selectedFolders.size > 0) {
      setClipboard({
        mode: "cut",
        kind: "folder",
        ids: Array.from(selectedFolders),
      });
      toast.success(
        `${selectedFolders.size} folder dipotong. Tempel di folder tujuan.`
      );
    }
    clearSelection();
  }
  function onCopy() {
    if (totalSelected === 0) return;
    if (selectedFiles.size > 0) {
      setClipboard({
        mode: "copy",
        kind: "file",
        ids: Array.from(selectedFiles),
      });
      toast.success(`${selectedFiles.size} file disalin. Tempel di folder tujuan.`);
    } else if (selectedFolders.size > 0) {
      toast.info("Salin folder belum didukung.");
    }
    clearSelection();
  }

  // ── Keyboard shortcuts (Delete / Enter / Escape) ───────────────
  // Attached to the wrapper div via onKeyDown so it only fires when the
  // browser pane has focus. We bail out when the user is typing in an input
  // or textarea (e.g. rename dialog) — those handle their own keys.
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
    if (totalSelected === 0) return;
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      onToolbarDelete();
    } else if (e.key === "Enter") {
      e.preventDefault();
      openSelectedItem();
    }
  }

  async function onPaste() {
    if (!clipboard || clipboard.ids.length === 0) return;
    const endpoint =
      clipboard.kind === "file" ? "/api/cloud/files" : "/api/cloud/folders";
    const action = clipboard.mode === "cut" ? "move" : "copy";
    try {
      const res = await fetch(`${endpoint}/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          [clipboard.kind === "file" ? "fileIds" : "folderIds"]:
            clipboard.ids,
          targetFolderId: folderId,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json?.error || "Gagal menempel");
        return;
      }
      toast.success(
        clipboard.mode === "cut"
          ? `Berhasil memindahkan ${clipboard.ids.length} item.`
          : `Berhasil menyalin ${clipboard.ids.length} item.`
      );
      if (clipboard.mode === "cut") setClipboard(null);
      invalidateAll();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Kesalahan jaringan");
    }
  }

  // ── Render ──────────────────────────────────────────────────────
  return (
    <div
      className="flex flex-col h-full outline-none"
      tabIndex={0}
      onKeyDown={onKeyDown}
      onMouseDown={(e) => {
        // Click on the wrapper background (not a card) clears the selection.
        // We check that the target is the wrapper itself, not a child.
        if (e.target === e.currentTarget) {
          clearSelection();
        }
      }}
    >
      {/* Breadcrumb + actions */}
      <div className="border-b border-border px-4 py-3 flex items-center gap-2 flex-wrap">
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem>
              {folderId ? (
                <BreadcrumbLink
                  className="cursor-pointer"
                  onClick={() => openCloudFolder(null, classroomId)}
                >
                  Root
                </BreadcrumbLink>
              ) : (
                <BreadcrumbPage>Root</BreadcrumbPage>
              )}
            </BreadcrumbItem>
            {ancestors.map((a, i) => {
              const isLast = i === ancestors.length - 1;
              return (
                <span key={a.id} className="contents">
                  <BreadcrumbSeparator />
                  <BreadcrumbItem>
                    {isLast ? (
                      <BreadcrumbPage>{a.name}</BreadcrumbPage>
                    ) : (
                      <BreadcrumbLink
                        className="cursor-pointer"
                        onClick={() => openCloudFolder(a.id, classroomId)}
                      >
                        {a.name}
                      </BreadcrumbLink>
                    )}
                  </BreadcrumbItem>
                </span>
              );
            })}
          </BreadcrumbList>
        </Breadcrumb>

        <div className="ml-auto flex items-center gap-2 flex-wrap">
          {clipboard && clipboard.ids.length > 0 ? (
            <Button
              size="sm"
              variant="default"
              onClick={onPaste}
              title={
                clipboard.mode === "cut" ? "Tempel (pindahkan)" : "Tempel (salin)"
              }
            >
              <ClipboardPaste className="size-4" />
              Tempel ({clipboard.ids.length})
            </Button>
          ) : null}

          <Button
            size="sm"
            variant="outline"
            onClick={selectAll}
            title="Pilih semua file & folder di sini"
          >
            <FolderTree className="size-4" /> Pilih semua
          </Button>

          <NewFolderDialog
            parentId={folderId}
            classroomId={classroomId}
            onCreated={() => invalidateAll()}
          />
          {isTeacher(me, classroomId) ? (
            <NewAssignmentDialog
              parentId={folderId}
              classroomId={classroomId}
              onCreated={(fid) => openCloudFolder(fid, classroomId)}
            />
          ) : null}
          <NewDocDialog
            folderId={folderId}
            classroomId={classroomId}
            onCreated={(docId) => openCloudDoc(docId)}
          />
        </div>
      </div>

      {/* Contextual selection toolbar — Mega-style: shows only when
          something is selected. Actions operate on the current selection. */}
      {totalSelected > 0 ? (
        <div className="border-b border-border bg-primary/5 px-4 py-2 flex items-center gap-2 flex-wrap">
          <span className="text-sm font-medium truncate max-w-[40ch]">
            {singleSelected ? singleSelected.item.name : `${totalSelected} dipilih`}
          </span>
          <div className="ml-auto flex items-center gap-2 flex-wrap">
            {totalSelected === 1 ? (
              <Button size="sm" variant="default" onClick={openSelectedItem}>
                {singleSelected?.kind === "folder" ? (
                  <FolderOpen className="size-4" />
                ) : (
                  <Eye className="size-4" />
                )}{" "}
                Buka
              </Button>
            ) : null}
            {totalSelected === 1 ? (
              <Button size="sm" variant="outline" onClick={onToolbarRename}>
                <Pencil className="size-4" /> Ganti nama
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="outline"
              onClick={onToolbarMove}
              title="Pindahkan ke folder lain"
            >
              <FolderInput className="size-4" /> Pindahkan
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={onToolbarCopy}
              title="Salin file terpilih"
            >
              <Copy className="size-4" /> Salin
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={onCut}
              title="Potong (pindahkan via Tempel)"
            >
              <ClipboardPaste className="size-4" /> Potong
            </Button>
            <Button size="sm" variant="destructive" onClick={onToolbarDelete}>
              <Trash2 className="size-4" /> Hapus
            </Button>
            {singleSelected &&
            canManagePermissions(
              me,
              singleSelected.kind === "folder"
                ? singleSelected.item.createdBy
                : singleSelected.item.uploadedBy
            ) ? (
              <Button size="sm" variant="outline" onClick={onToolbarPermissions}>
                <Shield className="size-4" /> Izin akses
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="ghost"
              onClick={clearSelection}
              title="Bersihkan seleksi (Esc)"
            >
              <X className="size-4" /> Batal
            </Button>
          </div>
        </div>
      ) : null}

      {/* Body — clicking on empty background clears selection */}
      <div
        className="flex-1 overflow-y-auto p-4 space-y-6"
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) clearSelection();
        }}
      >
        <FileUpload
          folderId={folderId}
          classroomId={classroomId}
          onUploaded={() => invalidateAll()}
        />

        {isLoading ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-20 rounded-lg" />
            ))}
          </div>
        ) : error ? (
          <div className="text-center py-10 text-sm text-destructive">
            Gagal memuat.{" "}
            <Button variant="link" onClick={() => refetch()}>
              Coba lagi
            </Button>
          </div>
        ) : folders.length === 0 && files.length === 0 && docs.length === 0 ? (
          <div className="text-center py-12 text-sm text-muted-foreground">
            <Folder className="size-8 mx-auto mb-2 opacity-50" />
            Folder kosong. Unggah file atau buat sub-folder.
          </div>
        ) : (
          <>
            {folders.length > 0 ? (
              <section
                onMouseDown={(e) => {
                  if (e.target === e.currentTarget) clearSelection();
                }}
              >
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
                  Folder
                </h3>
                <div
                  className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3"
                  onMouseDown={(e) => {
                    if (e.target === e.currentTarget) clearSelection();
                  }}
                >
                  {folders.map((f) => (
                    <FolderCard
                      key={f.id}
                      folder={f}
                      me={me}
                      classroomId={classroomId}
                      selected={selectedFolders.has(f.id)}
                      onSelect={(multi) => selectFolder(f, multi)}
                      onOpen={() => openCloudFolder(f.id, classroomId)}
                      onRename={() => setRenameTarget({ kind: "folder", item: f })}
                      onMove={(ids) => setMoveTarget({ kind: "folder", ids })}
                      onCopy={() =>
                        toast.info("Salin folder belum didukung.")
                      }
                      onDelete={() =>
                        setDeleteTarget({ files: [], folders: [f] })
                      }
                      onPermissions={() =>
                        setPermTarget({ kind: "folder", item: f })
                      }
                    />
                  ))}
                </div>
              </section>
            ) : null}

            {docs.length > 0 ? (
              <section>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
                  Dokumen Bersama
                </h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                  {docs.map((d) => (
                    <DocCard
                      key={d.id}
                      doc={d}
                      onClick={() => openCloudDoc(d.id)}
                    />
                  ))}
                </div>
              </section>
            ) : null}

            {files.length > 0 ? (
              <section
                onMouseDown={(e) => {
                  if (e.target === e.currentTarget) clearSelection();
                }}
              >
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
                  File
                </h3>
                <div
                  className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3"
                  onMouseDown={(e) => {
                    if (e.target === e.currentTarget) clearSelection();
                  }}
                >
                  {files.map((f) => (
                    <FileRow
                      key={f.id}
                      file={f}
                      me={me}
                      classroomId={classroomId}
                      selected={selectedFiles.has(f.id)}
                      onSelect={(multi) => selectFile(f, multi)}
                      onOpen={() => setPreviewFile(f)}
                      onRename={() => setRenameTarget({ kind: "file", item: f })}
                      onMove={(ids) => setMoveTarget({ kind: "file", ids })}
                      onCopy={(ids) => setCopyTarget({ kind: "file", ids })}
                      onDelete={() =>
                        setDeleteTarget({ files: [f], folders: [] })
                      }
                      onPermissions={() =>
                        setPermTarget({ kind: "file", item: f })
                      }
                    />
                  ))}
                </div>
              </section>
            ) : null}
          </>
        )}
      </div>

      {/* File preview (double-click open) */}
      <FilePreview file={previewFile} onClose={() => setPreviewFile(null)} />

      {/* Dialogs */}
      {renameTarget ? (
        <RenameDialog
          target={renameTarget}
          onClose={() => setRenameTarget(null)}
          onDone={() => {
            setRenameTarget(null);
            invalidateAll();
          }}
        />
      ) : null}

      {permTarget ? (
        <PermissionDialog
          target={permTarget}
          classroomId={classroomId}
          onClose={() => setPermTarget(null)}
          onDone={() => {
            setPermTarget(null);
            invalidateAll();
          }}
        />
      ) : null}

      {moveTarget ? (
        <FolderPickerDialog
          title="Pindahkan ke folder"
          description="Pilih folder tujuan untuk memindahkan item terpilih."
          classroomId={classroomId}
          excludeIds={moveTarget.kind === "folder" ? moveTarget.ids : []}
          currentFolderId={folderId}
          onClose={() => setMoveTarget(null)}
          onConfirm={async (targetId) => {
            const endpoint =
              moveTarget.kind === "file"
                ? "/api/cloud/files/move"
                : "/api/cloud/folders/move";
            const body =
              moveTarget.kind === "file"
                ? { fileIds: moveTarget.ids, targetFolderId: targetId }
                : { folderIds: moveTarget.ids, targetFolderId: targetId };
            const res = await fetch(endpoint, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
            });
            const json = await res.json();
            if (!res.ok) {
              toast.error(json?.error || "Gagal memindahkan");
              return false;
            }
            toast.success(`${moveTarget.ids.length} item dipindahkan.`);
            setMoveTarget(null);
            clearSelection();
            invalidateAll();
            return true;
          }}
        />
      ) : null}

      {copyTarget ? (
        <FolderPickerDialog
          title="Salin ke folder"
          description="Pilih folder tujuan untuk menyalin file terpilih."
          classroomId={classroomId}
          excludeIds={[]}
          currentFolderId={folderId}
          onClose={() => setCopyTarget(null)}
          onConfirm={async (targetId) => {
            const endpoint = "/api/cloud/files/copy";
            const body = { fileIds: copyTarget.ids, targetFolderId: targetId };
            const res = await fetch(endpoint, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
            });
            const json = await res.json();
            if (!res.ok) {
              toast.error(json?.error || "Gagal menyalin");
              return false;
            }
            toast.success(`${copyTarget.ids.length} file disalin.`);
            setCopyTarget(null);
            clearSelection();
            invalidateAll();
            return true;
          }}
        />
      ) : null}

      {deleteTarget ? (
        <BatchDeleteDialog
          files={deleteTarget.files}
          folders={deleteTarget.folders}
          onClose={() => setDeleteTarget(null)}
          onDone={() => {
            setDeleteTarget(null);
            clearSelection();
            invalidateAll();
          }}
        />
      ) : null}
    </div>
  );
}

// ───────────────────────── Folder card ─────────────────────────

function FolderCard({
  folder,
  me,
  classroomId,
  selected,
  onSelect,
  onOpen,
  onRename,
  onMove,
  onCopy,
  onDelete,
  onPermissions,
}: {
  folder: CloudFolderItem;
  me: MeResponse;
  classroomId: string;
  selected: boolean;
  onSelect: (multi: boolean) => void;
  onOpen: () => void;
  onRename: () => void;
  onMove: (ids: string[]) => void;
  onCopy: () => void;
  onDelete: () => void;
  onPermissions: () => void;
}) {
  const canManageItem = canManage(me, classroomId, folder.createdBy);
  const canEdit = canManageItem || isTeacher(me, classroomId);
  // Delete is stricter: only admin/guru/owner (not classroom teachers).
  const canDelete = canManageItem;
  // Permissions (visibility + grants) UI is admin + owner only.
  const canShowPermissions = canManagePermissions(me, folder.createdBy);

  function handleClick(e: React.MouseEvent) {
    onSelect(e.ctrlKey || e.metaKey);
  }
  function handleDoubleClick() {
    onOpen();
  }
  // Right-click: ensure this card is the sole selection before showing the
  // menu (Mega/Explorer behaviour).
  function handleContextMenu(e: React.MouseEvent) {
    if (!selected) onSelect(false);
    e.stopPropagation();
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <Card
          role="button"
          tabIndex={0}
          onClick={handleClick}
          onDoubleClick={handleDoubleClick}
          onContextMenu={handleContextMenu}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              onOpen();
            } else if (e.key === " ") {
              e.preventDefault();
              onSelect(e.ctrlKey || e.metaKey);
            }
          }}
          className={`p-4 gap-2 transition-colors cursor-pointer select-none ${
            selected
              ? "border-primary ring-2 ring-primary/30 bg-primary/5"
              : "hover:bg-accent/40 hover:border-primary/40"
          }`}
        >
          <div className="flex items-start gap-3">
            <div className="rounded-md bg-primary/10 p-2 text-primary shrink-0">
              <Folder className="size-5" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="font-medium truncate" title={folder.name}>
                {folder.name}
              </p>
              <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                {folder.type === "ASSIGNMENT" ? (
                  <Badge className="bg-amber-500 text-white border-transparent">
                    Tugas
                  </Badge>
                ) : null}
                <VisibilityBadge visibility={folder.visibility} />
              </div>
            </div>
            <ChevronRight className="size-4 text-muted-foreground opacity-50 mt-1" />
          </div>
        </Card>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onClick={onOpen}>
          <FolderOpen className="size-4" /> Buka
        </ContextMenuItem>
        <ContextMenuSeparator />
        {canEdit ? (
          <>
            <ContextMenuItem onClick={onRename}>
              <Pencil className="size-4" /> Ganti nama
            </ContextMenuItem>
            <ContextMenuItem onClick={() => onMove([folder.id])}>
              <FolderInput className="size-4" /> Pindahkan
            </ContextMenuItem>
            <ContextMenuItem onClick={onCopy}>
              <Copy className="size-4" /> Salin
            </ContextMenuItem>
          </>
        ) : null}
        {canShowPermissions ? (
          <>
            {canEdit ? <ContextMenuSeparator /> : null}
            <ContextMenuItem onClick={onPermissions}>
              <Shield className="size-4" /> Izin akses
            </ContextMenuItem>
          </>
        ) : null}
        {canDelete ? (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem variant="destructive" onClick={onDelete}>
              <Trash2 className="size-4" /> Hapus
            </ContextMenuItem>
          </>
        ) : null}
      </ContextMenuContent>
    </ContextMenu>
  );
}

// ───────────────────────── Doc card ─────────────────────────

function DocCard({ doc, onClick }: { doc: CloudDocItem; onClick: () => void }) {
  return (
    <Card
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
      className="p-4 gap-2 hover:bg-accent/40 hover:border-primary/40 transition-colors cursor-pointer"
    >
      <div className="flex items-start gap-3">
        <div className="rounded-md bg-amber-500/15 p-2 text-amber-700 dark:text-amber-300">
          <FileText className="size-5" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="font-medium truncate">{doc.title}</p>
          <p className="text-xs text-muted-foreground">
            Diperbarui {fmtRelative(doc.updatedAt)}
          </p>
          {doc.creator ? (
            <p className="text-xs text-muted-foreground truncate">
              oleh {doc.creator.name}
            </p>
          ) : null}
        </div>
        <ChevronRight className="size-4 text-muted-foreground opacity-50" />
      </div>
    </Card>
  );
}

// ───────────────────────── File row ─────────────────────────

function FileRow({
  file,
  me,
  classroomId,
  selected,
  onSelect,
  onOpen,
  onRename,
  onMove,
  onCopy,
  onDelete,
  onPermissions,
}: {
  file: CloudFileItem;
  me: MeResponse;
  classroomId: string;
  selected: boolean;
  onSelect: (multi: boolean) => void;
  onOpen: () => void;
  onRename: () => void;
  onMove: (ids: string[]) => void;
  onCopy: (ids: string[]) => void;
  onDelete: () => void;
  onPermissions: () => void;
}) {
  const iconName = mimeToIcon(file.mimetype);
  const canManageItem = canManage(me, classroomId, file.uploadedBy);
  const canEdit = canManageItem || isTeacher(me, classroomId);
  // Delete is stricter: only admin/guru/owner (not classroom teachers).
  const canDelete = canManageItem;
  // Permissions (visibility + grants) UI is admin + owner only.
  const canShowPermissions = canManagePermissions(me, file.uploadedBy);

  function handleClick(e: React.MouseEvent) {
    onSelect(e.ctrlKey || e.metaKey);
  }
  function handleDoubleClick() {
    onOpen();
  }
  function handleContextMenu(e: React.MouseEvent) {
    if (!selected) onSelect(false);
    e.stopPropagation();
  }

  const stop = (e: React.MouseEvent) => e.stopPropagation();

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <Card
          role="button"
          tabIndex={0}
          onClick={handleClick}
          onDoubleClick={handleDoubleClick}
          onContextMenu={handleContextMenu}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              onOpen();
            } else if (e.key === " ") {
              e.preventDefault();
              onSelect(e.ctrlKey || e.metaKey);
            }
          }}
          className={`p-4 gap-2 transition-colors cursor-pointer select-none ${
            selected
              ? "border-primary ring-2 ring-primary/30 bg-primary/5"
              : "hover:bg-accent/40 hover:border-primary/40"
          }`}
        >
          <div className="flex items-start gap-3">
            <div className="rounded-md bg-secondary p-2 text-secondary-foreground shrink-0">
              <FileIcon name={iconName} className="size-5" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="font-medium truncate" title={file.name}>
                {file.name}
              </p>
              <p className="text-xs text-muted-foreground">
                {formatBytes(file.size)} · {fmtRelative(file.createdAt)}
              </p>
              <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                {file.uploader ? (
                  <span className="text-xs text-muted-foreground truncate">
                    oleh {file.uploader.name}
                  </span>
                ) : null}
                <VisibilityBadge visibility={file.visibility} />
              </div>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      asChild
                      variant="ghost"
                      size="icon"
                      className="size-8"
                      onClick={stop}
                    >
                      <a
                        href={`/api/storage/${file.storageKey}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        download={file.name}
                      >
                        <Download className="size-4" />
                      </a>
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Unduh</TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>
          </div>
        </Card>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onClick={onOpen}>
          <Eye className="size-4" /> Buka pratinjau
        </ContextMenuItem>
        <ContextMenuSeparator />
        {canEdit ? (
          <>
            <ContextMenuItem onClick={onRename}>
              <Pencil className="size-4" /> Ganti nama
            </ContextMenuItem>
            <ContextMenuItem onClick={() => onMove([file.id])}>
              <FolderInput className="size-4" /> Pindahkan
            </ContextMenuItem>
            <ContextMenuItem onClick={() => onCopy([file.id])}>
              <Copy className="size-4" /> Salin
            </ContextMenuItem>
          </>
        ) : null}
        {canShowPermissions ? (
          <>
            {canEdit ? <ContextMenuSeparator /> : null}
            <ContextMenuItem onClick={onPermissions}>
              <Shield className="size-4" /> Izin akses
            </ContextMenuItem>
          </>
        ) : null}
        {canDelete ? (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem variant="destructive" onClick={onDelete}>
              <Trash2 className="size-4" /> Hapus
            </ContextMenuItem>
          </>
        ) : null}
      </ContextMenuContent>
    </ContextMenu>
  );
}

// ───────────────────────── Visibility badge ─────────────────────────

function VisibilityBadge({ visibility }: { visibility: Visibility }) {
  if (visibility === "ALL") return null;
  if (visibility === "TEACHERS") {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge
              variant="outline"
              className="gap-1 border-amber-500/40 text-amber-700 dark:text-amber-300"
            >
              <Lock className="size-3" /> Guru
            </Badge>
          </TooltipTrigger>
          <TooltipContent>Hanya guru & admin</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }
  // PRIVATE
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge
            variant="outline"
            className="gap-1 border-primary/40 text-primary"
          >
            <EyeOff className="size-3" /> Privat
          </Badge>
        </TooltipTrigger>
        <TooltipContent>Hanya pengguna tertentu</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

// ───────────────────────── Rename dialog ─────────────────────────

function RenameDialog({
  target,
  onClose,
  onDone,
}: {
  target:
    | { kind: "folder"; item: CloudFolderItem }
    | { kind: "file"; item: CloudFileItem };
  onClose: () => void;
  onDone: () => void;
}) {
  const initialName = target.item.name;
  const [name, setName] = useState(initialName);
  const [busy, setBusy] = useState(false);

  async function submit() {
    const trimmed = name.trim();
    if (!trimmed) {
      toast.error("Nama tidak boleh kosong.");
      return;
    }
    setBusy(true);
    try {
      const endpoint =
        target.kind === "file"
          ? `/api/cloud/files/${target.item.id}`
          : `/api/cloud/folders/${target.item.id}`;
      const res = await fetch(endpoint, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: trimmed }),
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json?.error || "Gagal mengganti nama");
        return;
      }
      toast.success("Nama diperbarui.");
      onDone();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            Ganti nama {target.kind === "file" ? "file" : "folder"}
          </DialogTitle>
          <DialogDescription>
            Nama baru untuk &quot;{initialName}&quot;.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="rename-input">Nama</Label>
          <Input
            id="rename-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
            onKeyDown={(e) => {
              if (e.key === "Enter" && name.trim()) {
                void submit();
              }
            }}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Batal
          </Button>
          <Button onClick={submit} disabled={busy || !name.trim()}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : null}
            Simpan
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ───────────────────────── Permission dialog ─────────────────────────

function PermissionDialog({
  target,
  classroomId,
  onClose,
  onDone,
}: {
  target:
    | { kind: "folder"; item: CloudFolderItem }
    | { kind: "file"; item: CloudFileItem };
  classroomId: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const permKey = [
    "cloud",
    "perms",
    target.kind,
    target.item.id,
  ];
  const { data: permInfo, isLoading } = useQuery<
    FolderPermissionInfo | FilePermissionInfo
  >({
    queryKey: permKey,
    queryFn: async () => {
      const endpoint =
        target.kind === "file"
          ? `/api/cloud/files/${target.item.id}/permissions`
          : `/api/cloud/folders/${target.item.id}/permissions`;
      const res = await fetch(endpoint, { cache: "no-store" });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j?.error || "Gagal memuat izin");
      }
      return res.json();
    },
  });

  const membersQuery = useQuery<{ members: ClassroomMemberOption[] }>({
    queryKey: ["cloud", "classroom-members", classroomId],
    queryFn: async () => {
      const res = await fetch(
        `/api/cloud/classrooms/${classroomId}/members`,
        { cache: "no-store" }
      );
      if (!res.ok) throw new Error("Gagal memuat anggota");
      return res.json();
    },
  });

  const [visibility, setVisibility] = useState<Visibility>("ALL");
  const [granted, setGranted] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  // Sync state once permInfo loads.
  useMemo(() => {
    if (permInfo && !hydrated) {
      setVisibility(permInfo.visibility);
      setGranted(new Set(permInfo.grantedUsers.map((u) => u.id)));
      setHydrated(true);
    }
  }, [permInfo, hydrated]);

  async function submit() {
    setBusy(true);
    try {
      const endpoint =
        target.kind === "file"
          ? `/api/cloud/files/${target.item.id}/permissions`
          : `/api/cloud/folders/${target.item.id}/permissions`;
      const body: { visibility: Visibility; grantedUserIds?: string[] } = {
        visibility,
      };
      if (visibility === "PRIVATE") {
        body.grantedUserIds = Array.from(granted);
      }
      const res = await fetch(endpoint, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json?.error || "Gagal menyimpan izin");
        return;
      }
      toast.success("Izin akses diperbarui.");
      onDone();
    } finally {
      setBusy(false);
    }
  }

  const members = membersQuery.data?.members ?? [];

  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Shield className="size-4" /> Izin akses
          </DialogTitle>
          <DialogDescription>
            Siapa yang bisa melihat &quot;{target.item.name}&quot;?
          </DialogDescription>
        </DialogHeader>

        {isLoading || !permInfo ? (
          <div className="space-y-2">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </div>
        ) : (
          <div className="space-y-4">
            <RadioGroup
              value={visibility}
              onValueChange={(v) => setVisibility(v as Visibility)}
            >
              <label
                htmlFor="vis-all"
                className="flex items-start gap-3 rounded-md border border-border p-3 cursor-pointer hover:bg-accent/30"
              >
                <RadioGroupItem id="vis-all" value="ALL" className="mt-0.5" />
                <div>
                  <p className="text-sm font-medium">Semua anggota kelas</p>
                  <p className="text-xs text-muted-foreground">
                    Semua anggota kelas bisa melihat item ini.
                  </p>
                </div>
              </label>
              <label
                htmlFor="vis-teachers"
                className="flex items-start gap-3 rounded-md border border-border p-3 cursor-pointer hover:bg-accent/30"
              >
                <RadioGroupItem
                  id="vis-teachers"
                  value="TEACHERS"
                  className="mt-0.5"
                />
                <div>
                  <p className="text-sm font-medium">Guru &amp; admin saja</p>
                  <p className="text-xs text-muted-foreground">
                    Hanya pengajar kelas dan admin/guru yang bisa melihat.
                  </p>
                </div>
              </label>
              <label
                htmlFor="vis-private"
                className="flex items-start gap-3 rounded-md border border-border p-3 cursor-pointer hover:bg-accent/30"
              >
                <RadioGroupItem
                  id="vis-private"
                  value="PRIVATE"
                  className="mt-0.5"
                />
                <div>
                  <p className="text-sm font-medium">Privat (pilih user)</p>
                  <p className="text-xs text-muted-foreground">
                    Hanya kamu, admin, dan user yang dipilih di bawah.
                  </p>
                </div>
              </label>
            </RadioGroup>

            {visibility === "PRIVATE" ? (
              <div className="space-y-2">
                <Label>Anggota yang bisa melihat</Label>
                {membersQuery.isLoading ? (
                  <Skeleton className="h-24 w-full" />
                ) : members.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    Tidak ada anggota lain.
                  </p>
                ) : (
                  <ScrollArea className="h-48 rounded-md border border-border p-2">
                    <div className="space-y-1">
                      {members.map((m) => (
                        <label
                          key={m.id}
                          className="flex items-center gap-2 rounded-sm px-2 py-1.5 hover:bg-accent/40 cursor-pointer"
                        >
                          <Checkbox
                            checked={granted.has(m.id)}
                            onCheckedChange={(checked) => {
                              setGranted((prev) => {
                                const next = new Set(prev);
                                if (checked) next.add(m.id);
                                else next.delete(m.id);
                                return next;
                              });
                            }}
                          />
                          <span className="text-sm">{m.name}</span>
                          <span className="text-xs text-muted-foreground ml-auto">
                            @{m.username}
                          </span>
                          {m.role === "TEACHER" ? (
                            <Badge variant="outline" className="ml-1">
                              Pengajar
                            </Badge>
                          ) : null}
                        </label>
                      ))}
                    </div>
                  </ScrollArea>
                )}
              </div>
            ) : null}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Batal
          </Button>
          <Button
            onClick={submit}
            disabled={busy || isLoading || !permInfo}
          >
            {busy ? <Loader2 className="size-4 animate-spin" /> : null}
            Simpan
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ───────────────────────── Folder picker dialog ─────────────────────────

function FolderPickerDialog({
  title,
  description,
  classroomId,
  excludeIds,
  currentFolderId,
  onClose,
  onConfirm,
}: {
  title: string;
  description: string;
  classroomId: string;
  excludeIds: string[];
  currentFolderId: string | null;
  onClose: () => void;
  onConfirm: (targetFolderId: string | null) => Promise<boolean>;
}) {
  const { data, isLoading } = useQuery<{ tree: FolderTreeNode[] }>({
    queryKey: ["cloud", "folders", "tree", classroomId],
    queryFn: async () => {
      const res = await fetch(
        `/api/cloud/folders/tree?classroomId=${encodeURIComponent(classroomId)}`,
        { cache: "no-store" }
      );
      if (!res.ok) throw new Error("Gagal memuat pohon folder");
      return res.json();
    },
  });
  const [selected, setSelected] = useState<string | null>(currentFolderId);
  const [busy, setBusy] = useState(false);

  const excludeSet = new Set(excludeIds);

  async function submit() {
    setBusy(true);
    try {
      await onConfirm(selected);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FolderTree className="size-4" /> {title}
          </DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <Skeleton className="h-48 w-full" />
        ) : (
          <ScrollArea className="h-72 rounded-md border border-border p-2">
            <div className="space-y-0.5">
              <label
                className={`flex items-center gap-2 rounded-sm px-2 py-1.5 cursor-pointer hover:bg-accent/40 ${
                  selected === null ? "bg-primary/10" : ""
                }`}
              >
                <input
                  type="radio"
                  name="target-folder"
                  checked={selected === null}
                  onChange={() => setSelected(null)}
                  className="size-4"
                />
                <Folder className="size-4 text-primary" />
                <span className="text-sm font-medium">Root kelas</span>
              </label>
              {(data?.tree ?? []).map((node) =>
                renderTreeNode(
                  node,
                  0,
                  selected,
                  setSelected,
                  excludeSet
                )
              )}
            </div>
          </ScrollArea>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Batal
          </Button>
          <Button onClick={submit} disabled={busy || isLoading}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : null}
            Konfirmasi
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function renderTreeNode(
  node: FolderTreeNode,
  depth: number,
  selected: string | null,
  setSelected: (id: string) => void,
  excludeSet: Set<string>
): React.ReactNode {
  const disabled = excludeSet.has(node.id);
  return (
    <div key={node.id}>
      <label
        className={`flex items-center gap-2 rounded-sm px-2 py-1.5 ${
          disabled
            ? "opacity-50 cursor-not-allowed"
            : "cursor-pointer hover:bg-accent/40"
        } ${selected === node.id ? "bg-primary/10" : ""}`}
        style={{ paddingLeft: `${8 + depth * 12}px` }}
      >
        <input
          type="radio"
          name="target-folder"
          checked={selected === node.id}
          onChange={() => !disabled && setSelected(node.id)}
          disabled={disabled}
          className="size-4"
        />
        <Folder className="size-4 text-primary" />
        <span className="text-sm truncate">{node.name}</span>
        {node.type === "ASSIGNMENT" ? (
          <Badge className="bg-amber-500 text-white border-transparent ml-auto text-xs">
            Tugas
          </Badge>
        ) : null}
      </label>
      {node.children.map((child) =>
        renderTreeNode(child, depth + 1, selected, setSelected, excludeSet)
      )}
    </div>
  );
}

// ───────────────────────── Batch delete dialog ─────────────────────────

function BatchDeleteDialog({
  files,
  folders,
  onClose,
  onDone,
}: {
  files: CloudFileItem[];
  folders: CloudFolderItem[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const totalCount = files.length + folders.length;

  async function submit() {
    setBusy(true);
    try {
      // Delete files via batch endpoint.
      if (files.length > 0) {
        const res = await fetch("/api/cloud/files/batch-delete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fileIds: files.map((f) => f.id) }),
        });
        const json = await res.json();
        if (!res.ok) {
          toast.error(json?.error || "Gagal menghapus file");
          return;
        }
      }
      // Delete folders one-by-one via folder delete endpoint (no batch yet).
      // Each folder delete cascades its files via DB.
      for (const folder of folders) {
        // Cascade: delete child files (storage) first, then folder row.
        await deleteFolderCascade(folder.id);
      }
      toast.success(`${totalCount} item dihapus.`);
      onDone();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Gagal menghapus");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Hapus {totalCount} item?</DialogTitle>
          <DialogDescription>
            Tindakan ini tidak bisa dibatalkan. File/folder yang dihapus akan
            hilang permanen.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1 max-h-48 overflow-y-auto text-sm">
          {folders.map((f) => (
            <div key={f.id} className="flex items-center gap-2">
              <Folder className="size-4 text-primary" />
              <span className="truncate">{f.name}</span>
            </div>
          ))}
          {files.map((f) => (
            <div key={f.id} className="flex items-center gap-2">
              <FileIcon name={mimeToIcon(f.mimetype)} className="size-4" />
              <span className="truncate">{f.name}</span>
            </div>
          ))}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Batal
          </Button>
          <Button variant="destructive" onClick={submit} disabled={busy}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : null}
            Hapus {totalCount}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

async function deleteFolderCascade(folderId: string): Promise<void> {
  // Server-side cascade: DELETE /api/cloud/folders/[id] walks descendants,
  // clears submission links, deletes folders (cascading files/docs/assignments)
  // and best-effort deletes underlying storage blobs.
  await fetch(`/api/cloud/folders/${folderId}`, {
    method: "DELETE",
  });
}

// ───────────────────────── New folder dialog ─────────────────────────

function NewFolderDialog({
  parentId,
  classroomId,
  onCreated,
}: {
  parentId: string | null;
  classroomId: string;
  onCreated: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    try {
      const res = await fetch("/api/cloud/folders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          parentId: parentId ?? undefined,
          classroomId: parentId ? undefined : classroomId,
          type: "FOLDER",
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json?.error || "Gagal membuat folder");
        return;
      }
      toast.success("Folder dibuat.");
      setOpen(false);
      setName("");
      onCreated();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setName("");
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <FolderPlus className="size-4" /> Folder
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Folder baru</DialogTitle>
          <DialogDescription>Buat sub-folder di lokasi ini.</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="folder-name">Nama folder</Label>
          <Input
            id="folder-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Mis. Bab 1"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === "Enter" && name.trim()) {
                void submit();
              }
            }}
          />
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => setOpen(false)}
            disabled={busy}
          >
            Batal
          </Button>
          <Button onClick={submit} disabled={busy || !name.trim()}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : null}
            Buat
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ───────────────────────── New assignment dialog ─────────────────────────

function NewAssignmentDialog({
  parentId,
  classroomId,
  onCreated,
}: {
  parentId: string | null;
  classroomId: string;
  onCreated: (folderId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [deadline, setDeadline] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() + 7);
    d.setHours(23, 55, 0, 0);
    const tzOffset = d.getTimezoneOffset() * 60000;
    return new Date(d.getTime() - tzOffset).toISOString().slice(0, 16);
  });
  const [maxScore, setMaxScore] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    try {
      const payload: Record<string, unknown> = {
        title: title.trim(),
        description: description.trim() || undefined,
        deadline: new Date(deadline).toISOString(),
        classroomId: parentId ? undefined : classroomId,
        parentId: parentId ?? undefined,
      };
      if (maxScore.trim()) {
        const n = Number(maxScore);
        if (Number.isFinite(n)) payload.maxScore = n;
      }
      const res = await fetch("/api/cloud/assignments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json?.error || "Gagal membuat tugas");
        return;
      }
      toast.success("Tugas dibuat.");
      setOpen(false);
      setTitle("");
      setDescription("");
      setMaxScore("");
      onCreated(json.folder.id as string);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) {
          setTitle("");
          setDescription("");
          setMaxScore("");
        }
      }}
    >
      <DialogTrigger asChild>
        <Button variant="default" size="sm">
          <ListChecks className="size-4" /> Tugas
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Buat tugas baru</DialogTitle>
          <DialogDescription>
            Tugas akan menjadi folder khusus dengan tenggat dan pengumpulan.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-2">
            <Label htmlFor="a-title">Judul tugas</Label>
            <Input
              id="a-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Mis. Esai Bab 3"
              autoFocus
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="a-desc">Deskripsi (opsional)</Label>
            <Textarea
              id="a-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              placeholder="Instruksi tugas…"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="a-deadline">Tenggat</Label>
              <Input
                id="a-deadline"
                type="datetime-local"
                value={deadline}
                onChange={(e) => setDeadline(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="a-score">Skor maks (opsional)</Label>
              <Input
                id="a-score"
                type="number"
                min={0}
                max={1000}
                value={maxScore}
                onChange={(e) => setMaxScore(e.target.value)}
                placeholder="100"
              />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => setOpen(false)}
            disabled={busy}
          >
            Batal
          </Button>
          <Button onClick={submit} disabled={busy || !title.trim() || !deadline}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : null}
            Buat tugas
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ───────────────────────── New doc dialog ─────────────────────────

function NewDocDialog({
  folderId,
  classroomId,
  onCreated,
}: {
  folderId: string | null;
  classroomId: string;
  onCreated: (docId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    try {
      const res = await fetch("/api/cloud/docs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          folderId: folderId ?? undefined,
          classroomId,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json?.error || "Gagal membuat dokumen");
        return;
      }
      toast.success("Dokumen dibuat.");
      setOpen(false);
      setTitle("");
      onCreated(json.doc.id as string);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setTitle("");
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Plus className="size-4" /> Doc
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Dokumen bersama</DialogTitle>
          <DialogDescription>
            Buat dokumen yang bisa diedit bersama anggota kelas.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="doc-title">Judul</Label>
          <Input
            id="doc-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Mis. Catatan rapat kelas"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === "Enter" && title.trim()) {
                void submit();
              }
            }}
          />
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => setOpen(false)}
            disabled={busy}
          >
            Batal
          </Button>
          <Button onClick={submit} disabled={busy || !title.trim()}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : null}
            Buat
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
