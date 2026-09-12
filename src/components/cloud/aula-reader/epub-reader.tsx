"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  List,
  ZoomIn,
  ZoomOut,
  Loader2,
  BookOpen,
  Moon,
  Sun,
  Highlighter,
  Undo2,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { useSelectionMenu, SelectionToolbar } from "./selection-actions";
import { ANNO_COLORS, newId, useAnnotations } from "./annotations";
import type { OfficeCacheEntry } from "@/components/cloud/buffer-loader";

// ─────────────────────────────────────────────────────────────────────────
// Aula Reader — EPUB (buku digital).
// Unzip → container.xml → OPF → urutan baca (spine) → render bab per bab
// (XHTML disanitasi; gambar di-embed dari dalam zip).
// Fitur: navigasi bab, daftar isi, ukuran font (persist), TEMA baca,
// LANJUT BACA (bab terakhir → MongoDB), STABILO TEKS per bab (offset
// karakter → MongoDB), menu seleksi (Bacakan / Salin).
// ─────────────────────────────────────────────────────────────────────────

interface SpineItem {
  href: string;
  title: string;
}

/** Base64 dari Uint8Array — dipotong per 32KB. (Dulu:
 *  btoa(String.fromCharCode(...data)) → gambar >±100KB CRASH
 *  "Maximum call stack size exceeded" karena spread melebihi batas
 *  argumen fungsi, dan bab tidak pernah muncul.) */
function u8ToBase64(u8: Uint8Array): string {
  let s = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < u8.length; i += CHUNK) {
    s += String.fromCharCode(...u8.subarray(i, i + CHUNK));
  }
  return btoa(s);
}

const FONT_KEY = "aula.epub.font";
const THEME_KEY = "aula.epub.theme";
type EpubTheme = "light" | "paper" | "dark";

function loadFont(): number {
  try {
    const v = Number(localStorage.getItem(FONT_KEY));
    return v >= 12 && v <= 30 ? v : 17;
  } catch {
    return 17;
  }
}
function loadTheme(): EpubTheme {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === "light" || v === "dark" ? v : "paper";
  } catch {
    return "paper";
  }
}

/** Bungkus rentang [start,end) offset karakter dengan <mark> di dalam
 *  kontainer (offset dihitung dari node teks via TreeWalker — stabil
 *  terhadap struktur HTML bab). Dipanggil setiap isi bab dipasang ulang. */
function applyTextMarks(
  root: HTMLElement,
  marks: { start: number; end: number; color: string }[]
) {
  if (marks.length === 0) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  let n: Node | null;
  while ((n = walker.nextNode())) nodes.push(n as Text);
  let pos = 0;
  const ops: { node: Text; from: number; to: number; color: string }[] = [];
  for (const node of nodes) {
    const nodeStart = pos;
    const nodeEnd = pos + node.length;
    for (const m of marks) {
      const from = Math.max(m.start, nodeStart);
      const to = Math.min(m.end, nodeEnd);
      if (from < to)
        ops.push({ node, from: from - nodeStart, to: to - nodeStart, color: m.color });
    }
    pos = nodeEnd;
  }
  if (ops.length === 0) return;
  // Terapkan per-node dari offset TERTINGGI dulu — splitText tidak
  // menggeser offset operasi yang lebih kecil.
  ops.sort((a, b) => b.from - a.from);
  for (const op of ops) {
    if (op.to < op.node.length) op.node.splitText(op.to);
    const target = op.node.splitText(op.from);
    const mark = document.createElement("mark");
    mark.style.backgroundColor = op.color;
    mark.style.color = "inherit";
    mark.className = "rounded-sm";
    target.parentNode?.insertBefore(mark, target);
    mark.appendChild(target);
  }
}

