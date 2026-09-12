"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  ZoomIn,
  ZoomOut,
  Maximize,
  RotateCw,
  Sun,
  Contrast,
  Pen,
  Eraser,
  Undo2,
  Trash2,
  Highlighter,
  TriangleAlert,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Slider } from "@/components/ui/slider";
import {
  ANNO_COLORS,
  type AnnoTool,
  useAnnotations,
} from "./annotations";
import { AnnotationLayer } from "./annotation-layer";

// ─────────────────────────────────────────────────────────────────────────
// Aula Reader — Gambar.
// - Zoom berjangkar: titik gambar di bawah kursor TETAP di bawah kursor
//   (tombol: tengah layar) — dulu gambar "pindah" sendiri saat di-zoom.
// - Ukuran panggung pakai LAYOUT (bukan transform scale) → scrollbar
//   akurat, tidak ada area terpotong yang tak terjangkau (dulu: tepi kiri
//   atas tak bisa discroll karena pemusatan flex saat zoom besar).
// - Rotasi 90°/180°/270°: anotasi tetap presisi (AnnotationLayer memakai
//   getScreenCTM — koordinat dikoreksi otomatis terhadap rotasi CSS).
// - Geser: seret (grab) saat diperbesar, kecerahan/kontras, error jelas.
// ─────────────────────────────────────────────────────────────────────────

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 8;
const PAD = 24; // padding scroll container (px) — supaya tepi zoom tidak nempel

