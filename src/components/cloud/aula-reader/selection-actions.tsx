"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Volume2, Square, Copy, Highlighter } from "lucide-react";
import { Button } from "@/components/ui/button";

// ─────────────────────────────────────────────────────────────────────────
// Menu aksi teks terpilih (dipakai di seluruh Aula Reader).
// Muncul saat user menyeleksi teks: Bacakan (TTS) · Stabilo (PDF) · Salin.
// Posisi menu mengikuti kotak seleksi; menutup saat seleksi hilang /
// scroll / klik di luar / ESC.
// ─────────────────────────────────────────────────────────────────────────

export interface SelMenuState {
  /** posisi terhadap kontainer scroll (px, sudah termasuk offset scroll) */
  x: number;
  y: number;
  text: string;
  /** halaman PDF (elemen [data-page]) — undefined untuk teks biasa */
  page?: number;
  /** rects seleksi ternormalisasi terhadap halaman (untuk stabilo PDF) */
  rects?: [number, number, number, number][];
}

function pickIndonesianVoice(): SpeechSynthesisVoice | null {
  if (typeof window === "undefined" || !window.speechSynthesis) return null;
  return (
    window.speechSynthesis.getVoices().find((v) =>
      v.lang?.toLowerCase().startsWith("id")
    ) ?? null
  );
}

/** Salin teks ke clipboard dengan fallback execCommand (untuk konteks tanpa izin Clipboard API). */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      ta.setAttribute("readonly", "");
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

export function useSelectionMenu({
  containerRef,
  /** selector elemen yang seleksinya dianggap valid (default: dalam kontainer) */
  withinSelector,
  /** ada bila stabilo berbasis seleksi didukung (PDF) */
  onHighlight,
  activeColor,
}: {
  containerRef: React.RefObject<HTMLElement | null>;
  withinSelector?: string;
  onHighlight?: (sel: { page: number; rects: [number, number, number, number][]; text: string }) => void;
  activeColor?: string;
}) {
  const [menu, setMenu] = useState<SelMenuState | null>(null);
  const [playing, setPlaying] = useState(false);
  const stopRef = useRef(false);

  const closeMenu = useCallback(() => setMenu(null), []);

  // Hentikan TTS saat unmount / ganti file.
  useEffect(() => {
    return () => {
      stopRef.current = true;
      if (typeof window !== "undefined") window.speechSynthesis?.cancel();
    };
  }, []);

  const stopSpeak = useCallback(() => {
    stopRef.current = true;
    window.speechSynthesis?.cancel();
    setPlaying(false);
  }, []);

  const speak = useCallback(
    (text: string) => {
      if (typeof window === "undefined" || !window.speechSynthesis) return;
      window.speechSynthesis.cancel();
      stopRef.current = false;
      const u = new SpeechSynthesisUtterance(text);
      const v = pickIndonesianVoice();
      if (v) u.voice = v;
      u.lang = v?.lang ?? "id-ID";
      u.rate = 1;
      u.onend = () => setPlaying(false);
      u.onerror = () => setPlaying(false);
      setPlaying(true);
      window.speechSynthesis.speak(u);
    },
    []
  );

  // Deteksi seleksi (pointer & keyboard) — defer 1 tick agar selection final.
  // Listener di DOCUMENT (bukan container): ref container bisa null saat hook
  // pertama jalan (konten masih loading) → validasi dilakukan fresh di check().
  useEffect(() => {
    const check = () => {
      const el = containerRef.current;
      if (!el) return;
      const sel = typeof window === "undefined" ? null : window.getSelection();
      if (!sel || sel.isCollapsed || !sel.toString().trim()) {
        setMenu(null);
        return;
      }
      let node: Node | null = sel.anchorNode;
      let target: HTMLElement | null = null;
      while (node) {
        if (node instanceof HTMLElement) {
          if (withinSelector ? node.closest(withinSelector) : el.contains(node)) {
            target = node;
            break;
          }
        }
        node = node.parentNode;
      }
      if (!target) {
        setMenu(null);
        return;
      }
      const range = sel.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      const cRect = el.getBoundingClientRect();
      if (rect.width <= 0 && rect.height <= 0) return;

      const state: SelMenuState = {
        x: rect.left - cRect.left + el.scrollLeft,
        y: rect.top - cRect.top + el.scrollTop,
        text: sel.toString().replace(/\s+/g, " ").trim(),
      };

      // PDF: temukan halaman + rects ternormalisasi untuk stabilo.
      const pageEl = target.closest("[data-page]") as HTMLElement | null;
      if (pageEl?.dataset.page) {
        state.page = Number(pageEl.dataset.page);
        const pRect = pageEl.getBoundingClientRect();
        const rects: [number, number, number, number][] = [];
        for (const r of range.getClientRects()) {
          if (r.width < 1 || r.height < 1) continue;
          rects.push([
            (r.left - pRect.left) / pRect.width,
            (r.top - pRect.top) / pRect.height,
            r.width / pRect.width,
            r.height / pRect.height,
          ]);
        }
        state.rects = rects;
      }

      // Jangan menutupi teks: muncul di atas seleksi; clamp ke AREA TERLIHAT
      // kontainer (koordinat konten = scroll + viewport — tanpa ini, di mode
      // horizontal menu terdorong ke tepi kiri / terpotong karena clamp lama
      // mengabaikan scrollLeft).
      state.y = Math.max(el.scrollTop + 4, state.y - 48);
      const minX = el.scrollLeft + 4;
      const maxX = el.scrollLeft + Math.max(4, el.clientWidth - 250);
      state.x = Math.min(Math.max(minX, state.x), Math.max(minX, maxX));
      setMenu(state);
    };

    const onUp = () => setTimeout(check, 0);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setMenu(null);
        return;
      }
      if (e.shiftKey || e.key === "a") setTimeout(check, 0);
    };
    // Scroll (di mana pun di dokumen) → tutup menu (posisinya basi).
    const onScroll = () => setMenu(null);

    document.addEventListener("pointerup", onUp);
    document.addEventListener("keyup", onKey);
    document.addEventListener("scroll", onScroll, { passive: true, capture: true });
    return () => {
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("keyup", onKey);
      document.removeEventListener("scroll", onScroll, { capture: true } as EventListenerOptions);
    };
  }, [containerRef, withinSelector]);

  const highlight = useCallback(() => {
    if (!menu?.rects?.length || !menu.page || !onHighlight) return;
    onHighlight({ page: menu.page, rects: menu.rects, text: menu.text });
    window.getSelection()?.removeAllRanges();
    setMenu(null);
  }, [menu, onHighlight]);

  const copy = useCallback(
    async (text: string) => {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch {
        return false;
      }
    },
    []
  );

  return { menu, closeMenu, playing, speak, stopSpeak, highlight, copy };
}

