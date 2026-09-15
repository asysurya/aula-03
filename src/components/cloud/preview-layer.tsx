"use client";

// ─────────────────────────────────────────────────────────────────────────
// Preview Layer — jendela pratinjau global + kartu "Picture in Picture".
//
// Menggantikan dialog Radix lama untuk pratinjau file:
// - <PreviewLayer/> dipasang SEKALI di AppShell → pratinjau bertahan saat
//   berpindah section (Chat ↔ Cloud ↔ Pusat Belajar).
// - Jendela besar: overlay + frame terpusat (mirip dialog, ESC tutup,
//   klik overlay tutup, focus trap ringan).
// - Minimize → kartu PiP mengambang: bisa DIGESER (drag di judul) dan
//   DIUBAH UKURANNYA (pegangan sudut kanan-bawah), tombol perbesar/tutup,
//   klik-ganda judul = perbesar.
// - Konten pratinjau (video/audio/gambar/pdf/reader) TIDAK PERNAH
//   di-unmount saat minimize/restore — div konten berada di posisi tree
//   React yang selalu sama, hanya chrome jendela yang berganti → video
//   tetap diputar tanpa putus. Ini inti perilaku "picture in picture".
// - Maksimal 3 pratinjau terbuka bersamaan (lihat preview-store.ts).
// ─────────────────────────────────────────────────────────────────────────

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";
import { File as FileIcon, Maximize2, X, Focus, PictureInPicture2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  usePreviewStore,
  type PipBox,
  type PreviewEntry,
} from "@/stores/preview-store";
import { useReaderUiStore } from "@/stores/reader-ui-store";
import { hasReaderCacheEntry } from "@/lib/reader-file-cache";
import { PreviewHeader, PreviewBody } from "@/components/cloud/file-preview";
import { AulaReader } from "@/components/cloud/aula-reader/aula-reader";
import {
  ModeChooser,
  loadPreviewPref,
  savePreviewPref,
  type PreviewMode,
} from "@/components/cloud/aula-reader/mode-chooser";
import { toast } from "sonner";
import type { CloudFileItem } from "@/lib/cloud-format";

// ───────────────────────── Layer (dipasang di AppShell) ─────────────────────────

export function PreviewLayer() {
  const entries = usePreviewStore((s) => s.entries);
  const [mounted, setMounted] = useState(false);
  // Portal ke document.body hanya bisa dilakukan setelah mount (client-only);
  // ini memang kasus yang diizinkan: sinkronisasi ke sistem eksternal (DOM).
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => setMounted(true), []);

  // Kunci scroll body saat ada jendela besar (menggantikan scroll-lock
  // yang dulu ditangani Radix Dialog).
  const anyMaximized = entries.some((e) => !e.minimized);
  useEffect(() => {
    if (!anyMaximized) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [anyMaximized]);

  if (!mounted) return null;
  return createPortal(
    <>
      {entries.map((entry) => (
        <PreviewWindow key={entry.id} entry={entry} />
      ))}
    </>,
    document.body
  );
}

// ───────────────────────── Satu jendela pratinjau ─────────────────────────

const FALLBACK_BOX: PipBox = { x: 16, y: 16, w: 340, h: 214 };
const MIN_PIP_W = 240;
const MIN_PIP_H = 150;

function clampBox(box: PipBox): PipBox {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const maxW = Math.max(MIN_PIP_W, vw - 16);
  const maxH = Math.max(MIN_PIP_H, vh - 16);
  const w = Math.min(Math.max(box.w, MIN_PIP_W), maxW);
  const h = Math.min(Math.max(box.h, MIN_PIP_H), maxH);
  return {
    w,
    h,
    x: Math.min(Math.max(box.x, 0), Math.max(0, vw - w)),
    y: Math.min(Math.max(box.y, 0), Math.max(0, vh - h)),
  };
}

