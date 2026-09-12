"use client";

// ─────────────────────────────────────────────────────────────────────
// MaterialAiDialog — "Buat materi dengan AI" untuk Pusat Belajar.
//
// Dipakai bersama oleh tab Alat Materi (TextTools) dan Teman AI
// (StudyBuddy). Topik ditulis user → AI menyusun materi (streaming) →
// hasilnya LANGSUNG mengalir ke kolom materi bersama
// (useStudyMaterial), sehingga kedua tab otomatis tersinkron.
//
// Pengaman: materi lama disimpan dulu; jika ada isinya, toast sukses
// diberi aksi "Kembalikan" untuk membatalkan hasil AI.
// ─────────────────────────────────────────────────────────────────────

import { useRef, useState } from "react";
import { toast } from "sonner";
import { Loader2, Sparkles, Square, Wand2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AutoTextarea } from "@/components/ui/auto-textarea";

const TOPIC_MAX = 500;

export function MaterialAiDialog({
  open,
  onOpenChange,
  hasExisting,
  currentMaterial,
  setMaterial,
  disabled,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  /** true bila kolom materi saat ini sudah ada isinya (untuk peringatan). */
  hasExisting: boolean;
  /** Isi materi saat ini — di-backup sebelum diganti hasil AI. */
  currentMaterial: string;
  /** Setter materi bersama — hasil streaming dikirim ke sini per potongan. */
  setMaterial: (next: string) => void;
  /** Disable tombol buat (mis. belum ada AI terpasang). */
  disabled?: boolean;
}) {
  const [topic, setTopic] = useState("");
  const [notes, setNotes] = useState("");
  const [generating, setGenerating] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  // Backup materi sebelum diganti (untuk aksi "Kembalikan").
  const backupRef = useRef<string | null>(null);

  function reset() {
    abortRef.current?.abort();
    abortRef.current = null;
    setGenerating(false);
    setTopic("");
    setNotes("");
  }

  function close() {
    if (generating) {
      // Stream masih berjalan — hentikan dulu (potongan tetap tersimpan).
      abortRef.current?.abort();
    }
    reset();
    onOpenChange(false);
  }

  async function generate() {
    const t = topic.trim();
    if (!t || generating || disabled) return;

    // Backup materi lama SEBELUM potongan pertama menggantikannya — dipakai
    // untuk aksi "Kembalikan" pada toast sukses.
    backupRef.current = currentMaterial;
    setGenerating(true);

    const ac = new AbortController();
    abortRef.current = ac;

    const message = notes.trim()
      ? `Topik: ${t}\n\nCatatan tambahan: ${notes.trim()}`
      : `Topik: ${t}`;

    try {
      const res = await fetch("/api/ai/study", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, task: "material" }),
        signal: ac.signal,
      });

      if (!res.ok || !res.body) {
        const json = await res.json().catch(() => null);
        throw new Error(json?.error ?? `Gagal menghubungi server (HTTP ${res.status}).`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let got = "";
      let errMsg: string | null = null;
      readLoop: while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          let ev: { type?: string; text?: string; message?: string };
          try {
            ev = JSON.parse(trimmed);
          } catch {
            continue;
          }
          if (ev.type === "chunk" && ev.text) {
            got += ev.text;
            // Hasil AI langsung mengalir ke kolom materi (tersinkron ke
            // seluruh Pusat Belajar). Potongan pertama mengganti isi lama.
            setMaterial(got);
          } else if (ev.type === "error") {
            errMsg = ev.message ?? "Terjadi error.";
            break readLoop;
          }
        }
      }

      if (errMsg) {
        if (!got.trim()) {
          toast.error(errMsg);
        } else {
          toast.warning("Materi sebagian berhasil dibuat.", {
            description: errMsg,
          });
        }
      } else if (got.trim()) {
        const backup = backupRef.current;
        toast.success("Materi selesai dibuat — tersinkron ke Teman AI & Alat Materi.", {
          description: backup && backup.trim() ? "Materi lama diganti." : undefined,
          action: backup && backup.trim()
            ? {
                label: "Kembalikan",
                onClick: () => setMaterial(backup),
              }
            : undefined,
        });
        reset();
        onOpenChange(false);
      } else {
        toast.error("AI tidak mengirim materi — coba lagi.");
      }
    } catch (err) {
      if (ac.signal.aborted) {
        toast.info("Dihentikan — potongan materi yang sudah masuk tetap tersimpan.");
      } else {
        toast.error((err as Error)?.message ?? "Koneksi gagal. Coba lagi.");
      }
    } finally {
      setGenerating(false);
      abortRef.current = null;
    }
  }

  function onTopicKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void generate();
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) close();
        else onOpenChange(true);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Wand2 className="size-4 text-primary" />
            Buat Materi dengan AI
          </DialogTitle>
          <DialogDescription>
            Tulis topiknya — AI menyusun materi lengkap (ringkasan, contoh,
            latihan) langsung ke kolom materi. Tersinkron otomatis ke seluruh
            Pusat Belajar.
          </DialogDescription>
        </DialogHeader>

        {generating ? (
          <div className="flex flex-col items-center gap-3 py-6 text-center">
            <Loader2 className="size-6 animate-spin text-primary" />
            <p className="text-sm text-muted-foreground">
              Menyusun materi… hasil langsung terlihat di kolom materi.
            </p>
            <Button variant="destructive" size="sm" onClick={() => abortRef.current?.abort()}>
              <Square className="size-3.5" /> Hentikan
            </Button>
          </div>
        ) : (
          <div className="grid gap-4">
            <div className="grid gap-1.5">
              <Label htmlFor="material-topic">Topik materi</Label>
              <Input
                id="material-topic"
                value={topic}
                onChange={(e) => setTopic(e.target.value.slice(0, TOPIC_MAX))}
                onKeyDown={onTopicKeyDown}
                placeholder="mis. Fotosintesis untuk SMP kelas 8"
                autoFocus
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="material-notes">
                Catatan tambahan{" "}
                <span className="text-[11px] font-normal text-muted-foreground">
                  (opsional)
                </span>
              </Label>
              <AutoTextarea
                id="material-notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value.slice(0, 1000))}
                placeholder="mis. fokus pada peran klorofil, tambahkan contoh soal essay"
                maxHeight={180}
                className="min-h-16 text-sm"
              />
            </div>
            {hasExisting ? (
              <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-amber-700 dark:text-amber-400">
                Kolom materi saat ini sudah ada isinya — materi baru akan
                menggantinya. Tombol “Kembalikan” tersedia setelah selesai.
              </p>
            ) : null}
          </div>
        )}

        <DialogFooter>
          {!generating ? (
            <>
              <Button variant="outline" onClick={close}>
                Batal
              </Button>
              <Button onClick={() => void generate()} disabled={!topic.trim() || disabled}>
                <Sparkles className="size-4" /> Buat Materi
              </Button>
            </>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
