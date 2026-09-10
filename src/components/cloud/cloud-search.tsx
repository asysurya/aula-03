"use client";

// Pencarian global cloud — cari folder/tugas, file, dan dokumen bersama
// lintas kelas (sesuai visibilitas). Hasil diklik → langsung navigasi.

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import {
  FileText,
  FolderOpen,
  Loader2,
  Search,
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
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FileIcon } from "@/components/cloud/file-icon";
import { mimeToIcon } from "@/lib/cloud-format";
import { formatBytes } from "@/lib/file-constants";
import { useUIStore } from "@/stores/ui-store";

interface SearchResult {
  folders: { id: string; name: string; type: string; classroomName: string | null }[];
  files: {
    id: string;
    name: string;
    size: number;
    mimetype: string;
    storageKey: string;
    folderName: string | null;
  }[];
  docs: { id: string; title: string; updatedAt: string; folderName: string | null }[];
}

export function CloudSearchDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const openCloudFolder = useUIStore((s) => s.openCloudFolder);
  const openCloudDoc = useUIStore((s) => s.openCloudDoc);

  // Reset saat dialog dibuka — pola render (bukan efek).
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) {
      setSearch("");
      setQ("");
    }
  }

  useEffect(() => {
    const t = setTimeout(() => setQ(search.trim().toLowerCase()), 300);
    return () => clearTimeout(t);
  }, [search]);

  const { data, isLoading } = useQuery<SearchResult>({
    queryKey: ["cloud-search", q],
    queryFn: async () => {
      const res = await fetch(`/api/cloud/search?q=${encodeURIComponent(q)}`, {
        cache: "no-store",
      });
      if (!res.ok) throw new Error("Gagal mencari");
      return res.json();
    },
    enabled: open && q.length >= 2,
  });

  const total =
    (data?.folders.length ?? 0) + (data?.files.length ?? 0) + (data?.docs.length ?? 0);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Search className="size-5 text-primary" /> Cari di Cloud
          </DialogTitle>
          <DialogDescription>
            Folder, tugas, file, dan dokumen dari semua kelasmu.
          </DialogDescription>
        </DialogHeader>

        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
          <Input
            autoFocus
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Ketik minimal 2 huruf…"
            className="pl-8"
          />
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto rounded-lg border border-border">
          {q.length < 2 ? (
            <p className="p-6 text-center text-sm text-muted-foreground">
              Ketik kata kunci — nama file, folder, tugas, atau dokumen.
            </p>
          ) : isLoading ? (
            <div className="p-3 space-y-2">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : !data || total === 0 ? (
            <p className="p-6 text-center text-sm text-muted-foreground">
              Tidak ada hasil untuk “{q}”.
            </p>
          ) : (
            <div className="divide-y divide-border">
              {data.folders.map((f) => (
                <button
                  key={`f-${f.id}`}
                  type="button"
                  onClick={() => {
                    onOpenChange(false);
                    openCloudFolder(f.id);
                  }}
                  className="flex items-center gap-2.5 w-full px-3 py-2.5 text-left hover:bg-accent/50 transition-colors"
                >
                  <FolderOpen className="size-4.5 shrink-0 text-primary" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium truncate">{f.name}</p>
                    <p className="text-[10px] text-muted-foreground truncate">
                      {f.type === "ASSIGNMENT" ? "Tugas" : "Folder"}
                      {f.classroomName ? ` · ${f.classroomName}` : ""}
                    </p>
                  </div>
                  <Badge variant="secondary" className="text-[9px] shrink-0">
                    folder
                  </Badge>
                </button>
              ))}
              {data.files.map((f) => (
                <button
                  key={`fi-${f.id}`}
                  type="button"
                  onClick={() => {
                    onOpenChange(false);
                    window.open(
                      `/api/storage/${f.storageKey}`,
                      "_blank",
                      "noopener,noreferrer"
                    );
                  }}
                  className="flex items-center gap-2.5 w-full px-3 py-2.5 text-left hover:bg-accent/50 transition-colors"
                >
                  <FileIcon
                    name={mimeToIcon(f.mimetype)}
                    className="size-4.5 shrink-0 text-muted-foreground"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium truncate">{f.name}</p>
                    <p className="text-[10px] text-muted-foreground truncate">
                      {formatBytes(f.size)}
                      {f.folderName ? ` · ${f.folderName}` : ""}
                    </p>
                  </div>
                  <Badge variant="outline" className="text-[9px] shrink-0">
                    file
                  </Badge>
                </button>
              ))}
              {data.docs.map((d) => (
                <button
                  key={`d-${d.id}`}
                  type="button"
                  onClick={() => {
                    onOpenChange(false);
                    openCloudDoc(d.id);
                  }}
                  className="flex items-center gap-2.5 w-full px-3 py-2.5 text-left hover:bg-accent/50 transition-colors"
                >
                  <FileText className="size-4.5 shrink-0 text-emerald-500" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium truncate">{d.title}</p>
                    <p className="text-[10px] text-muted-foreground truncate">
                      Dokumen bersama · diubah{" "}
                      {format(new Date(d.updatedAt), "d MMM HH:mm")}
                    </p>
                  </div>
                  <Badge variant="secondary" className="text-[9px] shrink-0">
                    dokumen
                  </Badge>
                </button>
              ))}
            </div>
          )}
        </div>

        <DialogFooterless />
      </DialogContent>
    </Dialog>
  );
}

// Footer kecil tanpa tombol (kosmetik).
function DialogFooterless() {
  return (
    <p className="text-[10px] text-muted-foreground flex items-center gap-1">
      <Loader2 className="size-3 opacity-0" />
      Klik hasil untuk membuka.
    </p>
  );
}