/** Toolbar mengambang untuk teks terpilih. */
export function SelectionToolbar({
  menu,
  playing,
  onSpeak,
  onStopSpeak,
  onHighlight,
  onCopy,
  onClose,
  activeColor,
}: {
  menu: SelMenuState;
  playing: boolean;
  onSpeak: (text: string) => void;
  onStopSpeak: () => void;
  onHighlight?: () => void;
  onCopy: (ok: boolean) => void;
  onClose: () => void;
  activeColor?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);

  // Clamp presisi setelah terukur: geser ke dalam AREA TERLIHAT kontainer
  // (memperhitungkan scrollLeft/scrollTop) — di mode horizontal seleksi
  // di halaman jauh, posisi mentah bisa keluar viewport dan terpotong.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const c = el.offsetParent as HTMLElement | null;
    if (!c) return;
    const visL = c.scrollLeft;
    const visR = c.scrollLeft + c.clientWidth;
    const overR = el.offsetLeft + el.offsetWidth - visR;
    if (overR > 0) el.style.left = Math.max(visL + 4, el.offsetLeft - overR) + "px";
    if (el.offsetLeft < visL) el.style.left = visL + 4 + "px";
  }, [menu]);

  const preview =
    menu.text.length > 40 ? menu.text.slice(0, 40) + "…" : menu.text;
  return (
    <div
      ref={ref}
      role="toolbar"
      aria-label="Aksi teks terpilih"
      className="absolute z-30 flex items-center gap-0.5 rounded-lg border border-border bg-background shadow-lg px-1 py-1"
      style={{ left: menu.x, top: menu.y, maxWidth: 320 }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <Button
        variant="ghost"
        size="sm"
        className="h-8 px-2.5 gap-1.5 text-xs"
        title={playing ? "Hentikan bacaan" : `Bacakan: "${preview}"`}
        onClick={() => (playing ? onStopSpeak() : onSpeak(menu.text))}
      >
        {playing ? (
          <Square className="size-3.5" />
        ) : (
          <Volume2 className="size-3.5" />
        )}
        {playing ? "Stop" : "Bacakan"}
      </Button>
      {onHighlight ? (
        <Button
          variant="ghost"
          size="sm"
          className="h-8 px-2.5 gap-1.5 text-xs"
          title="Tandai teks terpilih dengan stabilo"
          onClick={onHighlight}
        >
          <Highlighter
            className="size-3.5"
            style={activeColor ? { color: activeColor } : undefined}
          />
          Stabilo
        </Button>
      ) : null}
      <Button
        variant="ghost"
        size="sm"
        className="h-8 px-2.5 gap-1.5 text-xs"
        title="Salin teks terpilih"
        onClick={async () => {
          const ok = await copyTextToClipboard(menu.text);
          onCopy(ok);
          onClose();
        }}
      >
        <Copy className="size-3.5" />
        Salin
      </Button>
    </div>
  );
}