export function EpubReader({
  file,
  entry,
}: {
  file: { storageKey: string; name: string };
  entry: OfficeCacheEntry;
}) {
  const [chapters, setChapters] = useState<SpineItem[] | null>(null);
  const [files, setFiles] = useState<Map<string, Uint8Array> | null>(null);
  const [idx, setIdx] = useState(0);
  const [html, setHtml] = useState<string | null>(null);
  const [tocOpen, setTocOpen] = useState(false);
  const [fontSize, setFontSize] = useState(loadFont);
  const [theme, setTheme] = useState<EpubTheme>(loadTheme);
  const [error, setError] = useState<string | null>(null);
  const [hlColor, setHlColor] = useState(ANNO_COLORS[0]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  /** Sudah coba restore bab terakhir? */
  const restored = useRef(false);

  // Anotasi (MongoDB): page = nomor bab (1-based) · thl = stabilo teks.
  const anno = useAnnotations(file.storageKey);

  // Menu aksi teks terpilih (Bacakan / Salin / Stabilo) di isi bab.
  const sel = useSelectionMenu({
    containerRef: scrollRef,
    onHighlight: () => {
      // Offset dihitung dari seleksi AKTIF saat tombol ditekan.
      const s = window.getSelection();
      const root = bodyRef.current;
      if (!s || s.isCollapsed || !root || !s.anchorNode || !s.focusNode) return;
      if (!root.contains(s.anchorNode) || !root.contains(s.focusNode)) return;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      const nodes: Text[] = [];
      let n: Node | null;
      while ((n = walker.nextNode())) nodes.push(n as Text);
      let pos = 0;
      let start = -1;
      let end = -1;
      for (const node of nodes) {
        if (node === s.anchorNode) start = pos + (s.anchorOffset ?? 0);
        if (node === s.focusNode) end = pos + (s.focusOffset ?? 0);
        pos += node.length;
      }
      if (start < 0 || end < 0 || start === end) return;
      anno.add({
        id: newId(),
        page: idx + 1,
        tool: "thl",
        color: hlColor,
        start: Math.min(start, end),
        end: Math.max(start, end),
        created: Date.now(),
      });
      window.getSelection()?.removeAllRanges();
    },
    activeColor: hlColor,
  });

  // Stabilo teks bab aktif.
  const chapterMarks = useMemo(
    () =>
      anno.items
        .filter(
          (a) => a.tool === "thl" && a.page === idx + 1 && typeof a.start === "number"
        )
        .sort((a, b) => a.start! - b.start!),
    [anno.items, idx]
  );

  // Parse EPUB.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { unzipSync, strFromU8 } = await import("fflate");
        const zip = unzipSync(new Uint8Array(entry.buffer));
        const get = (p: string) => zip[p] ?? zip[p.replace(/^\//, "")];
        // 1. container.xml → OPF
        const containerXml = get("META-INF/container.xml");
        if (!containerXml) throw new Error("container.xml tidak ditemukan");
        const cDoc = new DOMParser().parseFromString(
          strFromU8(containerXml),
          "application/xml"
        );
        const opfPath = cDoc
          .querySelector("rootfile")
          ?.getAttribute("full-path");
        if (!opfPath) throw new Error("OPF tidak ditemukan");
        const baseDir = opfPath.includes("/")
          ? opfPath.slice(0, opfPath.lastIndexOf("/") + 1)
          : "";
        const opf = get(opfPath);
        if (!opf) throw new Error("OPF rusak");
        const opfDoc = new DOMParser().parseFromString(
          strFromU8(opf),
          "application/xml"
        );
        // 2. manifest id → href
        const manifest = new Map<string, string>();
        opfDoc.querySelectorAll("manifest > item").forEach((it) => {
          const id = it.getAttribute("id");
          const href = it.getAttribute("href");
          if (id && href) manifest.set(id, baseDir + decodeURIComponent(href));
        });
        // 3. spine order
        const spine: SpineItem[] = [];
        opfDoc.querySelectorAll("spine > itemref").forEach((ref) => {
          const idref = ref.getAttribute("idref");
          if (!idref) return;
          const href = manifest.get(idref);
          if (href && get(href)) spine.push({ href, title: "" });
        });
        if (spine.length === 0) throw new Error("Spine kosong");
        if (cancelled) return;
        setFiles(new Map(Object.entries(zip)));
        setChapters(spine);
      } catch (e) {
        if (!cancelled)
          setError(
            e instanceof Error ? e.message : "Gagal membuka EPUB"
          );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [entry.buffer]);

  const current = chapters?.[idx] ?? null;
  const zipFiles = files;

  // ── Lanjut baca: bab terakhir dari MongoDB (sekali) ──
  // TIDAK menandai "restored" sebelum data server tiba (savedPage masih 1
  // saat mount) — dulu: parse EPUB lokal instan → efek ini jalan duluan,
  // restored=true terpasang, lalu savedPage datang terlambat → buku selalu
  // terbuka dari Bab 1 lagi.
  useEffect(() => {
    if (!chapters || restored.current) return;
    const p = anno.savedPage;
    if (p > 1 && p <= chapters.length) {
      restored.current = true;
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setIdx(p - 1);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chapters, anno.savedPage]);

  // Laporan bab aktif (untuk lanjut baca berikutnya).
  useEffect(() => {
    if (chapters) anno.reportPage(idx + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idx, chapters]);

  // Render bab aktif.
  useEffect(() => {
    if (!current || !zipFiles) return;
    let cancelled = false;
    (async () => {
      try {
        const raw = zipFiles.get(current.href);
        if (!raw) return;
        const { strFromU8 } = await import("fflate");
        const doc = new DOMParser().parseFromString(
          strFromU8(raw),
          "application/xhtml+xml"
        );
        // Sanitasi: elemen aktif/phishing dibuang SELURUHNYA, termasuk
        // <style> (CSS exfil) & <form>/<input> (phishing), plus <base>.
        doc
          .querySelectorAll(
            "script, iframe, object, embed, link, meta[http-equiv], style, base, form, input, button, select, textarea"
          )
          .forEach((el) => el.remove());
        doc.querySelectorAll("*").forEach((el) => {
          [...el.attributes].forEach((attr) => {
            const n = attr.name.toLowerCase();
            // Event handler (onclick, onerror, dsb.).
            if (n.startsWith("on")) el.removeAttribute(attr.name);
            // URL berbahaya: javascript:/vbscript:/data: (kecuali data:image
            // internal yang sudah kita pasang sendiri).
            else if (
              (n === "href" ||
                n === "xlink:href" ||
                n === "src" ||
                n === "srcset" ||
                n === "background") &&
              /^\s*(javascript|vbscript|data)\s*:/i.test(attr.value)
            )
              el.removeAttribute(attr.name);
          });
        });
        // Gambar → data URL dari zip. Path persen-ter-encode (mis.
        // "gambarku%20bagus.png") didekode sebelum lookup — dulu gambar
        // seperti itu gagal ditemukan lalu ikut dibuang.
        const imgs = doc.querySelectorAll("img");
        for (const img of imgs) {
          const src = img.getAttribute("src");
          if (!src) continue;
          let path = "";
          try {
            path = new URL(src, "http://x/" + current.href).pathname.slice(1);
          } catch {
            path = src;
          }
          const data =
            zipFiles.get(path) ??
            zipFiles.get(decodeURIComponent(path)) ??
            zipFiles.get(src) ??
            zipFiles.get(decodeURIComponent(src));
          if (data) {
            const e = path.split(".").pop()?.toLowerCase() ?? "jpg";
            const mime =
              e === "png"
                ? "image/png"
                : e === "gif"
                ? "image/gif"
                : e === "svg"
                ? "image/svg+xml"
                : e === "webp"
                ? "image/webp"
                : "image/jpeg";
            img.setAttribute("src", `data:${mime};base64,${u8ToBase64(data)}`);
          } else {
            img.remove();
          }
        }
        const body = doc.body?.innerHTML ?? "";
        const title = doc.querySelector("title")?.textContent?.trim() ?? "";
        if (cancelled) return;
        setHtml(body);
        setChapters((prev) => {
          if (!prev) return prev;
          if (prev[idx]?.title) return prev;
          const next = [...prev];
          next[idx] = { ...next[idx], title: title || `Bagian ${idx + 1}` };
          return next;
        });
        scrollRef.current?.scrollTo({ top: 0 });
      } catch (e) {
        // Dulu: tanpa try/catch → error pembukaan bab = spinner selamanya.
        if (!cancelled)
          setError(
            e instanceof Error ? e.message : "Gagal membuka bagian buku ini"
          );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [current, zipFiles, idx]);

  // ── Pasang isi bab + stabilo teks (setiap html / marks berubah,
  //    kontainer DI-RESET dari sumber lalu mark dibungkus ulang —
  //    tidak pakai dangerouslySetInnerHTML supaya reset terkendali). ──
  useEffect(() => {
    const el = bodyRef.current;
    if (!el || html === null) return;
    el.innerHTML = html;
    applyTextMarks(
      el,
      chapterMarks.map((m) => ({ start: m.start!, end: m.end!, color: m.color }))
    );
  }, [html, chapterMarks, idx]);

  function go(delta: number) {
    if (!chapters) return;
    const next = Math.min(chapters.length - 1, Math.max(0, idx + delta));
    setIdx(next);
  }

  function setFont(v: number) {
    setFontSize(v);
    try {
      localStorage.setItem(FONT_KEY, String(v));
    } catch {}
  }
  function cycleTheme() {
    setTheme((t) => {
      const next = t === "light" ? "paper" : t === "paper" ? "dark" : "light";
      try {
        localStorage.setItem(THEME_KEY, next);
      } catch {}
      return next;
    });
  }

  const chapterTitle = useMemo(
    () => chapters?.[idx]?.title || `Bagian ${idx + 1}`,
    [chapters, idx]
  );

  const themeCls =
    theme === "dark"
      ? "bg-neutral-900 text-neutral-200"
      : theme === "paper"
      ? "bg-[#f7f2e7] text-neutral-800"
      : "bg-white text-neutral-900";

  if (error) {
    return (
      <div className="p-8 text-center text-sm text-destructive">
        Gagal membuka EPUB: {error}
      </div>
    );
  }
  if (!chapters || html === null) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 p-10 min-h-[40vh]">
        <Loader2 className="size-8 animate-spin text-muted-foreground" />
        <p className="text-sm text-muted-foreground">Membuka buku…</p>
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
          onClick={() => go(-1)}
          disabled={idx === 0}
          title="Bagian sebelumnya"
        >
          <ChevronLeft className="size-4" />
        </Button>
        <span className="text-xs text-muted-foreground whitespace-nowrap max-w-56 truncate">
          {chapterTitle}
        </span>
        <Button
          variant="outline"
          size="icon"
          className="h-9 w-9"
          onClick={() => go(1)}
          disabled={idx >= chapters.length - 1}
          title="Bagian berikutnya"
        >
          <ChevronRight className="size-4" />
        </Button>
        <span className="text-xs tabular-nums text-muted-foreground">
          {idx + 1}/{chapters.length}
        </span>
        <Button
          variant={tocOpen ? "secondary" : "outline"}
          size="icon"
          className="h-9 w-9"
          onClick={() => setTocOpen((v) => !v)}
          title="Daftar isi"
        >
          <List className="size-4" />
        </Button>
        <Button
          variant="outline"
          size="icon"
          className="h-9 w-9"
          onClick={() => setFont(Math.max(12, fontSize - 1))}
          title="Perkecil"
        >
          <ZoomOut className="size-4" />
        </Button>
        <span className="text-xs tabular-nums text-muted-foreground w-8 text-center">
          {fontSize}
        </span>
        <Button
          variant="outline"
          size="icon"
          className="h-9 w-9"
          onClick={() => setFont(Math.min(30, fontSize + 1))}
          title="Perbesar"
        >
          <ZoomIn className="size-4" />
        </Button>
        <Button
          variant="outline"
          size="icon"
          className="h-9 w-9"
          onClick={cycleTheme}
          title="Ganti tema baca (terang / kertas / malam)"
        >
          {theme === "dark" ? <Moon className="size-4" /> : <Sun className="size-4" />}
        </Button>
        {/* Stabilo teks */}
        <div className="flex items-center gap-1 px-1">
          {ANNO_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              aria-label={`Warna ${c}`}
              onClick={() => setHlColor(c)}
              className={cn(
                "size-5 rounded-full border-2",
                hlColor === c ? "border-foreground scale-110" : "border-transparent"
              )}
              style={{ backgroundColor: c }}
            />
          ))}
        </div>
        <Button
          variant="outline"
          size="icon"
          className="h-9 w-9"
          onClick={() => anno.undoTool("thl")}
          disabled={chapterMarks.length === 0}
          title="Urungkan stabilo terakhir"
        >
          <Undo2 className="size-4" />
        </Button>
        <Button
          variant="outline"
          size="icon"
          className="h-9 w-9"
          onClick={() => anno.clearTool("thl")}
          disabled={chapterMarks.length === 0}
          title="Hapus semua stabilo buku ini"
        >
          <Trash2 className="size-4" />
        </Button>
      </div>

      <div className="flex flex-1 min-h-0">
        {/* Daftar isi */}
        {tocOpen ? (
          <div className="w-60 shrink-0 border-r border-border overflow-auto bg-muted/30">
            {chapters.map((c, i) => (
              <button
                key={c.href}
                className={cn(
                  "block w-full text-left px-3 py-2 text-sm rounded-md m-1",
                  i === idx
                    ? "bg-primary/15 text-primary font-medium"
                    : "hover:bg-accent"
                )}
                onClick={() => {
                  setIdx(i);
                }}
              >
                <BookOpen className="inline size-3.5 mr-1.5 text-muted-foreground" />
                {c.title || `Bagian ${i + 1}`}
              </button>
            ))}
          </div>
        ) : null}

        {/* Isi bab — teks bisa diseleksi lalu distabilo / dibacakan / disalin */}
        <div
          ref={scrollRef}
          className="relative flex-1 min-h-0 overflow-auto select-text"
        >
          <div
            className={cn("min-h-full transition-colors", themeCls)}
            style={{ fontSize: `${fontSize}px`, lineHeight: 1.8 }}
          >
            <div
              ref={bodyRef}
              data-page={idx + 1}
              className="mx-auto max-w-2xl px-6 py-8 epub-body [&_h1]:text-2xl [&_h1]:font-bold [&_h1]:mt-6 [&_h1]:mb-3 [&_h2]:text-xl [&_h2]:font-semibold [&_h2]:mt-5 [&_h2]:mb-2 [&_h3]:text-lg [&_h3]:font-semibold [&_h3]:mt-4 [&_h3]:mb-2 [&_p]:my-3 [&_img]:max-w-full [&_img]:rounded-md [&_a]:underline [&_a]:text-blue-600 [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:list-decimal [&_ol]:pl-6 [&_blockquote]:border-l-4 [&_blockquote]:border-neutral-300 [&_blockquote]:pl-4 [&_blockquote]:italic [&_table]:w-full [&_table]:text-sm [&_td]:border [&_td]:p-1.5 [&_th]:border [&_th]:p-1.5 [&_th]:bg-neutral-200"
            />
          </div>
          {sel.menu ? (
            <SelectionToolbar
              menu={sel.menu}
              playing={sel.playing}
              onSpeak={sel.speak}
              onStopSpeak={sel.stopSpeak}
              onHighlight={sel.highlight}
              onCopy={(ok) =>
                ok ? toast.success("Teks tersalin") : toast.error("Gagal menyalin")
              }
              onClose={sel.closeMenu}
              activeColor={hlColor}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}
