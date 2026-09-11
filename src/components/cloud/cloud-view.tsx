"use client";

import { useEffect, useState } from "react";
import { Cloud, FolderClosed, RefreshCw, Search, Star } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { FileBrowser } from "@/components/cloud/file-browser";
import { DocEditor } from "@/components/cloud/doc-editor";
import { CloudSearchDialog } from "@/components/cloud/cloud-search";
import { FavoritesDialog } from "@/components/cloud/favorites-dialog";
import { useUIStore } from "@/stores/ui-store";
import { useFavoritesStore } from "@/stores/favorites-store";
import type { MeResponse } from "@/hooks/use-me";

export function CloudView({ me }: { me: MeResponse }) {
  const cloudFolderId = useUIStore((s) => s.cloudFolderId);
  const cloudClassroomId = useUIStore((s) => s.cloudClassroomId);
  const cloudDocId = useUIStore((s) => s.cloudDocId);
  const openCloudFolder = useUIStore((s) => s.openCloudFolder);
  const [searchOpen, setSearchOpen] = useState(false);
  const [favoritesOpen, setFavoritesOpen] = useState(false);
  const loadFavorites = useFavoritesStore((s) => s.load);

  const classrooms = me.classrooms ?? [];
  const selectedClassroom = classrooms.find((c) => c.id === cloudClassroomId);
  const classroomId = selectedClassroom?.id ?? classrooms[0]?.id ?? null;

  // Auto-pick first classroom on first mount if none selected.
  useEffect(() => {
    if (!cloudClassroomId && classrooms.length > 0) {
      openCloudFolder(null, classrooms[0].id);
    }
  }, [cloudClassroomId, classrooms, openCloudFolder]);

  // Muat daftar favorit sekali (untuk ikon bintang di baris file).
  useEffect(() => {
    void loadFavorites();
  }, [loadFavorites]);

  if (classrooms.length === 0) {
    return (
      <div className="h-full flex flex-col">
        <Header classroomName={null} />
        <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
          <div className="text-center max-w-sm">
            <FolderClosed className="size-10 mx-auto mb-3 opacity-40" />
            <p>Kamu belum tergabung di kelas mana pun.</p>
            <p className="text-xs mt-1">
              Minta admin menambahkan kamu ke sebuah kelas untuk mulai menggunakan Cloud.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      <Header
        classroomName={selectedClassroom?.name ?? classrooms[0]?.name ?? null}
        classrooms={classrooms}
        classroomId={classroomId}
        onClassroomChange={(id) => openCloudFolder(null, id)}
        onSearchClick={() => setSearchOpen(true)}
        onFavoritesClick={() => setFavoritesOpen(true)}
      />
      <div className="flex-1 min-h-0 overflow-hidden">
        {cloudDocId ? (
          <DocEditor docId={cloudDocId} />
        ) : (
          <FileBrowser
            classroomId={classroomId!}
            folderId={cloudFolderId}
            me={me}
          />
        )}
      </div>

      <CloudSearchDialog open={searchOpen} onOpenChange={setSearchOpen} />
      <FavoritesDialog open={favoritesOpen} onOpenChange={setFavoritesOpen} />
    </div>
  );
}

function Header({
  classroomName,
  classrooms,
  classroomId,
  onClassroomChange,
  onSearchClick,
  onFavoritesClick,
}: {
  classroomName: string | null;
  classrooms?: MeResponse["classrooms"];
  classroomId?: string | null;
  onClassroomChange?: (id: string) => void;
  onSearchClick?: () => void;
  onFavoritesClick?: () => void;
}) {
  const qc = useQueryClient();
  const [reloading, setReloading] = useState(false);
  const handleReload = () => {
    setReloading(true);
    // Prefix ["cloud"] mencakup semua query cloud (["cloud","folder",…],
    // ["cloud","assignment",…] dll — dulu: key yang tak pernah cocok →
    // daftar tak pernah benar-benar dimuat ulang).
    qc.invalidateQueries({ queryKey: ["cloud"] });
    qc.invalidateQueries({ queryKey: ["admin-cloud-accounts"] });
    // Stop spin after 1.2s
    setTimeout(() => setReloading(false), 1200);
  };
  return (
    <div className="border-b border-border px-4 py-3 flex items-center gap-3 flex-wrap">
      <div className="flex items-center gap-2 min-w-0">
        <div className="rounded-md bg-primary/10 p-1.5 text-primary">
          <Cloud className="size-4" />
        </div>
        <div className="min-w-0">
          <h2 className="font-semibold leading-tight truncate">Cloud &amp; Tugas</h2>
          <p className="text-xs text-muted-foreground truncate">
            {classroomName ?? "Pilih kelas"}
          </p>
        </div>
      </div>
      <div className="ml-auto flex items-center gap-2">
        <Button
          size="sm"
          variant="ghost"
          onClick={onSearchClick}
          className="gap-1.5"
          title="Cari di semua cloud (folder, tugas, file, dokumen)"
        >
          <Search className="h-4 w-4" />
          <span className="hidden sm:inline">Cari</span>
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={onFavoritesClick}
          className="gap-1.5"
          title="Favorit saya (file yang ditandai bintang)"
        >
          <Star className="h-4 w-4" />
          <span className="hidden sm:inline">Favorit</span>
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={handleReload}
          className="gap-1.5"
          title="Muat ulang daftar file & folder"
        >
          <RefreshCw className={`h-4 w-4 ${reloading ? "animate-spin" : ""}`} />
          <span className="hidden sm:inline">Muat Ulang</span>
        </Button>
        {classrooms && classrooms.length > 0 && onClassroomChange ? (
          <Select
            value={classroomId ?? undefined}
            onValueChange={(v) => onClassroomChange(v)}
          >
            <SelectTrigger size="sm" className="w-[200px]">
              <SelectValue placeholder="Pilih kelas" />
            </SelectTrigger>
            <SelectContent>
              {classrooms.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
      </div>
    </div>
  );
}
