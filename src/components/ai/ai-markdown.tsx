"use client";

// ─────────────────────────────────────────────────────────────────────
// Markdown Teman AI (dipakai juga pratinjau .md).
// - remark-gfm: TABEL |…|, ~~coret~~, task list - [x], autolink —
//   tanpa ini semuanya tampil sebagai teks mentah (bug lama).
// - remark-math + rehype-katex: RUMUS ($…$ inline, $$…$$ tampil) —
//   model disuruh menulis LaTeX; rumus polos ala "V_p I_p = V_s I_s"
//   otomatis dibungkus $…$ oleh preprocessor (Task 29).
// - Aman: semua dirender sebagai React element (tanpa innerHTML).
// - Blok kode: label bahasa + tombol SALIN + tanpa "kotak dalam kotak".
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
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { Check, Copy } from "lucide-react";
import "katex/dist/katex.min.css";

/** Tutup fence ``` yang belum selesai (hanya saat streaming). */
function balanceFences(s: string): string {
  const fences = (s.match(/```/g) ?? []).length;
  // "```" tunggal yang dibuka lalu stream berhenti → jangan menghitung
  // triple-backtick di dalam teks inline code — cukup aproksimasi ganjil/genap.
  return fences % 2 === 1 ? s + "\n```" : s;
}

/** Tutup $$…$$ yang belum selesai (hanya saat streaming). */
function balanceMath(s: string): string {
  const n = (s.match(/\$\$/g) ?? []).length;
  return n % 2 === 1 ? s + "\n$$" : s;
}

// ── Preprocessor rumus polos → LaTeX ─────────────────────────────────
// Model kadang tetap menulis rumus tanpa tanda $ (mis. "V_p I_p = V_s I_s"
// atau "x^2 + 2x + 1 = 0"). Deteksi konservatif:
//   token sub/superskrip = 1 karakter + _ atau ^ + 1-2 karakter lalu
//   batas kata (menolak snake_case/identifier panjang seperti file_name).
//   segmen dibungkus $…$ bila: ≥2 token, ATAU 1 token + operator
//   matematika (= + - ± × ÷ · / ≈ ≤ ≥) — dan bukan kode/URL.
const SUBSUP_TOKEN = /[A-Za-z0-9)\]}][_^][A-Za-z0-9]{1,2}(?![A-Za-z0-9])/g;
const MATH_OP = /[=+\-−±×÷·≈≤≥^]/;

function countSubsupTokens(text: string): number {
  const m = text.match(SUBSUP_TOKEN);
  return m ? m.length : 0;
}

/** Bungkus bagian baris yang tampak seperti rumus dengan $…$ (per kata). */
function wrapBareFormulas(text: string): string {
  if (!text || text.includes("$")) return text; // sudah ada LaTeX — jangan ganggu
  if (!/[_^]/.test(text)) return text;
  return text
    .split("\n")
    .map((line) => {
      if (!/[_^]/.test(line) || line.includes("$")) return line;

      // pecah baris jadi kata + pemisah (spasi dipertahankan)
      const rawParts = line.split(/(\s+)/);
      type W = { text: string; token: boolean; op: boolean; block: boolean; numeric: boolean };
      const words: W[] = rawParts
        .filter((p) => p.length > 0 && !/^\s+$/.test(p))
        .map((w) => {
          const clean = w.replace(/^[([{"'“—-]+|[)\]}"'”.,;:!?-]+$/g, "");
          const block =
            clean.includes("://") || /^(https?:|www\.|data:)/i.test(clean);
          return {
            text: w,
            token: !block && countSubsupTokens(clean) > 0,
            op: !block && MATH_OP.test(clean),
            block,
            numeric: /^[0-9][0-9.,%°]*$/.test(clean),
          };
        });

      const interesting = (w: W) => w.token || w.op;
      let out = "";
      let i = 0;
      const n = words.length;
      while (i < n) {
        if (!interesting(words[i])) {
          out += words[i].text + " ";
          i++;
          continue;
        }
        // cluster: dari kata menarik pertama sampai terakhir, blok URL
        // / kata prosa murni (>2 huruf a-z tanpa angka/op) memutus cluster.
        let j = i;
        let last = i;
        for (let k = i + 1; k < n; k++) {
          const w = words[k];
          if (w.block) break;
          if (interesting(w)) {
            last = k;
            j = k;
            continue;
          }
          // kata interior: numerik / pendek → masih bagian rumus; prosa
          // murni panjang → putus.
          if (w.numeric || /^[a-zA-Z]{1,2}$/.test(w.text.replace(/[^\w]/g, ""))) {
            continue;
          }
          break;
        }
        // perluas ke numerik tepian (mis. "= 220" di "V_p = 220 V")
        let end = last;
        while (end + 1 < n && words[end + 1].numeric) end++;
        let start = i;
        while (start - 1 >= 0 && words[start - 1].numeric) start--;

        const cluster = words.slice(start, end + 1);
        const tokenCount = cluster.filter((w) => w.token).length;
        const hasOp = cluster.some((w) => w.op);
        const joined = cluster.map((w) => w.text).join(" ");
        const isShort = joined.length <= 200;
        if (tokenCount >= 1 && (tokenCount >= 2 || hasOp) && isShort) {
          out += `$${joined}$ `;
        } else {
          out += joined + " ";
        }
        i = end + 1;
      }
      return out.replace(/[ ]+$/g, "").replace(/[ ]{2,}/g, " ");
    })
    .join("\n");
}

/**
 * Preprocess konten markdown: bungkus rumus polos menjadi LaTeX.
 * Blok kode ``` … ``` dan inline code ` … ` DILEWATI (jangan sentuh kode).
 */
export function preprocessMath(content: string): string {
  if (!content || !/[_^]/.test(content)) return content;
  const parts = content.split(/(```[\s\S]*?```|`[^`\n]*`)/g);
  return parts
    .map((p, i) => (i % 2 === 1 ? p : wrapBareFormulas(p)))
    .join("");
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
  let src = content;
  if (streaming) src = balanceMath(balanceFences(src));
  src = preprocessMath(src);
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[
        [
          rehypeKatex,
          { throwOnError: false, strict: false, errorColor: "#cc0000", output: "htmlAndMathml" },
        ],
      ]}
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