export function ImageReader({
  storageKey,
  url,
  alt,
  badge,
}: {
  storageKey: string;
  url: string;
  alt: string;
  badge?: string;
}) {
  const [zoom, setZoom] = useState(1);
  const [rotate, setRotate] = useState(0); // 0 | 90 | 180 | 270
  const [brightness, setBrightness] = useState(100);
  const [contrast, setContrast] = useState(100);
  const [adjustOpen, setAdjustOpen] = useState(false);
  const [tool, setTool] = useState<AnnoTool>("none");
  const [color, setColor] = useState(ANNO_COLORS[0]);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [failed, setFailed] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const anno = useAnnotations(storageKey);
  /** Jangkar zoom: titik gambar (px gambar) + posisi kursor di layar. */
  const zoomAnchor = useRef<{
    ix: number;
    iy: number;
    cx: number;
    cy: number;
  } | null>(null);

  const filter = `brightness(${brightness}%) contrast(${contrast}%)`;
  const natW = natural?.w ?? 0;
  const natH = natural?.h ?? 0;
  const quarter = rotate % 180 !== 0; // 90/270 → lebar-tinggi tertukar
  // Ukuran tampil (px layout) setelah zoom + rotasi.
  const dispW = (quarter ? natH : natW) * zoom;
  const dispH = (quarter ? natW : natH) * zoom;

  // Muat dimensi gambar.
  const [prevUrl, setPrevUrl] = useState(url);
  if (prevUrl !== url) {
    // Reset saat file berganti (pola render-time — tanpa setState
    // sinkron di effect).
    setPrevUrl(url);
    setFailed(false);
  }
  useEffect(() => {
    const img = new Image();
    img.onload = () => setNatural({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => setFailed(true);
    img.src = url;
  }, [url]);

  // ── Zoom berjangkar ──
  // Rumus inversi (px tampil → px gambar) sesuai arah rotasi CSS (CW):
  //   0°: ix=DX/z, iy=DY/z · 90°: ix=DY/z, iy=natH−DX/z
  //   180°: ix=natW−DX/z, iy=natH−DY/z · 270°: ix=natW−DY/z, iy=DX/z
  const invRotate = useCallback(
    (DX: number, DY: number, z: number): { ix: number; iy: number } => {
      if (rotate === 90) return { ix: DY / z, iy: natH - DX / z };
      if (rotate === 180) return { ix: natW - DX / z, iy: natH - DY / z };
      if (rotate === 270) return { ix: natW - DY / z, iy: DX / z };
      return { ix: DX / z, iy: DY / z };
    },
    [rotate, natW, natH]
  );

  const applyZoom = useCallback(
    (next: number, cursor?: { cx: number; cy: number }) => {
      const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, +next.toFixed(3)));
      if (z === zoom || !natural) return;
      const stage = stageRef.current;
      if (!stage) {
        setZoom(z);
        return;
      }
      const r = stage.getBoundingClientRect();
      const cx = cursor?.cx ?? r.left + r.width / 2;
      const cy = cursor?.cy ?? r.top + r.height / 2;
      const p = invRotate(cx - r.left, cy - r.top, zoom);
      zoomAnchor.current = { ix: p.ix, iy: p.iy, cx, cy };
      setZoom(z);
    },
    [zoom, natural, invRotate]
  );

  // Pulihkan jangkar SEBELUM paint: titik gambar yang tadinya di bawah
  // kursor tetap di bawah kursor (tanpa "loncatan").
  useLayoutEffect(() => {
    const a = zoomAnchor.current;
    if (!a) return;
    zoomAnchor.current = null;
    const el = wrapRef.current;
    const stage = stageRef.current;
    if (!el || !stage) return;
    const fwd =
      rotate === 90
        ? { x: (natH - a.iy) * zoom, y: a.ix * zoom }
        : rotate === 180
          ? { x: (natW - a.ix) * zoom, y: (natH - a.iy) * zoom }
          : rotate === 270
            ? { x: a.iy * zoom, y: (natW - a.ix) * zoom }
            : { x: a.ix * zoom, y: a.iy * zoom };
    const r = stage.getBoundingClientRect();
    el.scrollLeft += fwd.x - (a.cx - r.left);
    el.scrollTop += fwd.y - (a.cy - r.top);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoom, rotate]);

  function onWheel(e: React.WheelEvent) {
    if (tool !== "none") return;
    // Ctrl+wheel = pinch-zoom trackpad; wheel biasa juga diizinkan di sini
    // (perilaku lama) namun kini BERJANGKAR di kursor.
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    applyZoom(zoom * factor, { cx: e.clientX, cy: e.clientY });
  }

  // ── Geser (seret) saat diperbesar — menggeser scroll native ──
  const drag = useRef<{ x: number; y: number; sl: number; st: number } | null>(null);
  function startPan(e: React.PointerEvent) {
    if (tool !== "none") return;
    const el = wrapRef.current;
    if (!el) return;
    drag.current = {
      x: e.clientX,
      y: e.clientY,
      sl: el.scrollLeft,
      st: el.scrollTop,
    };
    try {
      (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    } catch {
      /* abaikan */
    }
  }
  function movePan(e: React.PointerEvent) {
    const d = drag.current;
    const el = wrapRef.current;
    if (!d || !el) return;
    el.scrollLeft = d.sl - (e.clientX - d.x);
    el.scrollTop = d.st - (e.clientY - d.y);
  }

  const reset = useCallback(() => {
    setZoom(1);
    setRotate(0);
    setBrightness(100);
    setContrast(100);
  }, []);

  const canPan = tool === "none";

  if (failed) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 p-10 min-h-[40vh] text-center">
        <TriangleAlert className="size-10 text-destructive" />
        <p className="text-sm text-destructive">Gagal memuat gambar.</p>
        <p className="text-xs text-muted-foreground max-w-sm">
          File mungkin rusak atau formatnya tidak didukung browser ini.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col flex-1 h-full min-h-0">
      {/* Toolbar */}
      <div className="flex items-center gap-1.5 flex-wrap px-3 py-2 border-b border-border bg-background/95 sticky top-0 z-20">
        <Button
          variant="outline"
          size="icon"
          className="h-9 w-9"
          onClick={() => applyZoom(zoom / 1.25)}
          title="Perkecil"
        >
          <ZoomOut className="size-4" />
        </Button>
        <span className="text-xs tabular-nums w-12 text-center text-muted-foreground">
          {Math.round(zoom * 100)}%
        </span>
        <Button
          variant="outline"
          size="icon"
          className="h-9 w-9"
          onClick={() => applyZoom(zoom * 1.25)}
          title="Perbesar"
        >
          <ZoomIn className="size-4" />
        </Button>
        <Button
          variant="outline"
          size="icon"
          className="h-9 w-9"
          onClick={reset}
          title="Reset tampilan"
        >
          <Maximize className="size-4" />
        </Button>
        <Button
          variant="outline"
          size="icon"
          className="h-9 w-9"
          onClick={() => setRotate((r) => (r + 90) % 360)}
          title="Putar 90°"
        >
          <RotateCw className="size-4" />
        </Button>
        <Button
          variant={adjustOpen ? "secondary" : "outline"}
          size="icon"
          className="h-9 w-9"
          onClick={() => setAdjustOpen((v) => !v)}
          title="Atur kecerahan & kontras"
        >
          <Sun className="size-4" />
        </Button>
        {/* Anotasi */}
        <Button
          variant={tool === "hl" ? "secondary" : "outline"}
          size="icon"
          className="h-9 w-9"
          onClick={() => setTool(tool === "hl" ? "none" : "hl")}
          title="Stabilo"
        >
          <Highlighter className="size-4" />
        </Button>
        <Button
          variant={tool === "pen" ? "secondary" : "outline"}
          size="icon"
          className="h-9 w-9"
          onClick={() => setTool(tool === "pen" ? "none" : "pen")}
          title="Pena — gambar bebas"
        >
          <Pen className="size-4" />
        </Button>
        <Button
          variant={tool === "erase" ? "secondary" : "outline"}
          size="icon"
          className="h-9 w-9"
          onClick={() => setTool(tool === "erase" ? "none" : "erase")}
          title="Penghapus anotasi"
        >
          <Eraser className="size-4" />
        </Button>
        <div className="flex items-center gap-1 px-1">
          {ANNO_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              aria-label={`Warna ${c}`}
              onClick={() => setColor(c)}
              className={cn(
                "size-5 rounded-full border-2",
                color === c ? "border-foreground scale-110" : "border-transparent"
              )}
              style={{ backgroundColor: c }}
            />
          ))}
        </div>
        <Button
          variant="outline"
          size="icon"
          className="h-9 w-9"
          onClick={() => anno.undo()}
          disabled={anno.count === 0}
          title="Urungkan"
        >
          <Undo2 className="size-4" />
        </Button>
        <Button
          variant="outline"
          size="icon"
          className="h-9 w-9"
          onClick={() => anno.clearAll()}
          disabled={anno.count === 0}
          title="Hapus semua anotasi"
        >
          <Trash2 className="size-4" />
        </Button>
      </div>

      {/* Panel penyesuaian */}
      {adjustOpen ? (
        <div className="flex items-center gap-4 flex-wrap px-4 py-2 border-b border-border bg-muted/40">
          <div className="flex items-center gap-2 min-w-48">
            <Sun className="size-4 text-muted-foreground" />
            <Slider
              value={[brightness]}
              min={40}
              max={180}
              step={5}
              onValueChange={([v]) => setBrightness(v)}
              className="flex-1"
            />
            <span className="text-xs tabular-nums w-10 text-muted-foreground">
              {brightness}%
            </span>
          </div>
          <div className="flex items-center gap-2 min-w-48">
            <Contrast className="size-4 text-muted-foreground" />
            <Slider
              value={[contrast]}
              min={40}
              max={180}
              step={5}
              onValueChange={([v]) => setContrast(v)}
              className="flex-1"
            />
            <span className="text-xs tabular-nums w-10 text-muted-foreground">
              {contrast}%
            </span>
          </div>
        </div>
      ) : null}

      {/* Viewport — panggung berukuran LAYOUT (scrollbar akurat) */}
      <div
        ref={wrapRef}
        className="flex-1 min-h-0 overflow-auto bg-neutral-200 dark:bg-neutral-900/60 grid"
        style={{ padding: PAD }}
        onWheel={onWheel}
      >
        {badge ? (
          <div className="fixed top-2 left-1/2 -translate-x-1/2 z-10 rounded-full bg-background/90 border border-border px-3 py-1 text-[11px] text-muted-foreground shadow-sm">
            {badge}
          </div>
        ) : null}
        {/* Panggung: margin auto (grid) → terpusat saat muat, menempel
            rata kiri-atas saat meluap (semua area terjangkau scroll). */}
        <div
          ref={stageRef}
          className="relative m-auto shadow-lg"
          style={{
            width: natural ? Math.max(40, dispW) : 480,
            height: natural ? Math.max(40, dispH) : 320,
            cursor: canPan ? (zoom > 1 ? "grab" : undefined) : undefined,
            touchAction: canPan ? "auto" : "none",
          }}
          onPointerDown={startPan}
          onPointerMove={movePan}
          onPointerUp={() => (drag.current = null)}
          onPointerCancel={() => (drag.current = null)}
        >
          {natural ? (
            <div
              className="absolute left-1/2 top-1/2"
              style={{
                width: natW,
                height: natH,
                // Rotasi + skala: panggung (layout dispW×dispH) menangani
                // ukuran scroll; rotator memvisualkan konten tepat seukuran
                // panggung (skala seragam ⇒ urutan rotate/scale bebas).
                transform: `translate(-50%, -50%) rotate(${rotate}deg) scale(${zoom})`,
              }}
            >
              <div className="relative" style={{ width: natW, height: natH }}>
                <img
                  src={url}
                  alt={alt}
                  draggable={false}
                  style={{ filter }}
                  className="block select-none max-w-none"
                  width={natW}
                  height={natH}
                />
                <AnnotationLayer
                  page={1}
                  tool={tool}
                  color={color}
                  items={anno.items}
                  onAdd={anno.add}
                  onErase={anno.remove}
                />
              </div>
            </div>
          ) : (
            <div className="w-full h-full rounded bg-muted animate-pulse" />
          )}
        </div>
      </div>
    </div>
  );
}
