"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// ─────────────────────────────────────────────────────────────────────────
// Anotasi Aula Reader — stabilo & gambar pena.
// Koordinat ternormalisasi 0..1 terhadap dimensi halaman/kanvas, jadi
// anotasi tetap presisi saat zoom / ukuran layar berubah (HP ↔ TV).
// Disimpan per file (storageKey) di localStorage perangkat ini.
// ─────────────────────────────────────────────────────────────────────────

export type AnnoTool = "none" | "hl" | "pen" | "erase";

export interface Annotation {
  id: string;
  /** 1-based; untuk media tanpa halaman selalu 1 */
  page: number;
  tool: "hl" | "pen";
  color: string;
  /** lebar goresan (norm thd lebar halaman) */
  w?: number;
  /** pen: polyline titik-titik ternormalisasi */
  pts?: [number, number][];
  /** hl: kotak [x, y, w, h] ternormalisasi */
  rect?: [number, number, number, number];
  created: number;
}

export const ANNO_COLORS = [
  "#fde047", // kuning stabilo
  "#86efac", // hijau
  "#93c5fd", // biru
  "#fda4af", // merah muda
  "#c4b5fd", // ungu
];

const PREFIX = "aula.anno.v1:";

function load(storageKey: string): Annotation[] {
  try {
    const raw = localStorage.getItem(PREFIX + storageKey);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed as Annotation[];
    return [];
  } catch {
    return [];
  }
}

export function useAnnotations(storageKey: string) {
  const [items, setItems] = useState<Annotation[]>(() => load(storageKey));
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Ganti file → muat ulang (di effect, bukan saat render).
  useEffect(() => {
    setItems(load(storageKey));
  }, [storageKey]);

  useEffect(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      try {
        localStorage.setItem(
          PREFIX + storageKey,
          JSON.stringify(items.slice(-2000))
        );
      } catch {
        /* penuh — abaikan */
      }
    }, 400);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [storageKey, items]);

  const add = useCallback((a: Annotation) => {
    setItems((prev) => [...prev, a]);
  }, []);

  const remove = useCallback((id: string) => {
    setItems((prev) => prev.filter((x) => x.id !== id));
  }, []);

  const undo = useCallback(() => {
    setItems((prev) => {
      if (prev.length === 0) return prev;
      return prev.slice(0, -1);
    });
  }, []);

  const clearAll = useCallback(() => {
    setItems([]);
  }, []);

  const count = items.length;

  return { items, add, remove, undo, clearAll, count };
}

export function newId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** Anotasi milik satu halaman. */
export function usePageAnnotations(items: Annotation[], page: number) {
  return useMemo(
    () => items.filter((a) => a.page === page),
    [items, page]
  );
}
