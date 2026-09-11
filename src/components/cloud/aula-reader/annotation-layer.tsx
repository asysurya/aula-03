"use client";

import { useRef, useState } from "react";
import type { Annotation, AnnoTool } from "./annotations";
import { newId } from "./annotations";

// ─────────────────────────────────────────────────────────────────────────
// Lapisan anotasi (SVG) di atas konten — stabilo (kotak transparan) &
// pena (goresan bebas). Koordinat 0..1 → viewBox "0 0 1 1" +
// preserveAspectRatio="none" → presisi di semua zoom & ukuran layar.
// Mode "none" tidak menangkap pointer (scroll/tap normal).
// ─────────────────────────────────────────────────────────────────────────

export function AnnotationLayer({
  page,
  tool,
  color,
  items,
  onAdd,
  onErase,
}: {
  page: number;
  tool: AnnoTool;
  color: string;
  items: Annotation[];
  onAdd: (a: Annotation) => void;
  onErase: (id: string) => void;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const drawing = useRef<{
    pts: [number, number][];
    start: [number, number];
  } | null>(null);
  const [live, setLive] = useState<{
    pts: [number, number][];
    start: [number, number];
    cur: [number, number];
  } | null>(null);
  const [erased, setErased] = useState<Set<string>>(new Set());

  function posOf(e: React.PointerEvent): [number, number] {
    const svg = svgRef.current;
    if (!svg) return [0, 0];
    const r = svg.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    const y = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
    return [x, y];
  }

  function eraseAt(p: [number, number]) {
    const hit = hitTest(items, p);
    if (hit && !erased.has(hit)) {
      setErased((prev) => new Set(prev).add(hit));
      onErase(hit);
    }
  }

  if (tool === "none") {
    // Tetap render item lama (tanpa interaksi).
    return (
      <svg
        ref={svgRef}
        viewBox="0 0 1 1"
        preserveAspectRatio="none"
        className="absolute inset-0 w-full h-full pointer-events-none"
      >
        {items.map((a) => (
          <AnnotationShape key={a.id} a={a} />
        ))}
      </svg>
    );
  }

  return (
    <svg
      ref={svgRef}
      viewBox="0 0 1 1"
      preserveAspectRatio="none"
      className={`absolute inset-0 w-full h-full ${
        tool === "erase" ? "cursor-cell" : "cursor-crosshair"
      }`}
      style={{ touchAction: "none" }}
      onPointerDown={(e) => {
        e.preventDefault();
        (e.target as Element).setPointerCapture?.(e.pointerId);
        const p = posOf(e);
        if (tool === "erase") {
          eraseAt(p);
          return;
        }
        drawing.current = { pts: [p], start: p };
        setLive({ pts: [p], start: p, cur: p });
      }}
      onPointerMove={(e) => {
        if (!drawing.current) return;
        const p = posOf(e);
        if (tool === "pen") {
          drawing.current.pts.push(p);
          setLive((l) =>
            l ? { ...l, pts: [...drawing.current!.pts] } : l
          );
        } else {
          setLive((l) => (l ? { ...l, cur: p } : l));
        }
      }}
      onPointerUp={() => {
        const d = drawing.current;
        drawing.current = null;
        setLive(null);
        if (!d) return;
        if (tool === "pen") {
          if (d.pts.length > 1) {
            onAdd({
              id: newId(),
              page,
              tool: "pen",
              color,
              w: 0.004,
              pts: d.pts,
              created: Date.now(),
            });
          }
          return;
        }
        // stabilo: kotak
        const x2 = live?.cur?.[0] ?? d.start[0];
        const y2 = live?.cur?.[1] ?? d.start[1];
        const x = Math.min(d.start[0], x2);
        const y = Math.min(d.start[1], y2);
        const w = Math.abs(x2 - d.start[0]);
        const h = Math.abs(y2 - d.start[1]);
        if (w > 0.004 && h > 0.004) {
          onAdd({
            id: newId(),
            page,
            tool: "hl",
            color,
            rect: [x, y, w, h],
            created: Date.now(),
          });
        }
      }}
      onPointerCancel={() => {
        drawing.current = null;
        setLive(null);
      }}
    >
      {items.map((a) => (
        <AnnotationShape key={a.id} a={a} />
      ))}
      {live && tool === "pen" ? (
        <polyline
          points={live.pts.map(([x, y]) => `${x},${y}`).join(" ")}
          fill="none"
          stroke={color}
          strokeWidth={0.004}
          vectorEffect="non-scaling-stroke"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ) : null}
      {live && tool === "hl" ? (
        <rect
          x={Math.min(live.start[0], live.cur[0])}
          y={Math.min(live.start[1], live.cur[1])}
          width={Math.abs(live.cur[0] - live.start[0])}
          height={Math.abs(live.cur[1] - live.start[1])}
          fill={color}
          opacity={0.35}
        />
      ) : null}
    </svg>
  );
}

function AnnotationShape({ a }: { a: Annotation }) {
  if (a.tool === "hl" && a.rect) {
    const [x, y, w, h] = a.rect;
    return (
      <rect
        x={x}
        y={y}
        width={w}
        height={h}
        fill={a.color}
        opacity={0.35}
        rx={0.004}
      />
    );
  }
  if (a.tool === "pen" && a.pts && a.pts.length > 1) {
    return (
      <polyline
        points={a.pts.map(([x, y]) => `${x},${y}`).join(" ")}
        fill="none"
        stroke={a.color}
        strokeWidth={a.w ?? 0.004}
        vectorEffect="non-scaling-stroke"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    );
  }
  return null;
}

/** Hit-test sederhana: titik dekat goresan/kotak → id anotasi. */
function hitTest(items: Annotation[], p: [number, number]): string | null {
  const TOL = 0.02;
  for (let i = items.length - 1; i >= 0; i--) {
    const a = items[i];
    if (a.tool === "hl" && a.rect) {
      const [x, y, w, h] = a.rect;
      if (
        p[0] >= x - TOL &&
        p[0] <= x + w + TOL &&
        p[1] >= y - TOL &&
        p[1] <= y + h + TOL
      )
        return a.id;
    } else if (a.tool === "pen" && a.pts) {
      for (const [px, py] of a.pts) {
        if (Math.abs(px - p[0]) < TOL && Math.abs(py - p[1]) < TOL)
          return a.id;
      }
    }
  }
  return null;
}
