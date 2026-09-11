"use client";

import { useMemo, useRef, useState } from "react";
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
    cur: [number, number];
  } | null>(null);
  const [live, setLive] = useState<{
    pts: [number, number][];
    start: [number, number];
    cur: [number, number];
  } | null>(null);
  const [erased, setErased] = useState<Set<string>>(new Set());
  /** Sedang menyeret penghapus → k terus menghapus saat digerakkan. */
  const erasing = useRef(false);

  // HANYA anotasi milik HALAMAN INI yang dirender & bisa dihapus.
  // (Dulu: seluruh anotasi file dirender di SETIAP halaman → stabilo
  // halaman 1 muncul di semua halaman pada posisi yang sama.)
  const pageItems = useMemo(
    () => items.filter((a) => a.page === page),
    [items, page]
  );

  function posOf(e: React.PointerEvent): [number, number] {
    const svg = svgRef.current;
    if (!svg) return [0, 0];
    const r = svg.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    const y = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
    return [x, y];
  }

  function eraseAt(p: [number, number]) {
    const hit = hitTest(pageItems, p);
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
        {pageItems.map((a) => (
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
        try {
          (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
        } catch {
          /* pointer sudah lepas / sintetis — tetap lanjut menggambar */
        }
        const p = posOf(e);
        if (tool === "erase") {
          erasing.current = true;
          eraseAt(p);
          return;
        }
        drawing.current = { pts: [p], start: p, cur: p };
        setLive({ pts: [p], start: p, cur: p });
      }}
      onPointerMove={(e) => {
        if (tool === "erase") {
          // Seret penghapus: hapus semua anotasi yang dilewati.
          if (erasing.current) eraseAt(posOf(e));
          return;
        }
        const d = drawing.current;
        if (!d) return;
        const p = posOf(e);
        d.cur = p;
        if (tool === "pen") {
          d.pts.push(p);
          // Snapshot lokal sebelum setState — mencegah race dengan
          // pointerup yang meng-null-kan drawing.current (dulu crash
          // "Cannot read properties of null (reading 'pts')").
          const pts = [...d.pts];
          setLive((l) => (l ? { ...l, pts } : l));
        } else {
          setLive((l) => (l ? { ...l, cur: p } : l));
        }
      }}
      onPointerUp={() => {
        const d = drawing.current;
        drawing.current = null;
        erasing.current = false;
        setLive(null);
        if (!d) return;
        if (tool === "pen") {
          if (d.pts.length > 1) {
            onAdd({
              id: newId(),
              page,
              tool: "pen",
              color,
              w: 0.006,
              pts: d.pts,
              created: Date.now(),
            });
          }
          return;
        }
        // stabilo: kotak dari titik awal → titik terakhir (dari ref,
        // bukan state live yang bisa basi). Gestur stabilo natural = seret
        // mendatar pada satu baris teks → tinggi 0 → beri tinggi minimal
        // seperti coretan stabilo sungguhan (dulu: kotak ditolak).
        const x2 = d.cur[0];
        const y2 = d.cur[1];
        let x = Math.min(d.start[0], x2);
        let y = Math.min(d.start[1], y2);
        let w = Math.abs(x2 - d.start[0]);
        let h = Math.abs(y2 - d.start[1]);
        if (h < 0.012) {
          const cy = y + h / 2;
          y = cy - 0.006;
          h = 0.012;
        }
        if (w < 0.004) {
          const cx = x + w / 2;
          x = cx - 0.002;
          w = 0.004;
        }
        onAdd({
          id: newId(),
          page,
          tool: "hl",
          color,
          rect: [x, y, w, h],
          created: Date.now(),
        });
      }}
      onPointerCancel={() => {
        drawing.current = null;
        erasing.current = false;
        setLive(null);
      }}
    >
      {pageItems.map((a) => (
        <AnnotationShape key={a.id} a={a} />
      ))}
      {live && tool === "pen" ? (
        <polyline
          points={live.pts.map(([x, y]) => `${x},${y}`).join(" ")}
          fill="none"
          stroke={color}
          strokeWidth={0.006}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ) : null}
      {live && tool === "hl" ? (() => {
        // Band stabilo: tinggi minimal 0.012 agar seret mendatar tetap
        // terlihat sebagai coretan stabilo (bukan garis tanpa tinggi).
        const x = Math.min(live.start[0], live.cur[0]);
        const rawH = Math.abs(live.cur[1] - live.start[1]);
        const y = rawH < 0.012
          ? (live.start[1] + live.cur[1]) / 2 - 0.006
          : Math.min(live.start[1], live.cur[1]);
        const h = Math.max(rawH, 0.012);
        const w = Math.max(Math.abs(live.cur[0] - live.start[0]), 0.004);
        return (
          <rect
            x={x}
            y={y}
            width={w}
            height={h}
            fill={color}
            opacity={0.7}
            style={{ mixBlendMode: "multiply" }}
          />
        );
      })() : null}
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
        opacity={0.7}
        rx={0.004}
        // Multiply: teks hitam tetap hitam, kertas putih jadi warna stabilo —
        // persis stabilo sungguhan (tidak menutupi teks di bawahnya).
        // Opacity 0.7 (dulu 0.5): stabilo lebih terlihat jelas; teks tetap
        // gelap karena multiply tak pernah mencerahkan.
        style={{ mixBlendMode: "multiply" }}
      />
    );
  }
  if (a.tool === "pen" && a.pts && a.pts.length > 1) {
    return (
      <polyline
        points={a.pts.map(([x, y]) => `${x},${y}`).join(" ")}
        fill="none"
        stroke={a.color}
        strokeWidth={a.w ?? 0.006}
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
