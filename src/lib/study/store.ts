"use client";

// ============================================================================
// Store bersama Pusat Belajar — semua data disimpan di localStorage (client).
// Semua key diawali prefix "aula-study:".
// Dipakai lintas komponen study (study-hub, pomodoro, statistik, dll).
// ============================================================================

import { useEffect, useState } from "react";
import type { Dispatch, SetStateAction } from "react";

/** Prefix wajib untuk semua key localStorage milik Pusat Belajar. */
export const STUDY_PREFIX = "aula-study:";

/** Key penyimpanan daftar sesi belajar. */
const SESSIONS_KEY = `${STUDY_PREFIX}sessions`;

/** Satu sesi belajar tercatat (pomodoro, mode fokus, atau manual). */
export interface StudySession {
  id: string;
  startedAt: string;
  minutes: number;
  kind: "pomodoro" | "focus" | "manual";
  note?: string;
}

/** Membaca JSON dari localStorage dengan aman (gagal -> fallback). */
export function loadJSON<T>(key: string, fallback: T): T {
  try {
    if (typeof window === "undefined") return fallback;
    const raw = window.localStorage.getItem(key);
    if (raw == null) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** Menyimpan JSON ke localStorage dengan aman (gagal -> diam). */
export function saveJSON(key: string, value: unknown): void {
  try {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Kuota penuh / mode privat — abaikan agar aplikasi tidak crash.
  }
}

/**
 * Hook state React yang otomatis dipersist ke localStorage.
 * Setiap perubahan nilai disimpan lewat saveJSON (efek berjalan tiap perubahan).
 */
export function useLocalJSON<T>(
  key: string,
  initial: T
): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => loadJSON(key, initial));

  useEffect(() => {
    saveJSON(key, value);
  }, [key, value]);

  return [value, setValue];
}

/** ID unik: crypto.randomUUID bila tersedia, jika tidak fallback Math.random. */
function generateId(): string {
  try {
    if (
      typeof crypto !== "undefined" &&
      typeof crypto.randomUUID === "function"
    ) {
      return crypto.randomUUID();
    }
  } catch {
    // lanjut ke fallback
  }
  return `s-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Notifikasi ringan agar komponen lain di TAB YANG SAMA ikut me-refresh
 * (event "storage" hanya terpicu antar-tab, bukan di tab pengubah).
 */
function notifyUpdate(): void {
  try {
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("aula-study:updated"));
    }
  } catch {
    // abaikan
  }
}

/**
 * Mencatat satu sesi belajar ke "aula-study:sessions" lalu mengembalikannya.
 * id & startedAt opsional — diisi otomatis bila tidak diberikan.
 */
export function logStudySession(
  s: Omit<StudySession, "id" | "startedAt"> &
    Partial<Pick<StudySession, "id" | "startedAt">>
): StudySession {
  const session: StudySession = {
    id: s.id ?? generateId(),
    startedAt: s.startedAt ?? new Date().toISOString(),
    minutes: s.minutes,
    kind: s.kind,
    note: s.note,
  };
  const all = getStudySessions();
  all.push(session);
  saveJSON(SESSIONS_KEY, all);
  notifyUpdate();
  return session;
}

/** Seluruh sesi belajar tersimpan (array kosong bila belum ada). */
export function getStudySessions(): StudySession[] {
  try {
    const raw = loadJSON<StudySession[]>(SESSIONS_KEY, []);
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

/** Menghapus seluruh riwayat sesi belajar. */
export function clearStudySessions(): void {
  try {
    if (typeof window === "undefined") return;
    window.localStorage.removeItem(SESSIONS_KEY);
  } catch {
    // abaikan
  }
  notifyUpdate();
}

/** Kunci tanggal lokal berformat "YYYY-MM-DD" (tanpa timezone drift). */
function dayKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Streak: jumlah hari BERTURUT-TURUT yang punya total sesi >= 1 menit.
 * Hari ini dihitung bila sudah ada sesi; bila belum, streak dari kemarin
 * tetap dipertahankan (grace) sehingga badge tidak "hilang" di pagi hari.
 */
export function computeStreak(): number {
  const perDay = new Map<string, number>();
  for (const s of getStudySessions()) {
    const k = dayKey(new Date(s.startedAt));
    perDay.set(k, (perDay.get(k) ?? 0) + s.minutes);
  }
  const activeDay = (k: string) => (perDay.get(k) ?? 0) >= 1;

  let streak = 0;
  const cursor = new Date();
  // Bila hari ini belum ada sesi, mulai perhitungan dari kemarin (grace 1 hari).
  if (!activeDay(dayKey(cursor))) {
    cursor.setDate(cursor.getDate() - 1);
  }
  while (activeDay(dayKey(cursor))) {
    streak += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

/** Total menit belajar hari ini (semua jenis sesi). */
export function todayStudyMinutes(): number {
  const today = dayKey(new Date());
  return getStudySessions()
    .filter((s) => dayKey(new Date(s.startedAt)) === today)
    .reduce((sum, s) => sum + s.minutes, 0);
}
