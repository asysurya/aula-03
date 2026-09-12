"use client";

// ============================================================================
// useStudyMaterial — SATU sumber materi untuk seluruh Pusat Belajar.
//
// Sebelumnya dua komponen punya kolom materi sendiri-sendiri dengan key
// berbeda (Alat Materi: "aula-study:material", Teman AI: "aula-study:
// buddy-material") sehingga tidak pernah sinkron. Hook ini menyatukannya:
//   - localStorage key bersama "aula-study:material"
//   - migrasi sekali jalan dari key lama StudyBuddy (diambil yang terpanjang)
//   - sinkron lintas komponen dalam tab yang sama via CustomEvent
//   - sinkron lintas tab via event "storage"
// Autosave ke localStorage debounce 500ms (pola lama dipertahankan).
// ============================================================================

import { useCallback, useEffect, useRef, useState } from "react";
import { loadJSON, saveJSON } from "@/lib/study/store";

/** Key localStorage bersama (sama dengan yang dipakai Alat Materi sejak lama). */
export const MATERIAL_SHARED_KEY = "aula-study:material";

/** Key lama milik StudyBuddy sebelum materi disatukan (untuk migrasi). */
const LEGACY_BUDDY_KEY = "aula-study:buddy-material";

/** Nama event sinkron materi (dalam satu tab, lintas komponen). */
export const MATERIAL_EVENT = "aula-study:material-updated";

/** Batas karakter materi yang dikirim sebagai konteks AI (client-side). */
export const MAX_MATERIAL_CONTEXT = 12_000;

/** ID instansi hook unik — dipakai agar event dari diri sendiri diabaikan. */
let hookSeq = 0;

export interface StudyMaterialApi {
  /** Isi materi terkini ("" bila kosong). */
  material: string;
  /** Ganti isi materi — otomatis tersimpan + disiarkan ke komponen lain. */
  setMaterial: (next: string) => void;
  /** true setelah nilai awal selesai dimuat (client-side). */
  loaded: boolean;
}

export function useStudyMaterial(): StudyMaterialApi {
  const [material, setMaterialState] = useState("");
  const [loaded, setLoaded] = useState(false);
  const idRef = useRef(`m${++hookSeq}`);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dispatchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Muat awal + migrasi key lama (sekali) ──
  useEffect(() => {
    const shared = loadJSON<string>(MATERIAL_SHARED_KEY, "");
    const legacy = loadJSON<string>(LEGACY_BUDDY_KEY, "");
    // Ambil yang paling panjang — user kemungkinan besar menulis materi
    // terakhir di salah satu kolom; isi terpanjang = paling berharga.
    let initial = typeof shared === "string" ? shared : "";
    if (typeof legacy === "string" && legacy.length > initial.length) {
      initial = legacy;
      saveJSON(MATERIAL_SHARED_KEY, initial);
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect -- migrasi localStorage client-only sekali jalan; effect dipakai agar SSR/hydration selalu mulai dari "" (aman).
    setMaterialState(initial);
    setLoaded(true);
  }, []);

  // ── Simpan (debounce 500ms) tiap nilai berubah ──
  useEffect(() => {
    if (!loaded) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveJSON(MATERIAL_SHARED_KEY, material);
    }, 500);
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, [material, loaded]);

  // ── Siarkan perubahan ke komponen lain (throttle ~120ms) ──
  const broadcast = useCallback((value: string) => {
    if (dispatchTimerRef.current) return; // sudah ada siaran tertunda
    dispatchTimerRef.current = setTimeout(() => {
      dispatchTimerRef.current = null;
      try {
        window.dispatchEvent(
          new CustomEvent(MATERIAL_EVENT, {
            detail: { source: idRef.current, material: value },
          })
        );
      } catch {
        /* abaikan */
      }
    }, 120);
  }, []);

  const setMaterial = useCallback(
    (next: string) => {
      setMaterialState(next);
      broadcast(next);
    },
    [broadcast]
  );

  // ── Dengarkan perubahan dari komponen/tab lain ──
  useEffect(() => {
    const onEvent = (e: Event) => {
      const detail = (e as CustomEvent<{ source?: string; material?: string }>)
        .detail;
      if (!detail || detail.source === idRef.current) return;
      if (typeof detail.material === "string") {
        setMaterialState(detail.material);
      }
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key !== MATERIAL_SHARED_KEY) return;
      setMaterialState(loadJSON<string>(MATERIAL_SHARED_KEY, ""));
    };
    window.addEventListener(MATERIAL_EVENT, onEvent);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(MATERIAL_EVENT, onEvent);
      window.removeEventListener("storage", onStorage);
      if (dispatchTimerRef.current) {
        clearTimeout(dispatchTimerRef.current);
        dispatchTimerRef.current = null;
      }
    };
  }, []);

  return { material, setMaterial, loaded };
}
