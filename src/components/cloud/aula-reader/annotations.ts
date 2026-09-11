"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// ─────────────────────────────────────────────────────────────────────────
// Anotasi Aula Reader — stabilo & gambar pena.
// Koordinat ternormalisasi 0..1 terhadap dimensi halaman/kanvas, jadi
// anotasi tetap presisi saat zoom / ukuran layar berubah (HP ↔ TV).
//
// PENYIMPANAN: MongoDB (per user per file — ikut user di semua perangkat)
// via /api/reader/doc. localStorage dipakai hanya sebagai cache offline
// (instan saat dibuka, jalan tanpa jaringan) + jalur migrasi data lama
// (dulu anotasi hanya tersimpan di localStorage per perangkat).
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
const SAVE_DEBOUNCE_MS = 1200;

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

function persistLocal(storageKey: string, items: Annotation[]) {
  try {
    localStorage.setItem(PREFIX + storageKey, JSON.stringify(items.slice(-2000)));
  } catch {
    /* penuh — abaikan */
  }
}

export function useAnnotations(storageKey: string) {
  const [items, setItems] = useState<Annotation[]>(() => load(storageKey));
  const [savedPage, setSavedPage] = useState(1);
  const pageRef = useRef(1);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** true kalau ada perubahan lokal yang belum tersinkron (server tidak
   * boleh menimpa yang belum tersimpan). */
  const dirtyRef = useRef(false);
  const keyRef = useRef(storageKey);

  // Ganti file → muat ulang (di effect, bukan saat render).
  useEffect(() => {
    keyRef.current = storageKey;
    dirtyRef.current = false;
    setItems(load(storageKey));
    setSavedPage(1);
    pageRef.current = 1;
  }, [storageKey]);

  // ── Muat dari server (MongoDB) + migrasi localStorage lama ──
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/reader/doc?storageKey=${encodeURIComponent(storageKey)}`,
          { cache: "no-store" }
        );
        if (!res.ok) return;
        const data = (await res.json()) as {
          annotations?: Annotation[];
          page?: number;
        };
        if (cancelled || keyRef.current !== storageKey) return;
        const remote = Array.isArray(data.annotations)
          ? data.annotations
          : [];

        if (dirtyRef.current) {
          // Ada edit lokal yang belum tersimpan → jangan ditimpa; simpan
          // posisi halaman saja.
          if (typeof data.page === "number") setSavedPage(data.page);
          return;
        }

        const local = load(storageKey);
        if (remote.length === 0 && local.length > 0) {
          // MIGRASI: server masih kosong, localStorage punya data lama →
          // angkat ke MongoDB (tetap 1x saja: dirtyRef mencegah dobel).
          setItems(local);
          if (typeof data.page === "number" && data.page > 1) {
            setSavedPage(data.page);
          }
          dirtyRef.current = true;
          scheduleSave();
          return;
        }

        setItems(remote);
        persistLocal(storageKey, remote);
        if (typeof data.page === "number" && data.page > 1) {
          setSavedPage(data.page);
          pageRef.current = data.page;
        }
      } catch {
        /* offline — cache localStorage tetap dipakai */
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey]);

  // ── Simpan (debounce): localStorage instan + PUT MongoDB ──
  const scheduleSave = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      const key = keyRef.current;
      const current = itemsRef.current;
      persistLocal(key, current);
      try {
        await fetch("/api/reader/doc", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            storageKey: key,
            annotations: current.slice(-2000),
            page: pageRef.current,
          }),
        });
        if (keyRef.current === key && current === itemsRef.current) {
          dirtyRef.current = false;
        }
      } catch {
        /* tetap dirty — dicoba lagi pada perubahan berikutnya */
      }
    }, SAVE_DEBOUNCE_MS);
  }, []);

  const itemsRef = useRef(items);
  itemsRef.current = items;

  useEffect(() => {
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, []);

  /** Lapor posisi halaman (dipakai melanjutkan baca terakhir). */
  const reportPage = useCallback(
    (n: number) => {
      pageRef.current = n;
      dirtyRef.current = true;
      scheduleSave();
    },
    [scheduleSave]
  );

  const add = useCallback(
    (a: Annotation) => {
      dirtyRef.current = true;
      setItems((prev) => [...prev, a]);
      scheduleSave();
    },
    [scheduleSave]
  );

  const remove = useCallback(
    (id: string) => {
      dirtyRef.current = true;
      setItems((prev) => prev.filter((x) => x.id !== id));
      scheduleSave();
    },
    [scheduleSave]
  );

  const undo = useCallback(() => {
    dirtyRef.current = true;
    setItems((prev) => {
      if (prev.length === 0) return prev;
      return prev.slice(0, -1);
    });
    scheduleSave();
  }, [scheduleSave]);

  const clearAll = useCallback(() => {
    dirtyRef.current = true;
    setItems([]);
    scheduleSave();
  }, [scheduleSave]);

  const count = items.length;

  return { items, add, remove, undo, clearAll, count, savedPage, reportPage };
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
