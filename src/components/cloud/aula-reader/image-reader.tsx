"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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
// Zoom (tombol/scroll/pinch), geser saat diperbesar, putar, atur
// kecerahan/kontras (membaca foto materi), dan anotasi stabilo + pena.
// ─────────────────────────────────────────────────────────────────────────

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
  const [rotate, setRotate] = useState(0);
  const [brightness, setBrightness] = useState(100);
  const [contrast, setContrast] = useState(100);
  const [adjustOpen, setAdjustOpen] = useState(false);
  const [tool, setTool] = useState<AnnoTool>("none");
  const [color, setColor] = useState(ANNO_COLORS[0]);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [loaded, setLoaded] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const anno = useAnnotations(storageKey);
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const [pan, setPan] = useState({ x: 0, y: 0 });

  const filter = `brightness(${brightness}%) contrast(${contrast}%)`;

  function onWheel(e: React.WheelEvent) {
    if (tool !== "none") return;
    if (e.deltaY < 0) setZoom((z) => Math.min(8, z * 1.15));
    else setZoom((z) => Math.max(0.25, z / 1.15));
  }

  function startPan(e: React.PointerEvent) {
    if (zoom <= 1.05 || tool !== "none") return;
    drag.current = { x: e.clientX, y: e.clientY, left: pan.x, top: pan.y };
    (e.target as Element).setPointerCapture?.(e.pointerId);
  }
  function movePan(e: React.PointerEvent) {
    const d = drag.current;
    if (!d) return;
    setPan({
      x: d.left + (e.clientX - d.x),
      y: d.top + (e.clientY - d.y),
    });
  }

  const reset = useCallback(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
    setRotate(0);
    setBrightness(100);
    setContrast(100);
  }, []);

  useEffect(() => {
    const img = new Image();
    img.onload = () => {
      setNatural({ w: img.naturalWidth, h: img.naturalHeight });
      setLoaded(true);
    };
    img.src = url;
  }, [url]);

  return (
    <div className="flex flex-col flex-1 h-full min-h-0">
      {/* Toolbar */}
      <div className="flex items-center gap-1.5 flex-wrap px-3 py-2 border-b border-border bg-background/95 sticky top-0 z-20">
        <Button
          variant="outline"
          size="icon"
          className="h-9 w-9"
          onClick={() => setZoom((z) => Math.max(0.25, z / 1.25))}
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
          onClick={() => setZoom((z) => Math.min(8, z * 1.25))}
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

      {/* Kanvas gambar */}
      <div
        ref={wrapRef}
        className="flex-1 min-h-0 overflow-auto bg-neutral-200 dark:bg-neutral-900/60 flex items-center justify-center"
        onWheel={onWheel}
      >
        {badge ? (
          <div className="absolute top-2 left-1/2 -translate-x-1/2 z-10 rounded-full bg-background/90 border border-border px-3 py-1 text-[11px] text-muted-foreground shadow-sm">
            {badge}
          </div>
        ) : null}
        <div
          className="relative m-auto shadow-lg"
          style={{
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom}) rotate(${rotate}deg)`,
            transformOrigin: "center center",
            cursor: zoom > 1.05 && tool === "none" ? "grab" : undefined,
            touchAction: tool === "none" ? "auto" : "none",
          }}
          onPointerDown={startPan}
          onPointerMove={movePan}
          onPointerUp={() => (drag.current = null)}
        >
          {/* placeholder rasio supaya layout stabil sebelum termuat */}
          <div style={{ width: natural ? undefined : 480, height: natural ? undefined : 320 }} />
          {loaded ? (
            <div className="relative">
              <img
                src={url}
                alt={alt}
                draggable={false}
                style={{ filter }}
                className="block select-none max-w-none"
                onLoad={(e) => {
                  const el = e.currentTarget;
                  if (el.naturalWidth) setNatural({ w: el.naturalWidth, h: el.naturalHeight });
                }}
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
          ) : null}
        </div>
      </div>
    </div>
  );
}
