"use client";

// ─────────────────────────────────────────────────────────────────────────
// Preview Store — registry GLOBAL semua pratinjau file yang terbuka.
//
// Fitur "picture in picture" untuk pratinjau:
// - Pratinjau dibuka sebagai jendela besar (menggantikan dialog Radix lama).
// - Bisa DISESUATKAN KECIL (minimize) menjadi kartu PiP mengambang — video /
//   audio tetap diputar karena komponen pratinjau TIDAK pernah di-unmount
//   (hanya dipindah-pindah wadah DOM, lihat preview-layer.tsx).
// - Maksimal MAX_OPEN_PREVIEWS pratinjau terbuka bersamaan. Membuka yang
//   ke-4 akan menutup pratinjau TERLAMA (evict) + notifikasi toast.
// - Hanya SATU jendela besar pada satu waktu — membuka/memulihkan pratinjau
//   lain otomatis memperkecil yang sebelumnya menjadi PiP.
//
// Pratinjau bertahan selama berpindah section aplikasi (state global, bukan
// milik komponen host) — video PiP tetap jalan saat pindah Chat ↔ Cloud.
// ─────────────────────────────────────────────────────────────────────────

import { create } from "zustand";
import { toast } from "sonner";
import type { CloudFileItem } from "@/lib/cloud-format";
import { evictReaderFile } from "@/lib/reader-file-cache";

export const MAX_OPEN_PREVIEWS = 3;

/** Kotak posisi & ukuran kartu PiP (px, koordinat viewport). */
export interface PipBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PreviewEntry {
  /** storageKey file — sekaligus kunci dedupe. */
  id: string;
  file: CloudFileItem;
  minimized: boolean;
  openedAt: number;
  /** Posisi/ukuran PiP terakhir — dipertahankan saat minimize/restore. */
  pip: PipBox | null;
}

interface PreviewState {
  entries: PreviewEntry[];
  /** Buka (atau fokuskan bila sudah terbuka) sebuah pratinjau. */
  openPreview: (file: CloudFileItem) => void;
  minimizePreview: (id: string) => void;
  restorePreview: (id: string) => void;
  closePreview: (id: string) => void;
  setPipBox: (id: string, box: PipBox) => void;
  /** Simpan posisi default kartu PiP (dipasang saat pertama minimize). */
  ensurePipBox: (id: string, box: PipBox) => void;
}

function removeEntry(
  entries: PreviewEntry[],
  id: string
): PreviewEntry[] {
  const victim = entries.find((e) => e.id === id);
  if (victim) {
    // Bersihkan buffer Cache Storage pratinjau (anotasi tetap aman di DB).
    void evictReaderFile(victim.file.storageKey);
  }
  return entries.filter((e) => e.id !== id);
}

export const usePreviewStore = create<PreviewState>((set, get) => ({
  entries: [],

  openPreview: (file) => {
    const { entries } = get();
    const existing = entries.find((e) => e.id === file.storageKey);

    // Sudah terbuka → fokuskan: bawa ke paling depan + jadikan jendela besar.
    // Entri LAIN yang sedang besar otomatis dikecilkan (invariant: maks
    // satu jendela besar pada satu waktu).
    if (existing) {
      set({
        entries: [
          ...entries
            .filter((e) => e.id !== file.storageKey)
            .map((e) => (e.minimized ? e : { ...e, minimized: true })),
          {
            ...existing,
            // Metadata file bisa berubah (nama/ukuran/visibility).
            file,
            minimized: false,
          },
        ],
      });
      return;
    }

    let next = [...entries];
    if (next.length >= MAX_OPEN_PREVIEWS) {
      // Penuh — tutup pratinjau TERLAMA (urutan array = urutan dibuka).
      const oldest = next[0];
      toast.info(
        `Pratinjau penuh (maks ${MAX_OPEN_PREVIEWS}) — menutup yang terlama: ${oldest.file.name}`
      );
      next = removeEntry(next, oldest.id);
    }

    next.push({
      id: file.storageKey,
      file,
      minimized: false,
      openedAt: Date.now(),
      pip: null,
    });
    // Jendela besar lain dikecilkan — hanya satu yang tampil besar.
    set({
      entries: next.map((e, i) =>
        i === next.length - 1 ? e : e.minimized ? e : { ...e, minimized: true }
      ),
    });
  },

  minimizePreview: (id) =>
    set((s) => ({
      entries: s.entries.map((e) =>
        e.id === id ? { ...e, minimized: true } : e
      ),
    })),

  restorePreview: (id) =>
    set((s) => ({
      // Hanya satu jendela besar: pratinjau lain dikecilkan jadi PiP.
      entries: s.entries.map((e) =>
        e.id === id
          ? { ...e, minimized: false }
          : e.minimized
            ? e
            : { ...e, minimized: true }
      ),
    })),

  closePreview: (id) => set((s) => ({ entries: removeEntry(s.entries, id) })),

  setPipBox: (id, box) =>
    set((s) => ({
      entries: s.entries.map((e) => (e.id === id ? { ...e, pip: box } : e)),
    })),

  ensurePipBox: (id, box) =>
    set((s) => ({
      entries: s.entries.map((e) =>
        e.id === id && !e.pip ? { ...e, pip: box } : e
      ),
    })),
}));
