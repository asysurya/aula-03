// ── Ekstraksi teks dari lampiran materi (server-side) ──────────────────
// Dipakai endpoint upload /api/ai/attachments. File format APA PUN
// diterima; teksnya diambil best-effort:
//   PDF   → pdfjs-dist legacy (getTextContent per halaman)
//   DOCX  → mammoth (extractRawText)
//   XLSX/ODS → sheetjs (sheet_to_csv per lembar)
//   ZIP   → fflate (daftar isi + file teks di dalamnya)
//   teks  (txt/md/csv/json/kode/…& text/*) → decode utf-8
//   lain  (gambar/audio/video/biner) → "[berkas biner]" (nama+tipe+ukuran)
// Hasil di-cap per berkas supaya konteks AI tetap terkendali.

const MAX_TEXT_PER_FILE = 150_000; // karakter
const MAX_ZIP_ENTRIES = 40;
const MAX_ZIP_ENTRY_BYTES = 400_000;

export interface ExtractResult {
  kind: "PDF" | "DOCX" | "XLSX" | "ZIP" | "Teks" | "Biner";
  text: string;
}

/** Ekstensi berkas teks yang diterima langsung. */
const TEXT_EXTS = new Set([
  "txt", "md", "markdown", "csv", "tsv", "json", "jsonl", "ndjson", "xml",
  "yml", "yaml", "ini", "cfg", "conf", "env", "log", "srt", "vtt",
  "js", "mjs", "cjs", "ts", "tsx", "jsx", "css", "scss", "less",
  "html", "htm", "svg", "py", "rb", "go", "rs", "java", "kt", "kts",
  "c", "h", "cpp", "hpp", "cs", "php", "sh", "bash", "zsh", "sql",
  "r", "m", "swift", "dart", "lua", "pl", "vb", "asm", "tex", "bib",
]);

function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i < 0 ? "" : name.slice(i + 1).toLowerCase();
}

function cap(s: string): string {
  return s.length > MAX_TEXT_PER_FILE
    ? s.slice(0, MAX_TEXT_PER_FILE) + "\n…[dipotong — berkas terlalu panjang]"
    : s;
}

/** Heuristik: apakah buffer tampak seperti teks yang bisa dibaca. */
function looksTextual(buf: Buffer): boolean {
  const n = Math.min(buf.length, 4096);
  if (n === 0) return false;
  let printable = 0;
  for (let i = 0; i < n; i++) {
    const b = buf[i];
    // TAB/LF/CR + rentang cetak latin + sebagian UTF-8 multibyte (≥0xC0).
    if (b === 9 || b === 10 || b === 13 || (b >= 32 && b < 127) || b >= 0xc0)
      printable++;
  }
  return printable / n > 0.85;
}

