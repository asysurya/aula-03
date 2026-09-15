"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  Download,
  Loader2,
  FileWarning,
  FileArchive,
  FileText,
  Copy,
  Check,
  Maximize2,
  Minimize2,
  PictureInPicture2,
  ExternalLink,
  BookOpenText,
  Monitor,
  HardDriveDownload,
  X,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AiMarkdown } from "@/components/ai/ai-markdown";
import { filePublicUrl } from "@/lib/file-constants";
import { formatBytes, type CloudFileItem } from "@/lib/cloud-format";
import {
  keepReaderFile,
  unkeepReaderFile,
  isKeptReaderFile,
} from "@/lib/reader-file-cache";
import { useTransferStore } from "@/lib/transfer-store";
import { usePreviewStore } from "@/stores/preview-store";
import {
  classify as classifyKind,
  ext as fileExt,
  docxHtmlCache,
  xlsxSheetsCache,
  useOfficeBuffer,
  formatSpeed,
  type FetchProgress,
  type OfficeCacheEntry,
  type PreviewKind,
} from "./buffer-loader";
import type { PreviewMode } from "./aula-reader/mode-chooser";

function classify(mime: string, name: string): PreviewKind {
  return classifyKind(mime, name);
}

function ext(name: string): string {
  return fileExt(name);
}

// ───────────────────────── Component utama ─────────────────────────

// FilePreview kini HANYA ADAPTER menuju registry global pratinjau
// (preview-store + preview-layer). Tanda tangan komponen dipertahankan
// agar semua host (file-browser, mega-mount, form-review, assignment-
// detail) tidak perlu diubah:
//   <FilePreview file={x} onClose={...} />
// - file berubah → daftarkan/fokuskan pratinjau di store (maks 3, lebih
//   dari itu yang terlama ditutup otomatis + toast).
// - pratinjau ditutup/dievict dari store → panggil onClose host.
// - MINIMIZE BUKAN onClose: entri tetap hidup di store sebagai kartu
//   PiP (video/audio tetap berjalan) — host tidak diberitahu.
export function FilePreview({
  file,
  onClose,
}: {
  file: CloudFileItem | null;
  onClose: () => void;
}) {
  const openPreview = usePreviewStore((s) => s.openPreview);
  const entries = usePreviewStore((s) => s.entries);
  const lastKey = useRef<string | null>(null);

  // Host membuka file (file berubah null → item) → daftarkan ke registry.
  useEffect(() => {
    if (file && lastKey.current !== file.storageKey) {
      lastKey.current = file.storageKey;
      openPreview(file);
    }
    if (!file) lastKey.current = null;
  }, [file, openPreview]);

  // Pratinjau ditutup dari jendelanya (atau di-evict karena buka ke-4)
  // → beri tahu host. Bukan sebaliknya: menutup via host (onClose) cukup
  // mengosongkan state host; entri store sudah tidak ada.
  const registered =
    file !== null && entries.some((e) => e.id === file.storageKey);
  useEffect(() => {
    if (!file || lastKey.current !== file.storageKey) return;
    if (!registered) {
      lastKey.current = null;
      onClose();
    }
  }, [file, registered, onClose]);

  // Tidak ada DOM yang dirender adapter — semua UI ada di PreviewLayer.
  return null;
}

