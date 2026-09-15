"use client";

// ─────────────────────────────────────────────────────────────────────────
// Reader UI Store — state chrome pratinjau yang dipakai lintas komponen.
//
// "Mode fokus" Aula Reader: saat aktif, header jendela pratinjau & toolbar
// PDF menjadi melayang (transparan, auto-hide) sehingga area halaman
// maksimal. State harus hidup di luar komponen karena:
// - PdfReader (toggle) dan PreviewWindow (render header ramping) berbeda
//   subtree di tree React.
// - Di-key per entry pratinjau (id = storageKey) supaya jendela lain
//   (PiP / pratinjau kedua) tidak ikut terpengaruh.
// ─────────────────────────────────────────────────────────────────────────

import { create } from "zustand";

interface ReaderUiState {
  /** entryId (storageKey) → sedang mode fokus? */
  focusByEntry: Record<string, boolean>;
  setFocus: (entryId: string, v: boolean) => void;
}

export const useReaderUiStore = create<ReaderUiState>((set) => ({
  focusByEntry: {},

  setFocus: (entryId, v) =>
    set((s) => {
      if (!!s.focusByEntry[entryId] === v) return s;
      const next = { ...s.focusByEntry };
      if (v) next[entryId] = true;
      else delete next[entryId];
      return { focusByEntry: next };
    }),
}));
