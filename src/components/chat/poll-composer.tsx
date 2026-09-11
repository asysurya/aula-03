"use client";

// Poll cepat — buat pesan polling dengan opsi bernomor. Setelah terkirim,
// pengirim otomatis memberi reaksi emoji angka sehingga anggota cukup
// men-tap reaksi untuk memilih (voting via reaksi, ala Discord).

import { useState } from "react";
import { BarChart3, Loader2, Plus, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const NUMBER_EMOJIS = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣"];

export function PollComposer({
  open,
  onOpenChange,
  onSendPoll,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onSendPoll: (content: string, optionCount: number) => Promise<string | null>;
}) {
  const [question, setQuestion] = useState("");
  const [options, setOptions] = useState<string[]>(["", ""]);
  const [sending, setSending] = useState(false);

  const filled = options.map((o) => o.trim()).filter(Boolean);

  async function send() {
    if (sending) return;
    if (!question.trim()) {
      toast.error("Tulis pertanyaan polling dulu");
      return;
    }
    if (filled.length < 2) {
      toast.error("Isi minimal 2 opsi jawaban");
      return;
    }
    setSending(true);
    try {
      const lines = [
        `📊 **POLLING** — ${question.trim()}`,
        "",
        ...filled.map((o, i) => `${NUMBER_EMOJIS[i] ?? "•"} ${o}`),
        "",
        "_Pilih dengan men-tap reaksi angka di pesan ini._",
      ].join("\n");
      const id = await onSendPoll(lines, filled.length);
      if (id) {
        toast.success("Polling terkirim — pilihan angka otomatis ditambahkan");
        setQuestion("");
        setOptions(["", ""]);
        onOpenChange(false);
      }
    } finally {
      setSending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <BarChart3 className="size-5 text-primary" /> Buat Polling Cepat
          </DialogTitle>
          <DialogDescription>
            Anggota memilih lewat reaksi emoji angka — hasil terlihat
            langsung di pesan.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="poll-question">Pertanyaan</Label>
            <Input
              id="poll-question"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder="cth: Kapan latihan bersama kita?"
              maxLength={200}
            />
          </div>

          <div className="space-y-1.5">
            <Label>Opsi jawaban (2–5)</Label>
            {options.map((o, i) => (
              <div key={i} className="flex items-center gap-2">
                <span className="text-sm w-5 text-center shrink-0">
                  {NUMBER_EMOJIS[i] ?? "•"}
                </span>
                <Input
                  value={o}
                  onChange={(e) =>
                    setOptions((prev) =>
                      prev.map((x, j) => (j === i ? e.target.value : x))
                    )
                  }
                  placeholder={`Opsi ${i + 1}`}
                  maxLength={100}
                />
                {options.length > 2 ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-8 shrink-0 text-muted-foreground"
                    onClick={() =>
                      setOptions((prev) => prev.filter((_, j) => j !== i))
                    }
                    aria-label="Hapus opsi"
                  >
                    <X className="size-4" />
                  </Button>
                ) : null}
              </div>
            ))}
            {options.length < 5 ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="gap-1.5"
                onClick={() => setOptions((prev) => [...prev, ""])}
              >
                <Plus className="size-3.5" /> Tambah opsi
              </Button>
            ) : null}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Batal
          </Button>
          <Button onClick={() => void send()} disabled={sending} className="gap-1.5">
            {sending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <BarChart3 className="size-4" />
            )}
            Kirim Polling
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
