"use client";

// ─────────────────────────────────────────────────────────────────────
// Markdown Discord-style untuk isi pesan chat.
// Aman: SEMUA teks dirender sebagai React element (tanpa
// dangerouslySetInnerHTML) — tidak mungkin XSS dari teks pesan.
//
// Didukung: **tebal**, *miring*, _miring_, __garis bawah__, ~~coret~~,
// ||spoiler||, `kode`, blok kode ```, kutipan >, heading #/##/###,
// daftar -/*, tautan otomatis (http/https), [label](url), dan sebutan
// anggota @username (chip highlight).
// Klik tautan SELALU minta konfirmasi dulu (anti-phishing).
// ─────────────────────────────────────────────────────────────────────

import { useMemo, useState, type ReactNode } from "react";
import { Check, Copy, ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

// ── Inline AST ──────────────────────────────────────────────────────

type InlineNode =
  | { t: "text"; v: string }
  | { t: "bold"; c: InlineNode[] }
  | { t: "italic"; c: InlineNode[] }
  | { t: "underline"; c: InlineNode[] }
  | { t: "strike"; c: InlineNode[] }
  | { t: "spoiler"; c: InlineNode[] }
  | { t: "code"; v: string }
  | { t: "mention"; v: string }
  | { t: "link"; url: string; label: string }
  | { t: "url"; url: string };

const AUTOLINK_RE = /^https?:\/\/[^\s<>"'`]+/;

// Sebutan anggota @username — hanya di luar kode (inline/fenced) dan URL:
// kedua bentuk itu sudah dikonsumsi atomik oleh cabang `code`/`link`/
// `url` di bawah sebelum teks biasa diproses, jadi @ di dalamnya tidak
// pernah sampai ke pemeriksaan ini.
const MENTION_AFTER_SPACE_RE = /^([\s(])@([a-zA-Z0-9_.]{2,24})/;
const MENTION_AT_START_RE = /^@([a-zA-Z0-9_.]{2,24})/;

/** Buang tanda baca yang biasa "nempel" di ujung URL hasil copy. */
function trimTrailingPunct(url: string): string {
  return url.replace(/[.,;:!?)\]]+$/, "");
}

function findClose(text: string, from: number, close: string): number {
  let idx = text.indexOf(close, from);
  while (idx !== -1) {
    if (idx > from) return idx; // konten tidak kosong
    idx = text.indexOf(close, idx + 1);
  }
  return -1;
}

const DELIMS: {
  open: string;
  close: string;
  t: "bold" | "underline" | "strike" | "spoiler" | "italic";
}[] = [
  { open: "**", close: "**", t: "bold" },
  { open: "__", close: "__", t: "underline" },
  { open: "~~", close: "~~", t: "strike" },
  { open: "||", close: "||", t: "spoiler" },
  { open: "*", close: "*", t: "italic" },
  { open: "_", close: "_", t: "italic" },
];

function parseInline(text: string): InlineNode[] {
  const out: InlineNode[] = [];
  let buf = "";
  let i = 0;
  const flush = () => {
    if (buf) {
      out.push({ t: "text", v: buf });
      buf = "";
    }
  };

  while (i < text.length) {
    const rest = text.slice(i);

    // `kode inline` — satu baris saja
    if (rest.startsWith("`")) {
      const end = text.indexOf("`", i + 1);
      const content = end > i + 1 ? text.slice(i + 1, end) : null;
      if (content !== null && !content.includes("\n")) {
        flush();
        out.push({ t: "code", v: content });
        i = end + 1;
        continue;
      }
    }

    // [label](url) — tautan berlabel
    const link = /^\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/.exec(rest);
    if (link) {
      flush();
      out.push({ t: "link", url: link[2], label: link[1] });
      i += link[0].length;
      continue;
    }

    // tautan otomatis
    const auto = AUTOLINK_RE.exec(rest);
    if (auto) {
      flush();
      const url = trimTrailingPunct(auto[0]);
      out.push({ t: "url", url });
      i += url.length;
      continue;
    }

    // @username — sebutan anggota (didahului spasi/"(" atau di awal
    // fragmen). Regex {2,24} sesuai spek; karakter di luar kelas
    // (mis. koma/titik-akhir) otomatis menghentikan nama.
    const men = MENTION_AFTER_SPACE_RE.exec(rest);
    if (men) {
      flush();
      out.push({ t: "text", v: men[1] });
      out.push({ t: "mention", v: men[2] });
      i += men[0].length;
      continue;
    }
    if (i === 0) {
      const menStart = MENTION_AT_START_RE.exec(rest);
      if (menStart) {
        flush();
        out.push({ t: "mention", v: menStart[1] });
        i += menStart[0].length;
        continue;
      }
    }

    // pasangan delimiter (tebal/garis bawah/coret/spoiler/miring)
    let matched = false;
    for (const d of DELIMS) {
      if (rest.startsWith(d.open)) {
        const closeIdx = findClose(text, i + d.open.length, d.close);
        if (closeIdx > i + d.open.length) {
          flush();
          out.push({
            t: d.t,
            c: parseInline(text.slice(i + d.open.length, closeIdx)),
          });
          i = closeIdx + d.close.length;
          matched = true;
          break;
        }
      }
    }
    if (matched) continue;

    buf += text[i];
    i++;
  }
  flush();
  return out;
}

// ── Block AST ───────────────────────────────────────────────────────

type Block =
  | { t: "para"; nodes: InlineNode[] }
  | { t: "code"; text: string }
  | { t: "quote"; blocks: Block[] }
  | { t: "heading"; level: 1 | 2 | 3; nodes: InlineNode[] }
  | { t: "list"; items: InlineNode[][] };

function parseBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  const lines = text.split("\n");
  let i = 0;

  const isSpecialLine = (s: string) =>
    /^```/.test(s.trim()) ||
    /^>\s?/.test(s) ||
    /^#{1,3}\s+/.test(s) ||
    /^[-*]\s+/.test(s);

  while (i < lines.length) {
    const line = lines[i];

    // blok kode ```
    const fence = /^```(\w*)\s*$/.exec(line.trim());
    if (fence) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && lines[i].trim() !== "```") {
        buf.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++; // lewati penutup fence
      blocks.push({ t: "code", text: buf.join("\n") });
      continue;
    }

    // kutipan >
    if (/^>\s?/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^>\s?/, ""));
        i++;
      }
      blocks.push({ t: "quote", blocks: parseBlocks(buf.join("\n")) });
      continue;
    }

    // heading # ## ###
    const h = /^(#{1,3})\s+(.+)$/.exec(line);
    if (h) {
      blocks.push({
        t: "heading",
        level: h[1].length as 1 | 2 | 3,
        nodes: parseInline(h[2]),
      });
      i++;
      continue;
    }

    // daftar - / *
    if (/^[-*]\s+/.test(line)) {
      const items: InlineNode[][] = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i])) {
        items.push(parseInline(lines[i].replace(/^[-*]\s+/, "")));
        i++;
      }
      blocks.push({ t: "list", items });
      continue;
    }

    // baris kosong
    if (!line.trim()) {
      i++;
      continue;
    }

    // paragraf — gabung baris biasa berurutan
    const buf: string[] = [];
    while (i < lines.length && lines[i].trim() !== "" && !isSpecialLine(lines[i])) {
      buf.push(lines[i]);
      i++;
    }
    blocks.push({ t: "para", nodes: parseInline(buf.join("\n")) });
  }

  return blocks;
}

