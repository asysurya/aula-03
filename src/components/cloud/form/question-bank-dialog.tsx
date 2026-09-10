"use client";

// Dialog Bank Soal — daftar soal pribadi guru (tersimpan di server, ikut
// lintas perangkat). Pilih soal untuk dimasukkan ke form builder.

import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { BookOpen, Loader2, Plus, Search, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { questionTypeMeta, type FormIOParsedQuestion } from "@/lib/form-types";

interface BankQuestion {
  id: string;
  type: string;
  text: string;
  points: number;
  options: { id: string; label: string }[];
  correct: string[] | null;
  createdAt: string;
}

export function QuestionBankDialog({
  open,
  onOpenChange,
  onPick,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onPick: (q: FormIOParsedQuestion) => void;
}) {
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");

  useEffect(() => {
    const t = setTimeout(() => setQ(search.trim().toLowerCase()), 250);
    return () => clearTimeout(t);
  }, [search]);

  const { data, isLoading } = useQuery<{ questions: BankQuestion[] }>({
    queryKey: ["question-bank", q],
    queryFn: async () => {
      const res = await fetch(`/api/forms/question-bank?q=${encodeURIComponent(q)}`, {
        cache: "no-store",
      });
      if (!res.ok) throw new Error("Gagal memuat bank soal");
      return res.json();
    },
    enabled: open,
  });

  const items = (data?.questions ?? []).filter((it) =>
    q ? it.text.toLowerCase().includes(q) : true
  );

  async function remove(id: string) {
    const res = await fetch(`/api/forms/question-bank/${id}`, {
      method: "DELETE",
    });
    if (res.ok) {
      toast.success("Soal dihapus dari bank");
      void qc.invalidateQueries({ queryKey: ["question-bank"] });
    } else {
      toast.error("Gagal menghapus soal");
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <BookOpen className="size-5 text-primary" /> Bank Soal Saya
          </DialogTitle>
          <DialogDescription>
            Soal yang kamu simpan — bisa dipakai ulang di tugas mana pun.
          </DialogDescription>
        </DialogHeader>

        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Cari teks soal…"
            className="pl-8"
          />
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto rounded-lg border border-border divide-y divide-border">
          {isLoading ? (
            <div className="p-3 space-y-2">
              <Skeleton className="h-14 w-full" />
              <Skeleton className="h-14 w-full" />
            </div>
          ) : items.length === 0 ? (
            <div className="p-6 text-center text-sm text-muted-foreground">
              <BookOpen className="size-6 mx-auto mb-2 opacity-40" />
              {q
                ? "Tidak ada soal yang cocok."
                : "Bank soal kosong — simpan soal lewat tombol buku pada setiap soal di builder."}
            </div>
          ) : (
            items.map((it) => (
              <div key={it.id} className="flex items-start gap-2.5 px-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="text-sm line-clamp-2">{it.text}</p>
                  <p className="text-[10px] text-muted-foreground mt-0.5">
                    {questionTypeMeta(it.type).label} · {it.points} poin
                    {it.correct && it.correct.length > 0 ? " · ada kunci" : ""}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 px-2 gap-1 shrink-0"
                  onClick={() => {
                    onPick({
                      type: it.type as FormIOParsedQuestion["type"],
                      text: it.text,
                      points: it.points,
                      required: true,
                      options: it.options.map((o) => ({ ...o })),
                      correct: it.correct ?? [],
                    });
                    onOpenChange(false);
                    toast.success("Soal ditambahkan dari bank");
                  }}
                >
                  <Plus className="size-3" /> Pakai
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-7 shrink-0 text-muted-foreground hover:text-destructive"
                  onClick={() => void remove(it.id)}
                  aria-label="Hapus dari bank"
                  title="Hapus dari bank"
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
            ))
          )}
        </div>

        <p className="text-[10px] text-muted-foreground flex items-center gap-1">
          <Loader2 className="size-3 opacity-0" />
          Bank soal tersimpan di akunmu — aman lintas perangkat.
        </p>
      </DialogContent>
    </Dialog>
  );
}
