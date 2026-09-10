"use client";

// Dialog daftar favorit — file & folder yang ditandai bintang. Klik file
// → buka di tab baru (storage key); klik folder/tugas → navigasi Cloud.

import { useQuery } from "@tanstack/react-query";
import { formatBytes } from "@/lib/file-constants";
import { FolderOpen, Star, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FileIcon } from "@/components/cloud/file-icon";
import { mimeToIcon } from "@/lib/cloud-format";
import { useUIStore } from "@/stores/ui-store";

interface FavItem {
  kind: "file" | "folder";
  favoriteId: string;
  id: string;
  name: string;
  // file
  size?: number;
  mimetype?: string;
  storageKey?: string;
  // folder
  type?: string;
  classroomId?: string | null;
  classroomName?: string | null;
}

export function FavoritesDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const openCloudFolder = useUIStore((s) => s.openCloudFolder);
  const { data, isLoading } = useQuery<{ favorites: FavItem[] }>({
    queryKey: ["cloud", "favorites-list"],
    queryFn: async () => {
      const res = await fetch("/api/cloud/favorites", { cache: "no-store" });
      if (!res.ok) throw new Error("Gagal memuat favorit");
      return res.json();
    },
    enabled: open,
  });

  const items = data?.favorites ?? [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[75vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Star className="size-5 text-amber-400 fill-amber-400" /> Favorit Saya
          </DialogTitle>
          <DialogDescription>
            Tandai file dengan bintang di halaman Cloud untuk akses cepat.
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 min-h-0 overflow-y-auto rounded-lg border border-border divide-y divide-border">
          {isLoading ? (
            <div className="p-3 space-y-2">
              <Skeleton className="h-11 w-full" />
              <Skeleton className="h-11 w-full" />
            </div>
          ) : items.length === 0 ? (
            <div className="p-6 text-center text-sm text-muted-foreground">
              <Star className="size-6 mx-auto mb-2 opacity-40" />
              Belum ada favorit — klik ikon bintang pada file di Cloud.
            </div>
          ) : (
            items.map((it) => (
              <button
                key={it.favoriteId}
                type="button"
                onClick={() => {
                  if (it.kind === "folder") {
                    onOpenChange(false);
                    openCloudFolder(it.id);
                  } else if (it.storageKey) {
                    window.open(
                      `/api/storage/${it.storageKey}`,
                      "_blank",
                      "noopener,noreferrer"
                    );
                  }
                }}
                className="flex items-center gap-2.5 w-full px-3 py-2.5 text-left hover:bg-accent/50 transition-colors"
              >
                {it.kind === "folder" ? (
                  <FolderOpen className="size-4.5 shrink-0 text-primary" />
                ) : (
                  <FileIcon
                    name={mimeToIcon(it.mimetype ?? "")}
                    className="size-4.5 shrink-0 text-muted-foreground"
                  />
                )}
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium truncate">{it.name}</p>
                  <p className="text-[10px] text-muted-foreground truncate">
                    {it.kind === "file"
                      ? `${formatBytes(it.size ?? 0)}`
                      : `${it.type === "ASSIGNMENT" ? "Tugas" : "Folder"}${
                          it.classroomName ? ` · ${it.classroomName}` : ""
                        }`}
                  </p>
                </div>
                <Badge variant="secondary" className="text-[9px] shrink-0">
                  {it.kind === "file" ? "file" : "folder"}
                </Badge>
              </button>
            ))
          )}
        </div>

        <p className="text-[10px] text-muted-foreground flex items-center gap-1">
          <X className="size-3 opacity-0" />
          Klik untuk membuka.
        </p>
      </DialogContent>
    </Dialog>
  );
}
