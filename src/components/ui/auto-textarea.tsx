"use client";

// ─────────────────────────────────────────────────────────────────────────
// AutoTextarea — textarea yang ikut memanjang mengikuti isinya sampai
// batas maxHeight, lalu men-scroll di dalamnya (tidak pernah mendorong
// layout halaman).
//
// Dipakai untuk semua kolom yang menampung teks banyak: kolom materi
// Pusat Belajar, input chat, jawaban essay form, edit pesan, dsb.
// Auto-resize dipicu saat: value berubah, konten ditempel, dan window
// resize (lebar berubah → tinggi konten berubah).
// ─────────────────────────────────────────────────────────────────────────

import * as React from "react";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

export function AutoTextarea({
  className,
  value,
  maxHeight = 160,
  ...props
}: React.ComponentProps<typeof Textarea> & {
  /** Tinggi maksimum dalam px sebelum scrollbar internal muncul. */
  maxHeight?: number;
}) {
  const ref = React.useRef<HTMLTextAreaElement>(null);

  const fit = React.useCallback(() => {
    const el = ref.current;
    if (!el) return;
    // "auto" dulu agar scrollHeight terukur dari konten, bukan tinggi lama.
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
    // Saat mencapai batas, pastikan overflow-y aktif agar bisa di-scroll.
    el.style.overflowY = el.scrollHeight > maxHeight ? "auto" : "hidden";
  }, [maxHeight]);

  React.useEffect(() => {
    fit();
  }, [value, fit]);

  React.useEffect(() => {
    const onResize = () => fit();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [fit]);

  return (
    <Textarea
      ref={ref}
      className={cn("min-h-9 resize-none overflow-hidden", className)}
      value={value}
      {...props}
    />
  );
}