function PreviewWindow({ entry }: { entry: PreviewEntry }) {
  const minimizePreview = usePreviewStore((s) => s.minimizePreview);
  const restorePreview = usePreviewStore((s) => s.restorePreview);
  const closePreview = usePreviewStore((s) => s.closePreview);
  const ensurePipBox = usePreviewStore((s) => s.ensurePipBox);
  const setPipBox = usePreviewStore((s) => s.setPipBox);

  // Mode fokus Aula Reader (diputuskan oleh PdfReader di dalam konten).
  const readerFocus = useReaderUiStore((s) => !!s.focusByEntry[entry.id]);
  const setReaderFocus = useReaderUiStore((s) => s.setFocus);

  const file = entry.file;
  const minimized = entry.minimized;

  // ── Mesin mode pratinjau (ask/aula/native) — hidup di komponen ini
  //    sehingga tidak pernah reset saat minimize/restore/perpindahan host.
  const [mode, setMode] = useState<PreviewMode>(() => loadPreviewPref());
  const [fileKey, setFileKey] = useState(file.storageKey);
  if (file.storageKey !== fileKey) {
    setFileKey(file.storageKey);
    setMode(loadPreviewPref());
  }
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    const onFsChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFsChange);
    return () =>
      document.removeEventListener("fullscreenchange", onFsChange);
  }, []);

  function pickMode(m: "aula" | "native", always: boolean) {
    setMode(m);
    if (always) {
      savePreviewPref(m);
      toast.info(
        m === "aula"
          ? "Selanjutnya file otomatis dibuka dengan Aula Reader."
          : "Selanjutnya file otomatis dibuka dengan pratinjau bawaan."
      );
    }
  }

  const contentRef = useRef<HTMLDivElement>(null);

  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else if (contentRef.current) {
        await contentRef.current.requestFullscreen();
      }
    } catch {
      toast.error("Browser menolak mode layar penuh");
    }
  }

  const close = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen();
    closePreview(entry.id);
  }, [closePreview, entry.id]);

  // ── Tutup dengan pilihan cache: SIMPAN atau HAPUS file dari perangkat ──
  // Pref "aula.reader.closepref": "ask" (default) | "keep" | "delete".
  const CLOSE_PREF = "aula.reader.closepref";
  const [closeAskOpen, setCloseAskOpen] = useState(false);
  const [rememberChoice, setRememberChoice] = useState(false);

  function readClosePref(): "ask" | "keep" | "delete" {
    try {
      const v = localStorage.getItem(CLOSE_PREF);
      return v === "keep" || v === "delete" ? v : "ask";
    } catch {
      return "ask";
    }
  }

  async function requestClose() {
    const pref = readClosePref();
    if (pref !== "ask") {
      applyClose(pref);
      return;
    }
    // Hanya tanya bila file memang tersimpan di cache reader (PDF/EPUB/
    // dokumen office). Gambar/video/audio tidak di-cache → tutup langsung.
    let cached = false;
    try {
      cached = await hasReaderCacheEntry(file.storageKey);
    } catch {
      cached = false;
    }
    if (!cached) {
      applyClose("delete");
      return;
    }
    setRememberChoice(false);
    setCloseAskOpen(true);
  }

  function applyClose(kind: "keep" | "delete") {
    if (rememberChoice) {
      try {
        localStorage.setItem(CLOSE_PREF, kind);
      } catch {
        /* abaikan */
      }
      toast.info(
        kind === "keep"
          ? "Selanjutnya file yang ditutup otomatis disimpan di perangkat."
          : "Selanjutnya cache file otomatis dihapus saat ditutup."
      );
    }
    setCloseAskOpen(false);
    if (kind === "keep") {
      if (document.fullscreenElement) void document.exitFullscreen();
      closePreview(entry.id, { keepCache: true });
    } else {
      close();
    }
  }

  // ESC menutup jendela besar (perilaku sama seperti dialog dulu).
  // Saat fullscreen browser, ESC dipakai browser untuk keluar fullscreen.
  // MODE FOKUS: Esc pertama keluar dari fokus, bukan menutup jendela.
  useEffect(() => {
    if (minimized) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || document.fullscreenElement) return;
      if (readerFocus && mode === "aula") {
        setReaderFocus(entry.id, false);
        return;
      }
      if (closeAskOpen) return; // dialog tanya-cache sedang terbuka
      void requestClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [minimized, close, readerFocus, mode, closeAskOpen, file.storageKey]);

  // Keluar dari mode fokus bila pratinjau dikecilkan / ganti mode tampilan.
  useEffect(() => {
    if ((minimized || mode !== "aula") && readerFocus) {
      setReaderFocus(entry.id, false);
    }
  }, [minimized, mode, readerFocus, entry.id, setReaderFocus]);
  // Bersihkan status fokus saat jendela benar-benar ditutup.
  useEffect(
    () => () => setReaderFocus(entry.id, false),
    [entry.id, setReaderFocus]
  );

  // Fokus jendela saat dibuka/dipulihkan (aksibilitas keyboard).
  const frameRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!minimized) frameRef.current?.focus();
  }, [minimized]);

  // ── Kotak PiP: posisi default tumpukan kanan-bawah saat pertama
  //    kali dikecilkan (berdasar urutan di antara PiP lain).
  useEffect(() => {
    if (!minimized || entry.pip) return;
    const list = usePreviewStore.getState().entries.filter((e) => e.minimized);
    const idx = Math.max(0, list.findIndex((e) => e.id === entry.id));
    const w = 340;
    const h = 214;
    ensurePipBox(
      entry.id,
      clampBox({
        w,
        h,
        x: window.innerWidth - w - 16,
        y: window.innerHeight - h - 16 - idx * (h + 12),
      })
    );
  }, [minimized, entry.pip, entry.id, ensurePipBox]);

  // Jendela browser diubah ukurannya → jaga kartu PiP tetap di dalam layar.
  useEffect(() => {
    if (!minimized || !entry.pip) return;
    const pip = entry.pip;
    const onResize = () => {
      const clamped = clampBox(pip);
      if (
        clamped.x !== pip.x ||
        clamped.y !== pip.y ||
        clamped.w !== pip.w ||
        clamped.h !== pip.h
      ) {
        setPipBox(entry.id, clamped);
      }
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [minimized, entry.pip, entry.id, setPipBox]);

  // ── Drag & resize PiP (state lokal saat gerak, commit ke store saat lepas).
  const [liveBox, setLiveBox] = useState<PipBox | null>(null);
  const liveBoxRef = useRef<PipBox | null>(null);
  const box = liveBox ?? entry.pip ?? FALLBACK_BOX;
  const dragRef = useRef<{
    mode: "move" | "resize";
    px: number;
    py: number;
    box: PipBox;
  } | null>(null);

  function startPointer(
    e: ReactPointerEvent<HTMLElement>,
    kind: "move" | "resize"
  ) {
    if (e.button !== 0) return;
    e.preventDefault(); // cegah seleksi teks saat menyeret
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { mode: kind, px: e.clientX, py: e.clientY, box };
  }
  function movePointer(e: ReactPointerEvent<HTMLElement>) {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.px;
    const dy = e.clientY - d.py;
    const next = clampBox(
      d.mode === "move"
        ? { ...d.box, x: d.box.x + dx, y: d.box.y + dy }
        : { ...d.box, w: d.box.w + dx, h: d.box.h + dy }
    );
    liveBoxRef.current = next;
    setLiveBox(next);
  }
  function endPointer() {
    if (!dragRef.current) return;
    dragRef.current = null;
    if (liveBoxRef.current) setPipBox(entry.id, liveBoxRef.current);
    liveBoxRef.current = null;
    setLiveBox(null);
  }

  const dragHandlers = {
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) =>
      startPointer(e, "move"),
    onPointerMove: movePointer,
    onPointerUp: endPointer,
    onPointerCancel: endPointer,
  };

  // ── Render ────────────────────────────────────────────────────────────
  return createPortal(
    <>
      {/* Overlay — hanya saat jendela besar. Klik menutup (perilaku
          dialog dulu). */}
      {!minimized ? (
        <div
          className="fixed inset-0 z-50 bg-black/50 animate-in fade-in-0"
          onPointerDown={() => void requestClose()}
        />
      ) : null}

      {/* Frame jendela — ELEMEN YANG SAMA untuk mode besar & PiP;
          hanya class/style yang berubah sehingga konten di dalamnya
          (termasuk <video> yang sedang diputar) tidak pernah remount. */}
      <div
        ref={frameRef}
        tabIndex={-1}
        role="dialog"
        aria-modal={minimized ? undefined : "true"}
        aria-label={file.name}
        className={cn(
          "fixed z-50 flex flex-col overflow-hidden border border-border bg-background shadow-lg outline-none",
          minimized
            ? "rounded-xl select-none"
            : "left-1/2 top-1/2 w-[96vw] max-w-6xl -translate-x-1/2 -translate-y-1/2 rounded-lg h-[92vh] animate-in fade-in-0 zoom-in-95 duration-200"
        )}
        style={
          minimized ? { left: box.x, top: box.y, width: box.w, height: box.h } : undefined
        }
      >
        {/* Bilah judul — chrome, boleh berganti antar mode.
            MODE FOKUS: bilah melayang transparan di ATAS konten (bukan
            mengambil ruang) → dokumen memenuhi seluruh jendela. */}
        {minimized ? (
          <div
            {...dragHandlers}
            className="flex items-center gap-1.5 h-9 px-2 border-b border-border bg-muted/60 cursor-move touch-none"
            onDoubleClick={() => restorePreview(entry.id)}
          >
            <FileIcon className="size-3.5 text-primary shrink-0" />
            <span className="text-xs truncate flex-1 min-w-0" title={file.name}>
              {file.name}
            </span>
            <Button
              size="icon"
              variant="ghost"
              className="size-6 shrink-0"
              title="Perbesar pratinjau"
              aria-label="Perbesar pratinjau"
              onClick={() => restorePreview(entry.id)}
            >
              <Maximize2 className="size-3.5" />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              className="size-6 shrink-0 hover:text-destructive"
              title="Tutup pratinjau"
              aria-label="Tutup pratinjau"
              onClick={() => void requestClose()}
            >
              <X className="size-3.5" />
            </Button>
          </div>
        ) : readerFocus && mode === "aula" ? (
          <div className="absolute top-0 inset-x-0 z-40 flex items-center gap-1.5 h-11 px-3 bg-background/75 backdrop-blur border-b border-border/50">
            <Focus className="size-3.5 text-primary shrink-0" />
            <span className="text-xs truncate flex-1 min-w-0" title={file.name}>
              {file.name}
            </span>
            <Button
              size="icon"
              variant="ghost"
              className="size-7 shrink-0"
              title="Keluar mode fokus"
              aria-label="Keluar mode fokus"
              onClick={() => setReaderFocus(entry.id, false)}
            >
              <Focus className="size-3.5" />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              className="size-7 shrink-0"
              title="Perkecil menjadi PiP"
              aria-label="Perkecil menjadi PiP"
              onClick={() => minimizePreview(entry.id)}
            >
              <PictureInPicture2 className="size-3.5" />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              className="size-7 shrink-0 hover:text-destructive"
              title="Tutup pratinjau"
              aria-label="Tutup pratinjau"
              onClick={() => void requestClose()}
            >
              <X className="size-4" />
            </Button>
          </div>
        ) : (
          <PreviewHeader
            file={file}
            mode={mode}
            onSetMode={pickMode}
            onResetMode={() => {
              savePreviewPref("ask");
              setMode("ask");
            }}
            isFullscreen={isFullscreen}
            onToggleFullscreen={toggleFullscreen}
            onMinimize={() => minimizePreview(entry.id)}
            onClose={() => void requestClose()}
          />
        )}

        {/* Area konten — POSISI TREE STABIL: tidak pernah remount saat
            minimize/restore → video/audio terus berjalan. */}
        <div
          ref={contentRef}
          className={cn(
            "flex flex-col flex-1 min-h-0 overflow-hidden bg-secondary/30",
            isFullscreen && "bg-black",
            // Pusatkan hanya pratinjau native (gambar/pdf bawaan).
            isFullscreen && mode !== "aula" && "items-center justify-center",
            // Mode PiP: kelas pembantu CSS (globals.css) menyesuaikan
            // media agar pas di kartu kecil.
            minimized && "pip-body"
          )}
        >
          {mode === "ask" ? (
            <ModeChooser onPick={pickMode} />
          ) : mode === "aula" ? (
            <AulaReader
              key={file.storageKey}
              file={file}
              onOpenNative={() => setMode("native")}
            />
          ) : (
            <PreviewBody
              key={file.storageKey}
              file={file}
              fullscreen={isFullscreen}
            />
          )}
        </div>

        {/* Pegangan ubah ukuran PiP (sudut kanan-bawah) */}
        {minimized ? (
          <div
            className="absolute bottom-0 right-0 size-4 cursor-se-resize touch-none"
            title="Ubah ukuran"
            onPointerDown={(e) => startPointer(e, "resize")}
            onPointerMove={movePointer}
            onPointerUp={endPointer}
            onPointerCancel={endPointer}
          >
            <svg
              viewBox="0 0 16 16"
              className="size-full text-muted-foreground/50"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
            >
              <path d="M14 5 5 14M14 10l-4 4" strokeLinecap="round" />
            </svg>
          </div>
        ) : null}
      </div>

      {/* Dialog tanya cache saat menutup: Simpan (buka cepat lagi) atau
          Hapus dari perangkat. Hanya muncul bila file ada di cache. */}
      <Dialog open={closeAskOpen} onOpenChange={setCloseAskOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Simpan salinan file di perangkat?</DialogTitle>
            <DialogDescription>
              <b className="break-all">{file.name}</b> sudah tersimpan sementara
              di perangkat ini. Pilih <b>Simpan</b> supaya membuka ulang tanpa
              mengunduh lagi, atau <b>Hapus</b> untuk langsung membebaskan
              penyimpanan. Catatan &amp; anotasi tetap aman di akunmu.
            </DialogDescription>
          </DialogHeader>
          <label className="flex items-center gap-2 text-sm text-muted-foreground select-none cursor-pointer">
            <Checkbox
              checked={rememberChoice}
              onCheckedChange={(v) => setRememberChoice(v === true)}
            />
            Ingat pilihan ini (jangan tanya lagi)
          </label>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setCloseAskOpen(false)}>
              Batal
            </Button>
            <Button
              variant="outline"
              className="text-destructive hover:text-destructive"
              onClick={() => applyClose("delete")}
            >
              Hapus &amp; tutup
            </Button>
            <Button onClick={() => applyClose("keep")}>
              Simpan &amp; tutup
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>,
    document.body
  );
}
