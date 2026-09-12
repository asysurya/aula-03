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
  tool: "hl" | "pen" | "thl";
  color: string;
  /** lebar goresan (norm thd lebar halaman) */
  w?: number;
  /** pen: polyline titik-titik ternormalisasi */
  pts?: [number, number][];
  /** hl: kotak [x, y, w, h] ternormalisasi */
  rect?: [number, number, number, number];
  /** thl: stabilo TEKS — offset karakter [start, end) */
  start?: number;
  end?: number;
  created: number;
}

export const ANNO_COLORS = [
  "#fde047", // kuning stabilo
  "#4ade80", // hijau
  "#60a5fa", // biru
  "#fb7185", // merah muda
  "#a78bfa", // ungu
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
  /** true setelah GET /api/reader/doc selesai (sukses/gagal) — dipakai
   *  fitur “lanjut baca” supaya tidak membaca savedPage=1 yang masih
   *  nilai awal (race: parse lokal instan vs fetch server). */
  const [loaded, setLoaded] = useState(false);
  const pageRef = useRef(1);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** true kalau ada perubahan ANOTASI lokal yang belum tersinkron (server
   * tidak boleh menimpa yang belum tersimpan). Posisi halaman tidak
   * dihitung — penyimpanan halaman ringan & sering. */
  const dirtyRef = useRef(false);
  const keyRef = useRef(storageKey);
  /** PUT penuh (anotasi+halaman) sedang berjalan → antrikan yang baru
   * (dulu: dua PUT bisa selesai di server DENGAN URUTAN TERBALIK →
   * anotasi terbaru tertimpa snapshot lama). */
  const saving = useRef(false);
  const pendingSave = useRef(false);
  /** Ada perubahan anotasi sejak terakhir PUT penuh? */
  const fullPending = useRef(false);

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
        if (!res.ok) {
          if (!cancelled) setLoaded(true);
          return;
        }
        const data = (await res.json()) as {
          annotations?: Annotation[];
          page?: number;
          /** false = belum ada dokumen di server (kalau API lama:
           * undefined → perlakukan seperti ada). */
          exists?: boolean;
        };
        if (cancelled || keyRef.current !== storageKey) return;
        const remote = Array.isArray(data.annotations)
          ? data.annotations
          : [];

        if (dirtyRef.current) {
          // Ada edit lokal yang belum tersimpan → jangan ditimpa; simpan
          // posisi halaman saja.
          if (typeof data.page === "number") setSavedPage(data.page);
          setLoaded(true);
          return;
        }

        const local = load(storageKey);
        // Migrasi HANYA bila dokumen BELUM PERNAH ada di server
        // (exists === false). Dulu: remote kosong + lokal ada → migrasi,
        // sehingga anotasi yang sudah DIHAPUS user di perangkat lain
        // "bangkit" lagi dari cache localStorage perangkat ini.
        if (remote.length === 0 && local.length > 0 && data.exists === false) {
          // MIGRASI: server masih kosong, localStorage punya data lama →
          // angkat ke MongoDB (tetap 1x saja: dirtyRef mencegah dobel).
          setItems(local);
          if (typeof data.page === "number" && data.page > 1) {
            setSavedPage(data.page);
          }
          dirtyRef.current = true;
          scheduleSave(true);
          setLoaded(true);
          return;
        }

        setItems(remote);
        persistLocal(storageKey, remote);
        if (typeof data.page === "number" && data.page > 1) {
          setSavedPage(data.page);
          pageRef.current = data.page;
        }
        setLoaded(true);
      } catch {
        /* offline — cache localStorage tetap dipakai */
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey]);

  // ── Simpan (debounce): localStorage instan + PUT MongoDB ──
  // `full=true` → kirim anotasi + halaman; `full=false` → halaman saja
  // (payload kecil — tiap pindah halaman tidak mengirim ulang semua
  // anotasi). PUT diJALANKAN SATU-SATU (serial) supaya server selalu
  // menerima snapshot terbaru yang terakhir — anti race urutan network.
  const runSave = useCallback(async (full: boolean) => {
    if (saving.current) {
      pendingSave.current = true;
      if (full) fullPending.current = true;
      return;
    }
    saving.current = true;
    const isFull = full || fullPending.current;
    fullPending.current = false;
    let ok = false;
    try {
      const key = keyRef.current;
      const snap = itemsRef.current;
      persistLocal(key, snap);
      const payload: Record<string, unknown> = {
        storageKey: key,
        page: pageRef.current,
      };
      if (isFull) payload.annotations = snap.slice(-2000);
      const res = await fetch("/api/reader/doc", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      ok = res.ok;
    } catch {
      /* offline — tetap dirty, dicoba lagi pada perubahan berikutnya */
    }
    saving.current = false;
    if (ok && !pendingSave.current) {
      // Snapshot yang barusan dikirim masih terbaru → bersih.
      dirtyRef.current = false;
    }
    if (pendingSave.current) {
      pendingSave.current = false;
      void runSave(fullPending.current);
    } else if (!ok && isFull) {
      // Gagal kirim snapshot penuh → coba lagi (paling tidak saat
      // perubahan berikutnya).
      fullPending.current = true;
      dirtyRef.current = true;
    }
  }, []);

  const scheduleSave = useCallback(
    (full: boolean) => {
      if (full) fullPending.current = true;
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        void runSave(fullPending.current);
      }, SAVE_DEBOUNCE_MS);
    },
    // runSave stabil (deps []).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  // ── Flush saat tab ditutup / disembunyikan (anti kehilangan anotasi
  //    yang belum lewat debounce 1,2 dtk) ──
  useEffect(() => {
    const flush = () => {
      const key = keyRef.current;
      const snap = itemsRef.current;
      persistLocal(key, snap);
      const payload: Record<string, unknown> = {
        storageKey: key,
        page: pageRef.current,
      };
      if (fullPending.current || dirtyRef.current) {
        payload.annotations = snap.slice(-2000);
      }
      try {
        // keepalive: permintaan tetap terkirim walau halaman sedang
        // dibongkar.
        void fetch("/api/reader/doc", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          keepalive: true,
        });
      } catch {
        /* abaikan */
      }
    };
    const onHide = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onHide);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onHide);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const itemsRef = useRef(items);
  itemsRef.current = items;

  useEffect(() => {
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, []);

  /** Lapor posisi halaman (dipakai melanjutkan baca terakhir) —
   * simpan ringan (halaman saja, tanpa anotasi). */
  const reportPage = useCallback(
    (n: number) => {
      pageRef.current = n;
      scheduleSave(false);
    },
    [scheduleSave]
  );

  const add = useCallback(
    (a: Annotation) => {
      dirtyRef.current = true;
      setItems((prev) => [...prev, a]);
      scheduleSave(true);
    },
    [scheduleSave]
  );

  const remove = useCallback(
    (id: string) => {
      dirtyRef.current = true;
      setItems((prev) => prev.filter((x) => x.id !== id));
      scheduleSave(true);
    },
    [scheduleSave]
  );

  const undo = useCallback(() => {
    dirtyRef.current = true;
    setItems((prev) => {
      if (prev.length === 0) return prev;
      return prev.slice(0, -1);
    });
    scheduleSave(true);
  }, [scheduleSave]);

  const clearAll = useCallback(() => {
    dirtyRef.current = true;
    setItems([]);
    scheduleSave(true);
  }, [scheduleSave]);

  /** Urungkan anotasi TERAKHIR dari satu jenis alat (mis. thl di
   *  TextReader — undo() global akan menghapus anotasi jenis lain
   *  yang tidak terlihat di konteks itu). */
  const undoTool = useCallback(
    (tool: Annotation["tool"]) => {
      dirtyRef.current = true;
      setItems((prev) => {
        for (let i = prev.length - 1; i >= 0; i--) {
          if (prev[i].tool === tool) return prev.filter((_, j) => j !== i);
        }
        return prev;
      });
      scheduleSave(true);
    },
    [scheduleSave]
  );

  /** Hapus SEMUA anotasi satu jenis alat. */
  const clearTool = useCallback(
    (tool: Annotation["tool"]) => {
      dirtyRef.current = true;
      setItems((prev) => prev.filter((a) => a.tool !== tool));
      scheduleSave(true);
    },
    [scheduleSave]
  );

  const count = items.length;

  return {
    items,
    add,
    remove,
    undo,
    clearAll,
    undoTool,
    clearTool,
    count,
    savedPage,
    loaded,
    reportPage,
  };
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
