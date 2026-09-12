"use client";

// ─────────────────────────────────────────────────────────────────────
// Markdown Teman AI (dipakai juga pratinjau .md).
// - remark-gfm: TABEL |…|, ~~coret~~, task list - [x], autolink —
//   tanpa ini semuanya tampil sebagai teks mentah (bug lama).
// - Aman: semua dirender sebagai React element (tanpa innerHTML).
// - Blok kode: label bahasa + tombol SALIN + tanpa "kotak dalam kotak"
//   (dulu: elemen <code> dapat latar chip padahal sudah di dalam <pre>).
// - Streaming: fence ``` yang belum tertutup otomatis ditutup sementara
//   supaya sisa jawaban tidak "ditelan" jadi kode mentah.
// ─────────────────────────────────────────────────────────────────────

import {
  memo,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, Copy } from "lucide-react";

/** Tutup fence ``` yang belum selesai (hanya saat streaming). */
function balanceFences(s: string): string {
  const fences = (s.match(/```/g) ?? []).length;
  // "```" tunggal yang dibuka lalu stream berhenti → jangan menghitung
  // triple-backtick di dalam teks inline code — cukup aproksimasi ganjil/genap.
  return fences % 2 === 1 ? s + "\n```" : s;
}

/** Ambil teks mentah dari tree React (dipakai tombol salin blok kode). */
function extractText(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractText).join("");
  const el = node as ReactElement<{ children?: ReactNode }>;
  return extractText(el.props?.children);
}

/** Bahasa dari className react-markdown ("language-python" → "python"). */
function langOf(node: ReactNode): string {
  const el = (Array.isArray(node) ? node[0] : node) as
    | ReactElement<{ className?: string }>
    | undefined;
  return /language-([\w+-]+)/.exec(el?.props?.className ?? "")?.[1] ?? "";
}

function CodeBlock({ text, lang }: { text: string; lang: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="my-2 min-w-0">
      <div className="flex items-center justify-between gap-2 rounded-t-md border border-b-0 border-border/70 bg-muted/60 px-3 py-1">
        <span className="text-[10px] font-mono text-muted-foreground truncate">
          {lang || "kode"}
        </span>
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
          className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
          aria-label="Salin kode"
        >
          {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
          {copied ? "Tersalin" : "Salin"}
        </button>
      </div>
      <pre className="overflow-x-auto rounded-b-md border border-border/70 bg-background/70 px-3 py-2 text-xs font-mono leading-relaxed whitespace-pre">
        {text}
      </pre>
    </div>
  );
}

/**
 * Render markdown jawaban AI. Memo per pesan: saat streaming, HANYA pesan
 * yang berubah yang di-parse ulang (dulu: seluruh riwayat di-render ulang
 * tiap chunk → chat panjang terasa berat).
 */
export const AiMarkdown = memo(function AiMarkdown({
  content,
  streaming = false,
}: {
  content: string;
  streaming?: boolean;
}) {
  const src = streaming ? balanceFences(content) : content;
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        p: (props) => <p className="leading-relaxed my-1.5" {...props} />,
        ul: (props) => (
          <ul className="list-disc pl-5 my-1.5 space-y-0.5" {...props} />
        ),
        ol: (props) => (
          <ol className="list-decimal pl-5 my-1.5 space-y-0.5" {...props} />
        ),
        li: (props) => <li className="pl-0.5 marker:text-muted-foreground" {...props} />,
        h1: (props) => <h1 className="text-base font-bold mt-2.5 mb-1" {...props} />,
        h2: (props) => <h2 className="text-sm font-bold mt-2.5 mb-1" {...props} />,
        h3: (props) => <h3 className="text-sm font-semibold mt-2 mb-1" {...props} />,
        h4: (props) => <h4 className="text-sm font-semibold mt-2 mb-1" {...props} />,
        blockquote: (props) => (
          <blockquote
            className="border-l-4 border-border pl-3 my-1.5 opacity-90"
            {...props}
          />
        ),
        // Blok kode: pre DIGANTI penuh (label + salin) → <code> di dalamnya
        // tidak ikut diberi gaya chip (tidak ada "kotak dalam kotak").
        pre: ({ children }) => (
          <CodeBlock text={extractText(children).replace(/\n$/, "")} lang={langOf(children)} />
        ),
        // Inline code saja (yang di dalam pre sudah digantikan di atas).
        code: (props) => (
          <code
            className="rounded bg-background/70 px-1 py-0.5 font-mono text-[13px]"
            {...props}
          />
        ),
        a: (props) => (
          <a
            className="underline underline-offset-2 break-all text-primary"
            target="_blank"
            rel="noopener noreferrer"
            {...props}
          />
        ),
        table: (props) => (
          <div className="overflow-x-auto my-2 max-w-full">
            <table className="text-xs border-collapse w-full" {...props} />
          </div>
        ),
        th: (props) => (
          <th
            className="border border-border px-2 py-1 bg-background/50 font-semibold text-left"
            {...props}
          />
        ),
        td: (props) => (
          <td className="border border-border px-2 py-1 align-top" {...props} />
        ),
        // Task list GFM (- [x]) → checkbox rapi.
        input: (props) => (
          <input
            {...props}
            className="mr-1.5 size-3 accent-primary align-middle"
          />
        ),
        hr: () => <hr className="my-3 border-border" />,
        img: (props) => (
          // eslint-disable-next-line @next/next/no-img-element
          <img {...props} className="max-w-full rounded-md my-1.5" alt={props.alt ?? ""} />
        ),
      }}
    >
      {src}
    </ReactMarkdown>
  );
});