// ── Renderers ───────────────────────────────────────────────────────

function renderNodes(nodes: InlineNode[]): ReactNode {
  return nodes.map((n, i) => <InlineView key={i} node={n} />);
}

/** Spoiler — klik untuk buka/tutup (Discord style). */
function Spoiler({ children }: { children: ReactNode }) {
  const [shown, setShown] = useState(false);
  return (
    <button
      type="button"
      onClick={() => setShown((s) => !s)}
      aria-label={shown ? "Sembunyikan spoiler" : "Tampilkan spoiler"}
      title={shown ? "Klik untuk menyembunyikan" : "Klik untuk melihat"}
      className={cn(
        "rounded px-1 transition-colors",
        shown
          ? "bg-muted/70 text-foreground/95"
          : "bg-foreground/85 text-transparent select-none hover:bg-foreground/75"
      )}
    >
      {children}
    </button>
  );
}

/** Tautan — KLIK SELALU KONFIRMASI dulu sebelum dibuka (anti-phishing). */
function LinkWithConfirm({
  url,
  children,
}: {
  url: string;
  children: ReactNode;
}) {
  const [ask, setAsk] = useState(false);
  let host = url;
  try {
    host = new URL(url).host;
  } catch {
    /* keep raw */
  }
  return (
    <>
      <button
        type="button"
        onClick={() => setAsk(true)}
        className="text-primary underline underline-offset-2 break-all text-left hover:opacity-80 transition-opacity"
        title={`Buka tautan: ${url}`}
      >
        {children}
      </button>
      <Dialog open={ask} onOpenChange={setAsk}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ExternalLink className="size-4 shrink-0" /> Buka tautan ini?
            </DialogTitle>
            <DialogDescription className="break-all pt-1">
              Tautan akan dibuka di tab baru:
              <br />
              <span className="font-medium text-foreground/90 break-all">
                {url.length > 200 ? `${url.slice(0, 200)}…` : url}
              </span>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAsk(false)}>
              Batal
            </Button>
            <Button
              onClick={() => {
                setAsk(false);
                window.open(url, "_blank", "noopener,noreferrer");
              }}
            >
              <ExternalLink className="size-4 mr-1" /> Buka dari {host}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Blok kode dengan tombol salin. */
function CodeBlock({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="relative group/code my-1">
      <pre className="rounded-md border border-border/60 bg-muted/70 px-3 py-2 text-xs font-mono overflow-x-auto whitespace-pre text-foreground/90">
        {text}
      </pre>
      <button
        type="button"
        onClick={() => {
          navigator.clipboard
            .writeText(text)
            .then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            })
            .catch(() => {
              /* abaikan */
            });
        }}
        className="absolute top-1.5 right-1.5 inline-flex items-center gap-1 rounded border border-border bg-background/85 px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
        aria-label="Salin kode"
      >
        {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
        {copied ? "Tersalin" : "Salin"}
      </button>
    </div>
  );
}

