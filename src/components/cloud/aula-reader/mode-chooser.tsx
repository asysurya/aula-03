"use client";

import { BookOpenText, MonitorDown, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

// ─────────────────────────────────────────────────────────────────────────
// Pemilih mode pratinjau — muncul saat file dibuka (2 opsi):
//   1. AULA READER  → pembaca custom: stabilo, pena, TTS, zoom, mode malam,
//                     EPUB, CorelDraw→gambar… — dirancang cepat & ringan
//                     untuk SEMUA device termasuk Smart TV.
//   2. PRATINJAU BAWAAN → render langsung browser (iframe/img/video/office),
//                     persis seperti sebelumnya.
// Preferensi tersimpan per perangkat; bisa diganti kapan lewat tombol di
// header pratinjau.
// ─────────────────────────────────────────────────────────────────────────

export type PreviewMode = "ask" | "aula" | "native";

const PREF_KEY = "aula.previewPref";

export function loadPreviewPref(): PreviewMode {
  try {
    const v = localStorage.getItem(PREF_KEY);
    return v === "aula" || v === "native" ? v : "ask";
  } catch {
    return "ask";
  }
}

export function savePreviewPref(m: PreviewMode) {
  try {
    localStorage.setItem(PREF_KEY, m);
  } catch {
    /* abaikan */
  }
}

export function ModeChooser({
  onPick,
}: {
  onPick: (m: "aula" | "native", always: boolean) => void;
}) {
  return (
    <div className="h-full flex flex-col items-center justify-center gap-5 p-6 bg-muted/20 overflow-auto">
      <div className="text-center max-w-md">
        <h3 className="text-base font-semibold">Buka pratinjau dengan…</h3>
        <p className="text-xs text-muted-foreground mt-1">
          Pilih cara membuka file — keduanya mendukung semua perangkat
          (HP, tablet, laptop, Smart TV).
        </p>
      </div>

      <div className="grid gap-4 w-full max-w-2xl sm:grid-cols-2">
        {/* Aula Reader */}
        <div className="flex flex-col rounded-xl border border-primary/40 bg-primary/5 overflow-hidden">
          <button
            type="button"
            autoFocus
            className="flex flex-col items-center gap-3 px-6 py-8 focus-visible:ring-4 focus-visible:ring-ring outline-none min-h-40"
            onClick={() => onPick("aula", false)}
          >
            <div className="size-12 rounded-xl bg-primary text-primary-foreground flex items-center justify-center">
              <BookOpenText className="size-6" />
            </div>
            <div className="text-center">
              <p className="font-semibold">Aula Reader</p>
              <p className="text-xs text-muted-foreground mt-1">
                Stabilo &amp; pena, baca-nyaring (TTS), mode malam, zoom,
                cari teks, buku EPUB, CorelDRAW jadi gambar — cepat &amp;
                lancar di semua perangkat.
              </p>
            </div>
          </button>
          <button
            type="button"
            className="flex items-center justify-center gap-1 border-t border-primary/30 bg-primary/10 py-2 text-xs text-primary hover:bg-primary/15 focus-visible:ring-2 focus-visible:ring-ring outline-none"
            onClick={() => onPick("aula", true)}
          >
            Selalu pakai Aula Reader <ChevronRight className="size-3.5" />
          </button>
        </div>

        {/* Pratinjau bawaan */}
        <div className="flex flex-col rounded-xl border border-border bg-background overflow-hidden">
          <button
            type="button"
            className="flex flex-col items-center gap-3 px-6 py-8 focus-visible:ring-4 focus-visible:ring-ring outline-none min-h-40"
            onClick={() => onPick("native", false)}
          >
            <div className="size-12 rounded-xl bg-secondary text-secondary-foreground flex items-center justify-center">
              <MonitorDown className="size-6" />
            </div>
            <div className="text-center">
              <p className="font-semibold">Pratinjau Bawaan</p>
              <p className="text-xs text-muted-foreground mt-1">
                Ditampilkan langsung oleh browser (PDF bawaan, gambar,
                video, dokumen office hasil konversi) — seperti sebelumnya.
              </p>
            </div>
          </button>
          <button
            type="button"
            className="flex items-center justify-center gap-1 border-t border-border bg-muted/50 py-2 text-xs text-muted-foreground hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring outline-none"
            onClick={() => onPick("native", true)}
          >
            Selalu pakai pratinjau bawaan <ChevronRight className="size-3.5" />
          </button>
        </div>
      </div>

      <p className="text-[11px] text-muted-foreground text-center max-w-md">
        Pilihan bisa diganti kapan saja lewat tombol{" "}
        <span className="font-medium">Mode</span> di header pratinjau.
      </p>
    </div>
  );
}
