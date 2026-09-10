"use client";

// Cloud Picker — dialog pilih file dari cloud kelas untuk dilampirkan ke
// chat (menggantikan upload langsung dari perangkat). Guru/siswa tetap bisa
// mengunggah file baru; unggahan masuk ke cloud (MEGA/S3) lewat jalur yang
// sama sehingga filenya bisa dipakai ulang di chat lain / di halaman Cloud.

import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Check,
  Cloud,
  FileJson2,
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FileIcon } from "@/components/cloud/file-icon";
import { formatBytes } from "@/lib/file-constants";
import { mimeToIcon } from "@/lib/cloud-format";
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
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<CloudPickerFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Debounce pencarian.
  useEffect(() => {
    const t = setTimeout(() => setQ(search.trim().toLowerCase()), 250);
    return () => clearTimeout(t);
  }, [search]);

  const { data, isLoading, error, refetch } = useQuery<{
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
    enabled: open,
  });

  // Reset pilihan saat dibuka.
  useEffect(() => {
    if (open) {
      setSelected([]);
      setSearch("");
    }
  }, [open]);

  const room = maxAttachments - pendingFileIds.length - selected.length;
  const alreadyPending = new Set(pendingFileIds);

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
      // Setelah terunggah ke cloud, langsung tersedia sebagai lampiran.
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
      void refetch();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Gagal mengunggah");
    } finally {
      setUploading(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Cloud className="size-5 text-primary" /> Lampirkan dari Cloud
          </DialogTitle>
          <DialogDescription>
            Pilih file yang sudah ada di cloud{" "}
            {conversation.kind === "dm" ? "(milikmu)" : "kelas"} — atau unggah
            baru (otomatis tersimpan ke cloud, bisa dipakai ulang).
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Cari nama file…"
              className="pl-8 h-9"
            />
          </div>
          <Button
            variant="outline"
            size="sm"
            disabled={uploading || room <= 0}
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
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto rounded-lg border border-border divide-y divide-border">
          {isLoading ? (
            <div className="p-3 space-y-2">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : error || !data ? (
            <div className="p-4 text-center text-sm text-destructive">
              Gagal memuat file cloud.{" "}
              <Button variant="link" onClick={() => refetch()}>
                Coba lagi
              </Button>
            </div>
          ) : data.files.length === 0 ? (
            <div className="p-6 text-center text-sm text-muted-foreground space-y-1">
              <FileJson2 className="size-6 mx-auto opacity-50" />
              <p>
                {q
                  ? `Tidak ada file yang cocok dengan "${q}".`
                  : "Belum ada file di cloud ini — unggah yang baru di atas."}
              </p>
            </div>
          ) : (
            data.files.map((f) => {
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
          )}
        </div>

        <DialogFooter className="gap-2 sm:justify-between sm:flex-row">
          <span className="text-xs text-muted-foreground">
            {selected.length} dipilih · maks {maxAttachments} per pesan
          </span>
          <div className="flex items-center gap-2">
            {selected.length > 0 ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setSelected([])}
                className="gap-1"
              >
                <X className="size-3.5" /> Bersihkan
              </Button>
            ) : null}
            <Button
              disabled={selected.length === 0}
              onClick={() => {
                onAttach(selected);
                onOpenChange(false);
              }}
              className="gap-1.5"
            >
              <Check className="size-4" /> Lampirkan ({selected.length})
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