function InlineView({ node }: { node: InlineNode }) {
  switch (node.t) {
    case "text":
      return <>{node.v}</>;
    case "bold":
      return <strong className="font-semibold">{renderNodes(node.c)}</strong>;
    case "italic":
      return <em>{renderNodes(node.c)}</em>;
    case "underline":
      return <u className="underline underline-offset-2">{renderNodes(node.c)}</u>;
    case "strike":
      return <s className="line-through opacity-80">{renderNodes(node.c)}</s>;
    case "spoiler":
      return <Spoiler>{renderNodes(node.c)}</Spoiler>;
    case "code":
      return (
        <code className="rounded bg-muted px-1 py-0.5 font-mono text-[13px] text-foreground/90 break-all">
          {node.v}
        </code>
      );
    case "mention":
      return (
        <span className="rounded bg-primary/15 px-1 font-medium text-primary">
          @{node.v}
        </span>
      );
    case "link":
      return <LinkWithConfirm url={node.url}>{node.label}</LinkWithConfirm>;
    case "url": {
      const display =
        node.url.length > 48 ? `${node.url.slice(0, 45)}…` : node.url;
      return <LinkWithConfirm url={node.url}>{display}</LinkWithConfirm>;
    }
  }
}

function BlockView({ block }: { block: Block }) {
  switch (block.t) {
    case "para":
      return (
        <p className="whitespace-pre-wrap break-words leading-snug">
          {renderNodes(block.nodes)}
        </p>
      );
    case "code":
      return <CodeBlock text={block.text} />;
    case "quote":
      return (
        <blockquote className="border-l-4 border-border pl-3 my-1 space-y-1">
          {block.blocks.map((b, i) => (
            <BlockView key={i} block={b} />
          ))}
        </blockquote>
      );
    case "heading": {
      const cls =
        block.level === 1
          ? "text-lg font-bold mt-1"
          : block.level === 2
            ? "text-base font-bold mt-1"
            : "text-sm font-bold mt-0.5";
      return <div className={cls}>{renderNodes(block.nodes)}</div>;
    }
    case "list":
      return (
        <ul className="list-disc pl-5 my-1 space-y-0.5">
          {block.items.map((it, i) => (
            <li key={i} className="whitespace-pre-wrap break-words">
              {renderNodes(it)}
            </li>
          ))}
        </ul>
      );
  }
}

/**
 * Render teks pesan dengan markdown Discord-style.
 * Semua karakter dianggap teks biasa — aman dari XSS.
 */
export function MarkdownText({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  const blocks = useMemo(() => parseBlocks(text), [text]);
  return (
    <div className={cn("text-sm text-foreground/95 min-w-0", className)}>
      {blocks.map((b, i) => (
        <BlockView key={i} block={b} />
      ))}
    </div>
  );
}
