"use client";

// Store favorit (bintang) file/folder cloud — state reaktif sederhana
// (zustand) supaya tombol bintang di baris file & dialog Favorit selalu
// sinkron. Data dari /api/cloud/favorites.

import { create } from "zustand";

interface FavoritesState {
  fileIds: Set<string>;
  folderIds: Set<string>;
  loaded: boolean;
  loading: boolean;
  load: () => Promise<void>;
  toggleFile: (fileId: string) => Promise<void>;
  toggleFolder: (folderId: string) => Promise<void>;
}

export const useFavoritesStore = create<FavoritesState>((set, get) => ({
  fileIds: new Set<string>(),
  folderIds: new Set<string>(),
  loaded: false,
  loading: false,

  load: async () => {
    if (get().loading) return;
    set({ loading: true });
    try {
      const res = await fetch("/api/cloud/favorites", { cache: "no-store" });
      if (!res.ok) throw new Error("gagal");
      const data = (await res.json()) as {
        favorites: { kind: "file" | "folder"; id: string }[];
      };
      set({
        fileIds: new Set(
          data.favorites.filter((f) => f.kind === "file").map((f) => f.id)
        ),
        folderIds: new Set(
          data.favorites.filter((f) => f.kind === "folder").map((f) => f.id)
        ),
        loaded: true,
      });
    } catch {
      /* biarkan loaded false — coba lagi nanti */
    } finally {
      set({ loading: false });
    }
  },

  toggleFile: async (fileId: string) => {
    const has = get().fileIds.has(fileId);
    // Optimistic.
    const next = new Set(get().fileIds);
    if (has) next.delete(fileId);
    else next.add(fileId);
    set({ fileIds: next });
    try {
      await fetch("/api/cloud/favorites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileId }),
      });
    } catch {
      // Revert.
      const revert = new Set(get().fileIds);
      if (has) revert.add(fileId);
      else revert.delete(fileId);
      set({ fileIds: revert });
    }
  },

  toggleFolder: async (folderId: string) => {
    const has = get().folderIds.has(folderId);
    const next = new Set(get().folderIds);
    if (has) next.delete(folderId);
    else next.add(folderId);
    set({ folderIds: next });
    try {
      await fetch("/api/cloud/favorites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ folderId }),
      });
    } catch {
      const revert = new Set(get().folderIds);
      if (has) revert.add(folderId);
      else revert.delete(folderId);
      set({ folderIds: revert });
    }
  },
}));