export async function extractText(
  name: string,
  mime: string,
  buf: Buffer
): Promise<ExtractResult> {
  const ext = extOf(name);
  const m = (mime || "").toLowerCase();

  // ── PDF ──
  if (ext === "pdf" || m === "application/pdf") {
    try {
      const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
      const doc = await (
        pdfjs as unknown as {
          getDocument: (o: Record<string, unknown>) => {
            promise: Promise<{
              numPages: number;
              getPage: (n: number) => Promise<{
                getTextContent: () => Promise<{ items: Array<{ str?: string }> }>;
              }>;
            }>;
          };
        }
      ).getDocument({
        data: new Uint8Array(buf),
        isEvalSupported: false,
        disableFontFace: true,
        useSystemFonts: false,
      }).promise;
      let out = "";
      const pages = Math.min(doc.numPages, 200);
      for (let i = 1; i <= pages; i++) {
        const page = await doc.getPage(i);
        const tc = await page.getTextContent();
        out += tc.items.map((it) => it.str ?? "").join(" ") + "\n";
      }
      return { kind: "PDF", text: cap(out.trim()) };
    } catch {
      return { kind: "Biner", text: `[berkas PDF "${name}" tidak bisa dibaca]` };
    }
  }

  // ── DOCX ──
  if (
    ext === "docx" ||
    m === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  ) {
    try {
      const mammoth = (await import("mammoth")).default;
      const r = await mammoth.extractRawText({ buffer: buf });
      return { kind: "DOCX", text: cap(r.value.trim()) };
    } catch {
      return { kind: "Biner", text: `[berkas DOCX "${name}" tidak bisa dibaca]` };
    }
  }

  // ── XLSX / ODS ──
  if (
    ext === "xlsx" || ext === "ods" || ext === "xls" ||
    m.includes("spreadsheetml") || m === "application/vnd.oasis.opendocument.spreadsheet"
  ) {
    try {
      const XLSX = await import("xlsx");
      const wb = XLSX.read(buf, { type: "buffer" });
      const parts = wb.SheetNames.map((sn) => {
        const csv = XLSX.utils.sheet_to_csv(wb.Sheets[sn]);
        return `## Lembar: ${sn}\n${csv}`;
      });
      return { kind: "XLSX", text: cap(parts.join("\n\n").trim()) };
    } catch {
      return { kind: "Biner", text: `[berkas tabel "${name}" tidak bisa dibaca]` };
    }
  }

  // ── ZIP ──
  if (ext === "zip" || m === "application/zip" || m === "application/x-zip-compressed") {
    try {
      const { unzipSync, strFromU8 } = await import("fflate");
      const entries = unzipSync(new Uint8Array(buf));
      const names = Object.keys(entries).slice(0, MAX_ZIP_ENTRIES);
      const parts: string[] = [`[arsip ZIP berisi ${Object.keys(entries).length} berkas]`];
      for (const n of names) {
        if (entries[n].length > MAX_ZIP_ENTRY_BYTES) {
          parts.push(`--- ${n} (terlalu besar, dilewati) ---`);
          continue;
        }
        const e = extOf(n);
        if (TEXT_EXTS.has(e)) {
          try {
            parts.push(`--- ${n} ---\n${strFromU8(entries[n])}`);
          } catch {
            parts.push(`--- ${n} (gagal dibaca) ---`);
          }
        } else {
          parts.push(`--- ${n} (${e || "biner"}) ---`);
        }
      }
      return { kind: "ZIP", text: cap(parts.join("\n").trim()) };
    } catch {
      return { kind: "Biner", text: `[arsip ZIP "${name}" tidak bisa dibuka]` };
    }
  }

  // ── EPUB (zip berisi xhtml) ──
  if (ext === "epub" || m === "application/epub+zip") {
    try {
      const { unzipSync, strFromU8 } = await import("fflate");
      const entries = unzipSync(new Uint8Array(buf));
      const parts: string[] = [];
      for (const n of Object.keys(entries).slice(0, MAX_ZIP_ENTRIES)) {
        if (!n.endsWith(".xhtml") && !n.endsWith(".html") && !n.endsWith(".htm")) continue;
        if (entries[n].length > MAX_ZIP_ENTRY_BYTES) continue;
        const html = strFromU8(entries[n]);
        parts.push(html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
      }
      return { kind: "ZIP", text: cap(parts.join("\n\n").trim()) };
    } catch {
      return { kind: "Biner", text: `[berkas EPUB "${name}" tidak bisa dibuka]` };
    }
  }

  // ── Teks langsung ──
  if (TEXT_EXTS.has(ext) || m.startsWith("text/") || m === "application/json") {
    const text = buf.toString("utf8");
    return { kind: "Teks", text: cap(text) };
  }

  // ── Fallback: coba deteksi teks ──
  if (looksTextual(buf)) {
    return { kind: "Teks", text: cap(buf.toString("utf8")) };
  }

  return {
    kind: "Biner",
    text: `[berkas biner "${name}"${mime ? ` (${mime})` : ""}, ${buf.length} byte — teks tidak bisa dibaca]`,
  };
}