// Header dipakai oleh PreviewLayer (bukan lagi dialog Radix) → elemen
// HTML biasa; DialogTitle/DialogDescription diganti h2/p dengan styling
// sama persis.
export function PreviewHeader({
  file,
  mode,
  onSetMode,
  onResetMode,
  isFullscreen,
  onToggleFullscreen,
  onMinimize,
  onClose,
}: {
  file: CloudFileItem;
  mode: PreviewMode;
  onSetMode: (m: "aula" | "native", always: boolean) => void;
  onResetMode: () => void;
  isFullscreen: boolean;
  onToggleFullscreen: () => void;
  onMinimize: () => void;
  onClose: () => void;
}) {
  const enqueueDownload = useTransferStore((s) => s.enqueueDownload);
  // File MEGA mentah (mount) butuh ?name= agar server tahu nama + mimetype.
  const url =
    filePublicUrl(file.storageKey) +
    (file.raw ? `?name=${encodeURIComponent(file.name)}` : "");

  // Tombol cache: simpan file di perangkat (buka ulang tanpa unduh) atau
  // batalkan simpanan. Status mengikuti daftar keep di localStorage.
  const [keptOffline, setKeptOffline] = useState(() =>
    isKeptReaderFile(file.storageKey)
  );
  useEffect(() => {
    setKeptOffline(isKeptReaderFile(file.storageKey));
  }, [file.storageKey]);

  function toggleKeepOffline() {
    if (isKeptReaderFile(file.storageKey)) {
      unkeepReaderFile(file.storageKey);
      setKeptOffline(false);
      toast.info(
        "Simpanan dibatalkan — file akan dihapus dari perangkat saat pratinjau ditutup."
      );
    } else {
      keepReaderFile(file.storageKey);
      setKeptOffline(true);
      toast.success(
        "File disimpan — membuka lagi tanpa mengunduh ulang."
      );
    }
  }

  return (
    <div
      className={`relative flex items-start gap-3 pr-12 px-4 py-3 border-b border-border bg-background ${
        isFullscreen ? "bg-black/80 border-black" : ""
      }`}
    >
      <div className="min-w-0 flex-1">
        <h2
          className={`truncate text-base font-semibold leading-none tracking-tight ${
            isFullscreen ? "text-white" : ""
          }`}
          title={file.name}
        >
          {file.name}
        </h2>
        <p className="flex items-center gap-2 flex-wrap mt-1 text-sm text-muted-foreground">
          <Badge variant="outline" className="font-mono text-[10px]">
            {file.mimetype || "tidak diketahui"}
          </Badge>
          <span className={`text-xs ${isFullscreen ? "text-white/70" : ""}`}>
            {formatBytes(file.size)}
          </span>
          {file.uploader ? (
            <span className={`text-xs ${isFullscreen ? "text-white/70" : ""}`}>
              · oleh {file.uploader.name}
            </span>
          ) : null}
        </p>
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
        {/* Pemilih mode pratinjau */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              size="sm"
              variant="outline"
              className="gap-1.5"
              title="Ganti cara menampilkan pratinjau"
            >
              {mode === "aula" ? (
                <BookOpenText className="size-4 text-primary" />
              ) : (
                <Monitor className="size-4" />
              )}
              <span className="hidden sm:inline">
                {mode === "aula"
                  ? "Aula Reader"
                  : mode === "native"
                  ? "Bawaan"
                  : "Mode"}
              </span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-64">
            <DropdownMenuLabel>Cara menampilkan pratinjau</DropdownMenuLabel>
            <DropdownMenuItem
              onClick={() => onSetMode("aula", true)}
              className={mode === "aula" ? "bg-accent" : ""}
            >
              <BookOpenText className="size-4" /> Aula Reader
              <span className="ml-auto text-[10px] text-muted-foreground">
                selalu
              </span>
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => onSetMode("native", true)}
              className={mode === "native" ? "bg-accent" : ""}
            >
              <Monitor className="size-4" /> Pratinjau Bawaan
              <span className="ml-auto text-[10px] text-muted-foreground">
                selalu
              </span>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => {
                onResetMode();
              }}
            >
              Tanya setiap kali file dibuka
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        {/* Minimize → kartu PiP mengambang (video/audio tetap berjalan) */}
        <Button
          size="sm"
          variant="outline"
          className="gap-1.5"
          onClick={onMinimize}
          title="Perkecil menjadi PiP mengambang"
        >
          <PictureInPicture2 className="size-4" />
          <span className="hidden sm:inline">PiP</span>
        </Button>
        {/* Cache: simpan file di perangkat (hanya relevan di Aula Reader —
            file PDF/EPUB/dokumen yang memang diunduh ke cache browser). */}
        {mode === "aula" ? (
          <Button
            size="sm"
            variant={keptOffline ? "secondary" : "outline"}
            className="gap-1.5"
            onClick={toggleKeepOffline}
            title={
              keptOffline
                ? "File tersimpan di perangkat — klik untuk batal menyimpan"
                : "Simpan di perangkat — buka lagi tanpa mengunduh ulang"
            }
            aria-label={
              keptOffline
                ? "Batalkan simpan file di perangkat"
                : "Simpan file di perangkat"
            }
          >
            <HardDriveDownload className="size-4" />
            <span className="hidden sm:inline">
              {keptOffline ? "Tersimpan" : "Simpan offline"}
            </span>
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="outline"
          className="gap-1.5"
          onClick={onToggleFullscreen}
          title="Layar penuh (F)"
        >
          {isFullscreen ? (
            <Minimize2 className="size-4" />
          ) : (
            <Maximize2 className="size-4" />
          )}
          <span className="hidden sm:inline">
            {isFullscreen ? "Keluar Layar Penuh" : "Layar Penuh"}
          </span>
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="gap-1.5"
          onClick={() => window.open(url, "_blank", "noopener")}
          title="Buka di tab baru"
        >
          <ExternalLink className="size-4" />
          <span className="hidden sm:inline">Tab Baru</span>
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="gap-1.5"
          onClick={() => {
            // Unduhan berjalan di latar belakang via Manajer Transfer
            // (pause/cancel/progress tiap 2 detik) — dialog tetap terbuka.
            enqueueDownload({
              url: `${url}${url.includes("?") ? "&" : "?"}download=1`,
              name: file.name,
              size: file.size,
              context: file.raw ? "Mount MEGA" : "Pratinjau",
              autoSave: true,
            });
            toast.info(
              `Mengunduh "${file.name}" di latar belakang — pantau di tombol Transfer.`
            );
          }}
          title="Unduh (berjalan di latar belakang)"
        >
          <Download className="size-4" /> Unduh
        </Button>
        {/* Tombol tutup X — aksesibilitas sentuh/remote (dulu hanya Esc &
            klik overlay; pengguna layar sentuh tidak punya tombol terlihat). */}
        <Button
          size="icon"
          variant="ghost"
          className="absolute right-2 top-2 size-8 hover:text-destructive"
          onClick={onClose}
          title="Tutup pratinjau"
          aria-label="Tutup pratinjau"
        >
          <X className="size-4" />
        </Button>
      </div>
    </div>
  );
}

// ───────────────────────── Body dispatcher ─────────────────────────

export function PreviewBody({
  file,
  fullscreen,
}: {
  file: CloudFileItem;
  fullscreen: boolean;
}) {
  const kind = classify(file.mimetype, file.name);
  // File MEGA mentah (mount) butuh ?name= agar server tahu nama + mimetype.
  const url =
    filePublicUrl(file.storageKey) +
    (file.raw ? `?name=${encodeURIComponent(file.name)}` : "");

  switch (kind) {
    case "image":
      return (
        <div className="flex items-center justify-center p-4 h-full min-h-[40vh]">
          <img
            src={url}
            alt={file.name}
            className={`object-contain rounded-md shadow-sm ${
              fullscreen ? "max-h-full max-w-full" : "max-w-full max-h-[70vh]"
            }`}
          />
        </div>
      );
    case "pdf":
      return (
        <iframe
          src={url}
          title={file.name}
          className="w-full h-full min-h-[60vh] bg-white"
        />
      );
    case "video":
      return (
        <div className="flex items-center justify-center p-4 h-full min-h-[40vh]">
          <video
            controls
            preload="metadata"
            src={url}
            className={`rounded-md shadow-sm ${
              fullscreen ? "max-h-full max-w-full" : "max-w-full max-h-[78vh]"
            }`}
          />
        </div>
      );
    case "audio":
      return (
        <div className="flex items-center justify-center p-8 h-full min-h-[30vh]">
          <audio controls src={url} className="w-full max-w-xl">
            Browser tidak mendukung pemutaran audio.
          </audio>
        </div>
      );
    case "text":
      return <TextPreview url={url} renderMarkdown={false} />;
    case "markdown":
      return <TextPreview url={url} renderMarkdown={true} />;
    case "docx":
      return <OfficePreview file={file} url={url} type="docx" />;
    case "xlsx":
      return <OfficePreview file={file} url={url} type="xlsx" />;
    case "pptx":
      return <OfficePreview file={file} url={url} type="pptx" />;
    case "archive":
      return <ArchivePreview file={file} url={url} />;
    case "binary-office":
      return <NotAvailable file={file} url={url} />;
    default:
      return <NotAvailable file={file} url={url} />;
  }
}

// ───────────────────────── Loading / error bersama ─────────────────────────

function LoadingBlock({
  progress,
  label,
}: {
  progress: FetchProgress | null;
  label: string;
}) {
  const pct =
    progress && progress.total
      ? Math.min(100, Math.round((progress.loaded / progress.total) * 100))
      : null;
  return (
    <div className="flex flex-col items-center justify-center gap-3 p-10 min-h-[40vh] text-center">
      <Loader2 className="size-8 animate-spin text-muted-foreground" />
      <p className="text-sm text-muted-foreground">
        {label}
        {progress
          ? ` · ${formatBytes(progress.loaded)}${
              progress.total ? ` / ${formatBytes(progress.total)}` : ""
            }${progress.speed ? ` · ${formatSpeed(progress.speed)}` : ""}`
          : ""}
      </p>
      {pct !== null ? (
        <div className="w-56 max-w-full">
          <Progress value={pct} className="h-1.5" />
        </div>
      ) : null}
    </div>
  );
}

function ErrorBlock({
  message,
  url,
  kindLabel,
  name,
  size,
}: {
  message: string;
  url: string;
  kindLabel: string;
  name?: string;
  size?: number;
}) {
  const enqueueDownload = useTransferStore((s) => s.enqueueDownload);
  return (
    <div className="p-6 text-center text-sm">
      <p className="text-destructive mb-3">
        Gagal memuat pratinjau {kindLabel}: {message}
      </p>
      <Button
        size="sm"
        variant="outline"
        onClick={() =>
          enqueueDownload({
            url: `${url}${url.includes("?") ? "&" : "?"}download=1`,
            name: name ?? "file",
            size: size ?? 0,
            context: "Pratinjau",
            autoSave: true,
          })
        }
      >
        <Download className="size-4" /> Unduh untuk melihat
      </Button>
    </div>
  );
}

// ───────────────────────── Office preview (docx/xlsx/pptx + magic PDF) ─────────────────────────

function OfficePreview({
  file,
  url,
  type,
}: {
  file: CloudFileItem;
  url: string;
  type: "docx" | "xlsx" | "pptx";
}) {
  const { entry, error, progress } = useOfficeBuffer(file);
  const kindLabel = type === "docx" ? ".docx" : type === "xlsx" ? ".xlsx" : ".pptx";

  if (error) {
    return (
      <ErrorBlock
        message={error}
        url={url}
        kindLabel={kindLabel}
        name={file.name}
        size={file.size}
      />
    );
  }
  if (!entry) {
    return (
      <LoadingBlock
        progress={progress}
        label={`Mengunduh ${kindLabel} dari cloud…`}
      />
    );
  }

  // Ternyata PDF (mis. di-rename .docx) → pratinjau PDF native.
  if (entry.actualKind === "pdf") {
    return (
      <iframe
        src={entry.objectUrl}
        title={file.name}
        className="w-full h-full min-h-[60vh] bg-white"
      />
    );
  }

  if (type === "docx") return <DocxView file={file} entry={entry} url={url} />;
  if (type === "xlsx") return <XlsxView file={file} entry={entry} url={url} />;
  return <PptxView file={file} entry={entry} url={url} />;
}

// ───────── docx (docx-preview → layout halaman seperti Word; fallback mammoth) ─────────

/**
 * PAGINASI ECHT: docx-preview hanya memecah halaman pada page-break EKSPLISIT
 * (w:br type=page / lastRenderedPageBreak / ganti section) — konten yang
 * MENGALIR melewati satu halaman dirender jadi SATU section panjang.
 * Fungsi ini memecahnya jadi halaman-halaman sungguhan:
 * - ukuran halaman & margin dibaca dari gaya inline section (pt → px);
 * - blok (paragraf/tabel/gambar) ditumpuk sampai penuh lalu halaman BARU
 *   dibuat (section klon dengan gaya sama, header/footer disalin);
 * - TABEL yang lebih tinggi dari halaman dipecah PER BARIS (ala Word);
 * - menunggu font & gambar selesai dimuat dulu (tinggi blok berubah
 *   setelahnya → paginasi salah bila diukur terlalu cepat).
 * Dipanggil setelah renderAsync, sebelum konten ditampilkan.
 */
async function paginateDocxPages(host: HTMLElement) {
  // Stabilkan ukuran: font & gambar memengaruhi tinggi blok.
  try {
    await document.fonts?.ready;
  } catch {
    /* abaikan */
  }
  const imgs = Array.from(host.querySelectorAll("img"));
  await Promise.all(
    imgs.map((im) =>
      im.complete
        ? Promise.resolve()
        : new Promise<void>((r) => {
            im.addEventListener("load", () => r(), { once: true });
            im.addEventListener("error", () => r(), { once: true });
          })
    )
  );

  const wrapper = host.querySelector<HTMLElement>(".docx-wrapper");
  if (!wrapper) return;
  const sections = Array.from(wrapper.children).filter(
    (el) => el.tagName === "SECTION"
  ) as HTMLElement[];

  for (const sec of sections) {
    // Halaman boleh dipaginasi hanya bila strukturnya sederhana: tepat SATU
    // article (multi-article = ganti pengaturan kolom di tengah halaman —
    // dibiarkan apa adanya agar tidak salah memindah konten).
    const articles = Array.from(sec.children).filter(
      (el) => el.tagName === "ARTICLE"
    ) as HTMLElement[];
    if (articles.length !== 1) continue;
    const art = articles[0];

    const cs = getComputedStyle(sec);
    // min-height inline docx-preview = tinggi 1 halaman (mis. "841.9pt").
    const pageH =
      parseFloat(cs.minHeight) ||
      parseFloat(cs.height) ||
      sec.clientHeight ||
      0;
    const padT = parseFloat(cs.paddingTop) || 0;
    const padB = parseFloat(cs.paddingBottom) || 0;
    // Header/footer mengalir di dalam kolom section (flex column) →
    // mengurangi ruang artikel.
    let extra = 0;
    for (const ch of Array.from(sec.children)) {
      if (ch.tagName === "HEADER" || ch.tagName === "FOOTER") {
        const s = getComputedStyle(ch);
        extra +=
          (ch as HTMLElement).offsetHeight +
          parseFloat(s.marginTop) +
          parseFloat(s.marginBottom);
      }
    }
    const availH = pageH - padT - padB - extra;
    if (!(availH > 60)) continue; // ukuran halaman tak diketahui → jangan coba
    if (art.scrollHeight <= availH + 4) continue; // muat satu halaman

    // ── Pecah konten article → beberapa article (tiap article = 1 halaman).
    // Halaman baru = klon section (gaya/ukuran sama) + article kosong +
    // salinan header/footer.
    const makePage = () => {
      const s = sec.cloneNode(false) as HTMLElement;
      const a = art.cloneNode(false) as HTMLElement;
      s.appendChild(a);
      for (const ch of Array.from(sec.children)) {
        if (ch.tagName === "HEADER" || ch.tagName === "FOOTER") {
          s.appendChild(ch.cloneNode(true));
        }
      }
      return { section: s, article: a };
    };

    const blockH = (el: HTMLElement) => {
      const s = getComputedStyle(el);
      return (
        el.offsetHeight +
        (parseFloat(s.marginTop) || 0) +
        (parseFloat(s.marginBottom) || 0)
      );
    };

    const blocks = Array.from(art.children) as HTMLElement[];
    if (blocks.length === 0) continue;

    const pages: { section: HTMLElement; article: HTMLElement }[] = [makePage()];
    let cur = pages[0];
    let used = 0;

    for (const b of blocks) {
      const h = blockH(b);
      if (b.tagName === "TABLE") {
        // Tabel tinggi → pecah PER BARIS: tiap halaman dapat tabel baru
        // (shell klon: kelas/gaya sama) berisi baris yang muat.
        const rows = Array.from((b as HTMLTableElement).rows);
        if (rows.length > 0) {
          let shell: HTMLTableElement | null = null;
          for (const r of rows) {
            const rh = r.offsetHeight;
            if (shell && used + rh > availH) {
              pages.push((cur = makePage()));
              used = 0;
              shell = null;
            } else if (!shell && used > 0 && used + rh > availH) {
              pages.push((cur = makePage()));
              used = 0;
            }
            if (!shell) {
              shell = b.cloneNode(false) as HTMLTableElement;
              cur.article.appendChild(shell);
            }
            shell.appendChild(r); // memindahkan baris dari tabel lama
            used += rh;
          }
          continue;
        }
      }
      // Blok biasa: pindah halaman bila tak muat.
      if (used > 0 && used + h > availH) {
        pages.push((cur = makePage()));
        used = 0;
      }
      cur.article.appendChild(b); // memindahkan node
      used += h;
    }

    // Ganti section asli dengan urutan halaman baru (blok sudah dipindah
    // ke article klon — section asli tak lagi memuat konten).
    sec.replaceWith(...pages.map((p) => p.section));
  }
}

function DocxView({
  file,
  entry,
  url,
}: {
  file: CloudFileItem;
  entry: OfficeCacheEntry;
  url: string;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<"pages" | "flat" | "loading" | "error">(
    "loading"
  );
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [flatHtml, setFlatHtml] = useState<string | null>(
    docxHtmlCache.get(file.storageKey) ?? null
  );
  const [pageCount, setPageCount] = useState(0);

  // Render halaman pertama via docx-preview (DOKUMEN ASLI Word: halaman
  // per bagian, margin, header/footer, tabel & gambar terformat), lalu
  // PAGINASI konten yang mengalir melebihi satu halaman.
  useEffect(() => {
    if (mode !== "loading") return;
    let cancelled = false;
    (async () => {
      try {
        const docx = await import("docx-preview");
        const host = hostRef.current;
        if (!host || cancelled) return;
        host.replaceChildren();
        await docx.renderAsync(entry.buffer.slice(0), host, undefined, {
          className: "docx",
          inWrapper: true,
          ignoreWidth: false,
          ignoreHeight: false,
          ignoreFonts: false,
          breakPages: true,
          ignoreLastRenderedPageBreak: false,
          experimental: true,
          useBase64URL: true,
          debug: false,
        });
        if (cancelled) return;
        // Konten > 1 halaman → pecah jadi halaman terpisah (seperti Word).
        try {
          await paginateDocxPages(host);
        } catch {
          /* paginasi gagal → tampilan lama tetap benar, hanya panjang */
        }
        if (cancelled) return;
        setPageCount(host.querySelectorAll("section").length);
        setMode("pages");
      } catch {
        if (cancelled) return;
        // Fallback: konversi mammoth (aliran teks sederhana).
        try {
          const mammoth = await import("mammoth");
          const result = await mammoth.convertToHtml({
            arrayBuffer: entry.buffer,
          });
          const out = result.value || "<p>(dokumen kosong)</p>";
          docxHtmlCache.set(file.storageKey, out);
          if (!cancelled) {
            setFlatHtml(out);
            setMode("flat");
          }
        } catch (e) {
          if (!cancelled) {
            setErrorMsg(
              e instanceof Error ? e.message : "Gagal mengonversi .docx"
            );
            setMode("error");
          }
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.storageKey, entry.buffer, mode]);

  if (mode === "error")
    return (
      <ErrorBlock
        message={errorMsg ?? "Gagal membuka .docx"}
        url={url}
        kindLabel=".docx"
        name={file.name}
        size={file.size}
      />
    );
  if (mode === "flat") {
    // Fallback mammoth (docx-preview gagal) — aliran teks.
    return (
      <ScrollArea className="h-full min-h-[60vh]">
        <div
          className="prose prose-sm dark:prose-invert max-w-none p-6 break-words"
          // mammoth produces sanitised HTML from the docx XML structure
          // (paragraphs, lists, tables). It is generated from the document
          // content itself, not from user-supplied input.
          dangerouslySetInnerHTML={{ __html: flatHtml ?? "" }}
        />
      </ScrollArea>
    );
  }
  // mode "loading" | "pages" — tampilan seperti Microsoft Word / Google
  // Docs: latar abu-abu, halaman putih ber-margin berbayang, di tengah.
  // Host docx-preview SELALU ter-mount (render membutuhkan DOM nyata);
  // indikator loading hanyalah lapisan di atasnya.
  return (
    <div className="docx-viewer relative h-full min-h-[60vh] overflow-auto bg-neutral-200 dark:bg-neutral-900/70">
      <div ref={hostRef} className={mode === "pages" ? "" : "invisible"} />
      {mode === "pages" && pageCount > 1 ? (
        <span
          className="absolute bottom-3 right-4 z-10 rounded-full bg-background/85 px-3 py-1 text-xs tabular-nums text-muted-foreground shadow-sm border border-border/60"
          aria-label={`Jumlah halaman dokumen: ${pageCount}`}
        >
          {pageCount} halaman
        </span>
      ) : null}
      {mode === "loading" ? (
        <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground bg-neutral-200/60 dark:bg-neutral-900/60">
          <Loader2 className="size-4 animate-spin mr-2" /> Membuka dokumen…
        </div>
      ) : null}
    </div>
  );
}

// ───────── xlsx / xls / csv (SheetJS) ─────────

function XlsxView({
  file,
  entry,
  url,
}: {
  file: CloudFileItem;
  entry: OfficeCacheEntry;
  url: string;
}) {
  const [sheets, setSheets] = useState<{ name: string; html: string }[] | null>(
    xlsxSheetsCache.get(file.storageKey) ?? null
  );
  const [active, setActive] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (sheets) return;
    let cancelled = false;
    (async () => {
      try {
        const XLSX = await import("xlsx");
        const wb = XLSX.read(entry.buffer, { type: "array" });
        const MAX_ROWS = 300; // batasi supaya sheet raksasa tidak bikin browser macet
        const out = wb.SheetNames.map((name) => {
          const sheet = wb.Sheets[name];
          const range = XLSX.utils.decode_range(
            sheet["!ref"] ?? "A1"
          );
          const limitedRows = Math.min(range.e.r, MAX_ROWS - 1);
          const limited = { ...sheet, "!ref": XLSX.utils.encode_range({ ...range, e: { ...range.e, r: limitedRows } }) };
          let html = XLSX.utils.sheet_to_html(limited, { editable: false });
          if (range.e.r > limitedRows) {
            html += `<p class="text-xs text-muted-foreground p-2">… ${range.e.r - limitedRows} baris berikutnya tidak ditampilkan (unduh file untuk melihat semua).</p>`;
          }
          return { name, html };
        });
        xlsxSheetsCache.set(file.storageKey, out);
        if (!cancelled) setSheets(out);
      } catch (e) {
        if (!cancelled)
          setError(e instanceof Error ? e.message : "Gagal membaca spreadsheet");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [file.storageKey, entry.buffer, sheets]);

  if (error)
    return (
      <ErrorBlock
        message={error}
        url={url}
        kindLabel=".xlsx"
        name={file.name}
        size={file.size}
      />
    );
  if (!sheets) {
    return (
      <div className="p-6 flex items-center justify-center text-sm text-muted-foreground min-h-[40vh]">
        <Loader2 className="size-4 animate-spin mr-2" /> Membaca spreadsheet…
      </div>
    );
  }
  return (
    <div className="h-full min-h-[60vh] flex flex-col">
      {sheets.length > 1 ? (
        <div className="px-4 pt-3 pb-1 border-b border-border">
          <Tabs value={String(active)} onValueChange={(v) => setActive(Number(v))}>
            <TabsList className="h-8 flex-wrap max-w-full overflow-x-auto">
              {sheets.map((s, i) => (
                <TabsTrigger key={s.name} value={String(i)} className="text-xs">
                  {s.name}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </div>
      ) : null}
      {/* wrapper flex-1 min-h-0 (definite dalam frame/window preview
          yang tingginya pasti) + ScrollArea h-full → viewport
          ter-constrain & daftar sheet bisa di-scroll. Jangan pakai
          `absolute` — Radix Root punya inline position:relative. */}
      <div className="flex-1 min-h-0">
        <ScrollArea className="h-full">
          <div
            className="p-4 [&_table]:w-full [&_table]:text-xs [&_table]:border-collapse [&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:border-border [&_th]:bg-secondary [&_th]:px-2 [&_th]:py-1"
            dangerouslySetInnerHTML={{ __html: sheets[active]?.html ?? "" }}
          />
        </ScrollArea>
      </div>
    </div>
  );
}

// ───────── pptx (pptx-preview) ─────────

function PptxView({
  file,
  entry,
  url,
}: {
  file: CloudFileItem;
  entry: OfficeCacheEntry;
  url: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let raf = 0;
    let attempts = 0;
    (async () => {
      try {
        const mod = await import("pptx-preview");
        const init = (mod as { init: unknown }).init as (
          el: HTMLElement,
          opts: { width: number; height: number }
        ) => { preview: (data: ArrayBuffer) => void };
        const el = containerRef.current;
        if (!el) return;
        // Ukur lebar dengan sabar: dialog baru saja dibuka → layout bisa
        // belum siap (clientWidth 0). Dulu: fallback 960 terpakai padahal
        // dialog lebih lebar → slide tampil kecil / rasio salah. Coba
        // ulang tiap frame hingga terukur (maks ±10 frame).
        const start = () => {
          const width = Math.max(
            480,
            Math.min(el.clientWidth || 960, 1150)
          );
          if (cancelled) return;
          const viewer = init(el, {
            width,
            height: Math.round((width * 9) / 16),
          });
          viewer.preview(entry.buffer);
          setReady(true);
        };
        const tryMeasure = () => {
          if (cancelled) return;
          if (el.clientWidth > 0 || attempts >= 10) {
            start();
          } else {
            attempts++;
            raf = requestAnimationFrame(tryMeasure);
          }
        };
        tryMeasure();
      } catch (e) {
        if (!cancelled)
          setError(e instanceof Error ? e.message : "Gagal merender .pptx");
      }
    })();
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, [entry.buffer]);

  if (error)
    return (
      <ErrorBlock
        message={error}
        url={url}
        kindLabel=".pptx"
        name={file.name}
        size={file.size}
      />
    );
  return (
    <ScrollArea className="h-full min-h-[60vh]">
      {!ready ? (
        <div className="p-6 flex items-center justify-center text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin mr-2" /> Merender slide .pptx…
        </div>
      ) : null}
      <div ref={containerRef} className="p-4 flex justify-center bg-secondary/40" />
    </ScrollArea>
  );
}

// ───────────────────────── Text / Markdown preview ─────────────────────────

const TEXT_CAP = 512 * 1024; // 512 KB — file teks besar tetap lancar

function TextPreview({
  url,
  renderMarkdown,
}: {
  url: string;
  renderMarkdown: boolean;
}) {
  const [content, setContent] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Reset state when `url` changes ("adjust state during render" pattern).
  const [prevUrl, setPrevUrl] = useState<string>(url);
  if (prevUrl !== url) {
    setPrevUrl(url);
    setContent(null);
    setError(null);
    setTruncated(false);
    setCopied(false);
  }

  useEffect(() => {
    let cancelled = false;
    const ac = new AbortController();
    fetch(url, { signal: ac.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        if (!cancelled) {
          if (text.length > TEXT_CAP) {
            setContent(text.slice(0, TEXT_CAP));
            setTruncated(true);
          } else {
            setContent(text);
          }
        }
      })
      .catch((e) => {
        if (!cancelled && !(e instanceof DOMException && e.name === "AbortError"))
          setError(e instanceof Error ? e.message : "Gagal memuat teks");
      });
    return () => {
      cancelled = true;
      ac.abort();
    };
  }, [url]);

  if (error) {
    return (
      <div className="p-6 text-center text-sm text-destructive">
        Gagal memuat isi: {error}
      </div>
    );
  }
  if (content === null) {
    return (
      <div className="p-6 flex items-center justify-center text-sm text-muted-foreground min-h-[30vh]">
        <Loader2 className="size-4 animate-spin mr-2" /> Memuat teks…
      </div>
    );
  }

  function onCopy() {
    if (content === null) return;
    navigator.clipboard
      .writeText(content)
      .then(() => {
        setCopied(true);
        toast.success("Teks disalin ke clipboard.");
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => toast.error("Gagal menyalin"));
  }

  return (
    <div className="relative h-full min-h-[60vh]">
      <Button
        size="sm"
        variant="outline"
        className="absolute right-3 top-3 z-10 bg-background/80 backdrop-blur"
        onClick={onCopy}
        title="Salin isi"
      >
        {copied ? (
          <>
            <Check className="size-4" /> Tersalin
          </>
        ) : (
          <>
            <Copy className="size-4" /> Salin
          </>
        )}
      </Button>
      <ScrollArea className="h-full">
        {renderMarkdown ? (
          <div className="prose prose-sm dark:prose-invert max-w-none p-6 break-words">
            <AiMarkdown content={content} />
          </div>
        ) : (
          <pre className="p-6 text-xs font-mono whitespace-pre-wrap break-words leading-relaxed">
            {content}
            {truncated ? "\n\n… (file terlalu besar — hanya 512 KB pertama yang ditampilkan)" : ""}
          </pre>
        )}
      </ScrollArea>
    </div>
  );
}

// ───────────────────────── Not-available fallback ─────────────────────────

function NotAvailable({
  file,
  url,
}: {
  file: CloudFileItem;
  url: string;
}) {
  const enqueueDownload = useTransferStore((s) => s.enqueueDownload);
  return (
    <div className="flex flex-col items-center justify-center gap-3 p-12 text-center min-h-[40vh]">
      <FileWarning className="size-12 text-muted-foreground/60" />
      <div>
        <p className="text-sm font-medium">Pratinjau tidak tersedia</p>
        <p className="text-xs text-muted-foreground mt-1">
          Tipe file ini ({file.mimetype || "tidak diketahui"}) tidak bisa
          ditampilkan langsung di browser.
        </p>
      </div>
      <Button
        size="sm"
        onClick={() =>
          enqueueDownload({
            url: `${url}${url.includes("?") ? "&" : "?"}download=1`,
            name: file.name,
            size: file.size,
            context: "Pratinjau",
            autoSave: true,
          })
        }
      >
        <Download className="size-4" /> Unduh untuk melihat
      </Button>
    </div>
  );
}

// ───────────────────────── Arsip (ZIP dkk) — daftar isi in-app ─────────────────────────
// File arsip TIDak di-download otomatis. Untuk .zip kita daftar isinya
// langsung dari CENTRAL DIRECTORY (header saja — TANPA dekompresi;
// dulu fflate unzip mendekompresi SELURUH isi: zip 60MB bisa makan
// ratusan MB RAM hanya untuk menampilkan nama file); rar/7z/tar dkk →
// kartu info + tombol unduh. Unduhan memakai cache pratinjau bersama
// (progress + abort otomatis saat dialog ditutup).

interface ZipEntryInfo {
  path: string;
  size: number;
  compressedSize?: number;
  isFile: boolean;
}

/** Baca daftar isi ZIP dari EOCD → central directory (tanpa dekompresi). */
function listZipEntries(u8: Uint8Array): ZipEntryInfo[] {
  // Temukan End of Central Directory (signature PK\x05\x06) dari belakang
  // (komentar ZIP bisa sampai 64KB).
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let eocd = -1;
  const stop = Math.max(0, u8.length - 22 - 65535);
  for (let i = u8.length - 22; i >= stop; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("Bukan arsip ZIP yang valid.");
  const count = dv.getUint16(eocd + 10, true);
  let off = dv.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  const out: ZipEntryInfo[] = [];
  for (let i = 0; i < count && off + 46 <= u8.length; i++) {
    if (dv.getUint32(off, true) !== 0x02014b50) break; // tanda tangan CD
    const compSize = dv.getUint32(off + 20, true);
    const uncompSize = dv.getUint32(off + 24, true);
    const nameLen = dv.getUint16(off + 28, true);
    const extraLen = dv.getUint16(off + 30, true);
    const commentLen = dv.getUint16(off + 32, true);
    const name = dec.decode(u8.subarray(off + 46, off + 46 + nameLen));
    out.push({
      path: name,
      size: uncompSize,
      compressedSize: compSize || undefined,
      isFile: !name.endsWith("/"),
    });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

function ArchivePreview({
  file,
  url,
}: {
  file: CloudFileItem;
  url: string;
}) {
  const enqueueDownload = useTransferStore((s) => s.enqueueDownload);
  const [entries, setEntries] = useState<ZipEntryInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const ext2 = ext(file.name);
  // Batas aman: zip raksasa → kartu info (membaca header pun berat).
  const ZIP_LIST_LIMIT = 60 * 1024 * 1024;
  const isZip =
    (ext2 === "zip" || ext2 === "epub" || file.mimetype === "application/zip") &&
    (file.size || 0) <= ZIP_LIST_LIMIT;

  // Buffer via cache bersama (progress + abort saat dialog ditutup).
  const { entry, error: bufError, progress } = useOfficeBuffer(file, {
    enabled: isZip,
  });

  useEffect(() => {
    if (!isZip || !entry) return;
    let cancelled = false;
    (async () => {
      try {
        // Parse di microtask berikutnya (setelah buffer siap) — setState
        // tidak lagi sinkron di badan effect.
        await Promise.resolve();
        if (cancelled) return;
        const list = listZipEntries(new Uint8Array(entry.buffer));
        list.sort((a, b) => a.path.localeCompare(b.path));
        setEntries(list);
      } catch (e) {
        if (!cancelled)
          setError(e instanceof Error ? e.message : "Gagal membaca arsip");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isZip, entry]);

  if (isZip && bufError) {
    return (
      <ErrorBlock
        message={bufError}
        url={url}
        kindLabel="arsip"
        name={file.name}
        size={file.size}
      />
    );
  }
  if (isZip && !entry) {
    return (
      <LoadingBlock progress={progress} label="Mengunduh arsip dari cloud…" />
    );
  }

  if (!isZip) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 p-12 text-center min-h-[40vh]">
        <FileArchive className="size-12 text-muted-foreground/60" />
        <div>
          <p className="text-sm font-medium">Arsip .{ext2 || "?"}</p>
          <p className="text-xs text-muted-foreground mt-1 max-w-sm">
            Format arsip ini tidak bisa dibuka langsung di browser. Unduh
            untuk mengekstrak isinya di perangkat Anda.
          </p>
        </div>
        <Button
          size="sm"
          onClick={() =>
            enqueueDownload({
              url: `${url}${url.includes("?") ? "&" : "?"}download=1`,
              name: file.name,
              size: file.size,
              context: "Pratinjau",
              autoSave: true,
            })
          }
        >
          <Download className="size-4" /> Unduh arsip
        </Button>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 p-12 text-center min-h-[40vh]">
        <FileWarning className="size-12 text-muted-foreground/60" />
        <p className="text-sm text-destructive">Gagal membaca arsip: {error}</p>
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            enqueueDownload({
              url: `${url}${url.includes("?") ? "&" : "?"}download=1`,
              name: file.name,
              size: file.size,
              context: "Pratinjau",
              autoSave: true,
            })
          }
        >
          <Download className="size-4" /> Unduh
        </Button>
      </div>
    );
  }

  if (entries === null) {
    return (
      <div className="p-6 flex items-center justify-center text-sm text-muted-foreground min-h-[40vh]">
        <Loader2 className="size-4 animate-spin mr-2" /> Membaca isi arsip…
      </div>
    );
  }

  const files = entries.filter((e) => e.isFile);
  const folders = entries.filter((e) => !e.isFile).length;
  const totalUncompressed = files.reduce((s, e) => s + e.size, 0);
  const filtered = query
    ? files.filter((e) =>
        e.path.toLowerCase().includes(query.toLowerCase())
      )
    : files.slice(0, 300);
  const hiddenCount = query ? 0 : files.length - filtered.length;

  return (
    <div className="h-full min-h-[50vh] flex flex-col">
      <div className="px-4 py-3 border-b border-border flex flex-wrap items-center gap-3">
        <FileArchive className="size-5 text-amber-500 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium truncate">
            {files.length} file{folders > 0 ? ` · ${folders} folder` : ""}
          </p>
          <p className="text-[11px] text-muted-foreground">
            Total {formatBytes(totalUncompressed)} (belum terkompresi)
          </p>
        </div>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Cari dalam arsip…"
          className="h-8 rounded-md border border-input bg-card px-2 text-xs w-40 sm:w-56"
        />
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            enqueueDownload({
              url: `${url}${url.includes("?") ? "&" : "?"}download=1`,
              name: file.name,
              size: file.size,
              context: "Pratinjau",
              autoSave: true,
            })
          }
        >
          <Download className="size-4" /> Unduh
        </Button>
      </div>
      {/* wrapper flex-1 min-h-0 + ScrollArea h-full → daftar isi arsip
          yang panjang selalu bisa di-scroll (Radix Root inline
          position:relative — jangan pakai class absolute). */}
      <div className="flex-1 min-h-0">
        <ScrollArea className="h-full">
          <div className="p-2">
            {filtered.map((e) => (
              <div
                key={e.path}
                className="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-accent/60 text-sm"
              >
                <FileText className="size-3.5 text-muted-foreground shrink-0" />
                <span className="flex-1 min-w-0 truncate font-mono text-xs">
                  {e.path}
                </span>
                <span className="text-[11px] text-muted-foreground tabular-nums shrink-0">
                  {formatBytes(e.size)}
                </span>
              </div>
            ))}
            {hiddenCount > 0 ? (
              <p className="text-xs text-muted-foreground p-3 text-center">
                … {hiddenCount} file lain tidak ditampilkan. Gunakan pencarian
                atau unduh arsipnya.
              </p>
            ) : null}
            {filtered.length === 0 ? (
              <p className="text-xs text-muted-foreground p-6 text-center">
                Tidak ada file yang cocok dengan pencarian.
              </p>
            ) : null}
          </div>
        </ScrollArea>
      </div>
    </div>
  );
}
