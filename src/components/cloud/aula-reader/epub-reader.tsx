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
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { useSelectionMenu, SelectionToolbar } from "./selection-actions";
import type { OfficeCacheEntry } from "@/components/cloud/buffer-loader";

// ─────────────────────────────────────────────────────────────────────────
// Aula Reader — EPUB (buku digital).
// Unzip → container.xml → OPF → urutan baca (spine) → render bab per bab
// (XHTML disanitasi: script/iframe/object dibuang; gambar di-embed dari
// dalam zip). Navigasi bab, daftar isi, ukuran font.
// ─────────────────────────────────────────────────────────────────────────

interface SpineItem {
  href: string;
  title: string;
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
  const [fontSize, setFontSize] = useState(17);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Menu aksi teks terpilih (Bacakan / Salin) di isi bab.
  const sel = useSelectionMenu({ containerRef: scrollRef });

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
        const titles = new Map<string, string>();
        // docProps judul per file (opsional) — pakai <title> tiap bab saat render.
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

  // Render bab aktif.
  useEffect(() => {
    if (!current || !zipFiles) return;
    let cancelled = false;
    (async () => {
      const raw = zipFiles.get(current.href);
      if (!raw) return;
      const { strFromU8 } = await import("fflate");
      const doc = new DOMParser().parseFromString(
        strFromU8(raw),
        "application/xhtml+xml"
      );
      // Sanitasi.
      doc
        .querySelectorAll("script, iframe, object, embed, link, meta[http-equiv]")
        .forEach((el) => el.remove());
      doc.querySelectorAll("*").forEach((el) => {
        [...el.attributes].forEach((attr) => {
          if (/^on/i.test(attr.name)) el.removeAttribute(attr.name);
        });
      });
      // Gambar → data URL dari zip.
      const imgs = doc.querySelectorAll("img");
      for (const img of imgs) {
        const src = img.getAttribute("src");
        if (!src) continue;
        const path = new URL(src, "http://x/" + current.href).pathname.slice(1);
        const data = zipFiles.get(path) ?? zipFiles.get(src);
        if (data) {
          const e = path.split(".").pop()?.toLowerCase() ?? "jpg";
          const mime =
            e === "png"
              ? "image/png"
              : e === "gif"
              ? "image/gif"
              : e === "svg"
              ? "image/svg+xml"
              : "image/jpeg";
          img.setAttribute(
            "src",
            `data:${mime};base64,${btoa(String.fromCharCode(...data.subarray(0, 3_000_000)))}`
          );
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
    })();
    return () => {
      cancelled = true;
    };
  }, [current, zipFiles, idx]);

  function go(delta: number) {
    if (!chapters) return;
    const next = Math.min(chapters.length - 1, Math.max(0, idx + delta));
    setIdx(next);
  }

  const chapterTitle = useMemo(
    () => chapters?.[idx]?.title || `Bagian ${idx + 1}`,
    [chapters, idx]
  );

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
          onClick={() => setFontSize((s) => Math.max(12, s - 1))}
          title="Perkecil"
        >
          <ZoomOut className="size-4" />
        </Button>
        <Button
          variant="outline"
          size="icon"
          className="h-9 w-9"
          onClick={() => setFontSize((s) => Math.min(30, s + 1))}
          title="Perbesar"
        >
          <ZoomIn className="size-4" />
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

        {/* Isi bab — teks bisa diseleksi lalu dibacakan / disalin */}
        <div ref={scrollRef} className="relative flex-1 min-h-0 overflow-auto bg-[#f7f2e7]">
          <div
            className="mx-auto max-w-2xl px-6 py-8 text-neutral-800 prose-sm select-text"
            style={{ fontSize: `${fontSize}px`, lineHeight: 1.8 }}
          >
            <div
              className="epub-body [&_h1]:text-2xl [&_h1]:font-bold [&_h1]:mt-6 [&_h1]:mb-3 [&_h2]:text-xl [&_h2]:font-semibold [&_h2]:mt-5 [&_h2]:mb-2 [&_h3]:text-lg [&_h3]:font-semibold [&_h3]:mt-4 [&_h3]:mb-2 [&_p]:my-3 [&_img]:max-w-full [&_img]:rounded-md [&_a]:text-blue-600 [&_a]:underline [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:list-decimal [&_ol]:pl-6 [&_blockquote]:border-l-4 [&_blockquote]:border-neutral-300 [&_blockquote]:pl-4 [&_blockquote]:italic [&_table]:w-full [&_table]:text-sm [&_td]:border [&_td]:p-1.5 [&_th]:border [&_th]:p-1.5 [&_th]:bg-neutral-200"
              dangerouslySetInnerHTML={{ __html: html }}
            />
          </div>
          {sel.menu ? (
            <SelectionToolbar
              menu={sel.menu}
              playing={sel.playing}
              onSpeak={sel.speak}
              onStopSpeak={sel.stopSpeak}
              onCopy={(ok) =>
                ok ? toast.success("Teks tersalin") : toast.error("Gagal menyalin")
              }
              onClose={sel.closeMenu}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}
