"use client";

// Mode Flashcard — kartu belajar dari soal tugas (khusus soal PG dengan
// kunci yang sudah terbuka setelah submit). Klik kartu untuk membalik:
// depan = soal, belakang = opsi + jawaban benar + jawabanmu. Navigasi
// sebelum/berikutnya + acak.

import { useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Layers,
  RotateCw,
  Shuffle,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { FormQuestionDTO } from "@/lib/form-types";

interface FlashcardQ {
  q: FormQuestionDTO;
  myOptionIds: string[];
}

export function Flashcards({
  questions,
  answersByQuestion,
  onClose,
}: {
  questions: FormQuestionDTO[];
  answersByQuestion: Record<string, string[]>;
  onClose: () => void;
}) {
  const [deck, setDeck] = useState<FlashcardQ[]>(() =>
    questions.map((q) => ({ q, myOptionIds: answersByQuestion[q.id] ?? [] }))
  );
  const [idx, setIdx] = useState(0);
  const [flipped, setFlipped] = useState(false);

  const card = deck[idx];
  if (!card) return null;

  function next() {
    setFlipped(false);
    setIdx((i) => Math.min(deck.length - 1, i + 1));
  }
  function prev() {
    setFlipped(false);
    setIdx((i) => Math.max(0, i - 1));
  }
  function shuffle() {
    setFlipped(false);
    setDeck((d) => [...d].sort(() => Math.random() - 0.5));
    setIdx(0);
  }
  function restart() {
    setFlipped(false);
    setIdx(0);
  }

  const correct = card.q.correct ?? [];
  const myAnswer = card.myOptionIds;

  return (
    <div className="fixed inset-0 z-[70] flex flex-col bg-background/95 backdrop-blur">
      {/* Header */}
      <div className="flex items-center justify-between gap-2 px-4 py-3 border-b border-border">
        <div className="flex items-center gap-2 min-w-0">
          <Layers className="size-5 text-cyan-500 shrink-0" />
          <div className="min-w-0">
            <p className="font-semibold text-sm truncate">Mode Flashcard</p>
            <p className="text-[11px] text-muted-foreground">
              Kartu {idx + 1} dari {deck.length} — klik kartu untuk membalik
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <Button variant="ghost" size="icon" onClick={shuffle} title="Acak kartu">
            <Shuffle className="size-4" />
          </Button>
          <Button variant="ghost" size="icon" onClick={restart} title="Ulang dari awal">
            <RotateCw className="size-4" />
          </Button>
          <Button variant="ghost" size="icon" onClick={onClose} title="Keluar">
            <X className="size-4" />
          </Button>
        </div>
      </div>

      {/* Kartu */}
      <div className="flex-1 flex items-center justify-center p-4">
        <button
          type="button"
          onClick={() => setFlipped((f) => !f)}
          className={cn(
            "w-full max-w-xl rounded-2xl border-2 p-6 text-left transition-all duration-200 select-none",
            "min-h-[300px] flex flex-col",
            flipped
              ? "border-cyan-500/40 bg-cyan-500/5"
              : "border-border bg-card hover:border-cyan-500/30"
          )}
        >
          {flipped ? (
            <>
              <p className="text-[10px] font-semibold uppercase tracking-wide text-cyan-600 dark:text-cyan-400 mb-3">
                Jawaban
              </p>
              <p className="text-sm text-muted-foreground whitespace-pre-wrap leading-relaxed mb-4">
                {card.q.text}
              </p>
              <div className="space-y-2 flex-1">
                {card.q.options.map((o) => {
                  const isCorrect = correct.includes(o.id);
                  const isMine = myAnswer.includes(o.id);
                  return (
                    <div
                      key={o.id}
                      className={cn(
                        "flex items-center gap-2 rounded-lg border px-3 py-2 text-sm",
                        isCorrect
                          ? "border-emerald-500 bg-emerald-500/10"
                          : isMine
                            ? "border-destructive/50 bg-destructive/10"
                            : "border-border"
                      )}
                    >
                      <span className="flex-1">{o.label}</span>
                      {isCorrect ? (
                        <Badge className="bg-emerald-500 text-white border-transparent text-[9px]">
                          kunci
                        </Badge>
                      ) : null}
                      {isMine && !isCorrect ? (
                        <Badge variant="secondary" className="text-[9px]">
                          jawabanmu
                        </Badge>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </>
          ) : (
            <>
              <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground mb-3">
                Soal · {card.q.points} poin
              </p>
              <p className="text-lg font-medium whitespace-pre-wrap leading-relaxed flex-1">
                {card.q.text}
              </p>
              <p className="text-[11px] text-muted-foreground mt-4 text-center">
                Ketuk kartu ini untuk melihat jawaban
              </p>
            </>
          )}
        </button>
      </div>

      {/* Navigasi */}
      <div className="flex items-center justify-between gap-2 px-4 py-3 border-t border-border">
        <Button variant="outline" onClick={prev} disabled={idx === 0} className="gap-1.5">
          <ChevronLeft className="size-4" /> Sebelumnya
        </Button>
        <div className="flex gap-1.5">
          {deck.map((_, i) => (
            <span
              key={i}
              className={cn(
                "size-1.5 rounded-full transition-colors",
                i === idx ? "bg-primary" : "bg-muted-foreground/30"
              )}
            />
          ))}
        </div>
        <Button
          variant="outline"
          onClick={next}
          disabled={idx === deck.length - 1}
          className="gap-1.5"
        >
          Berikutnya <ChevronRight className="size-4" />
        </Button>
      </div>
    </div>
  );
}
