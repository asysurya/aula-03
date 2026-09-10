"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { toast } from "sonner";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  ClipboardCheck,
  Download,
  Eye,
  Loader2,
  ShieldAlert,
  Users,
  XCircle,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { FilePreview } from "@/components/cloud/file-preview";
import type { CloudFileItem } from "@/lib/cloud-format";
import { cn } from "@/lib/utils";
import {
  questionTypeMeta,
  violationLabel,
  type FormAnswerDTO,
  type FormQuestionDTO,
} from "@/lib/form-types";

// ── Wire types for review endpoint ─────────────────────────────────

interface ReviewAnswer extends FormAnswerDTO {
  id: string;
}

interface ReviewAttempt {
  id: string;
  user: { id: string; name: string; username: string };
  status: "IN_PROGRESS" | "SUBMITTED";
  startedAt: string;
  submittedAt: string | null;
  score: number | null;
  maxScore: number;
  violations: { type: string; at: string; detail?: string }[];
  answers: ReviewAnswer[];
}

interface ReviewQuestion {
  id: string;
  type: string;
  text: string;
  points: number;
  required: boolean;
  order: number;
  options: { id: string; label: string }[];
  correct: string[];
  imageFileId: string | null;
}

interface ReviewResponse {
  form: { id: string; timeLimitMin: number | null; showResult: boolean };
  questions: ReviewQuestion[];
  attempts: ReviewAttempt[];
  roster: {
    user: { id: string; name: string; username: string };
    role: string;
    hasAttempt: boolean;
    status: string | null;
  }[];
}

export function FormReview({ folderId }: { folderId: string }) {
  const qc = useQueryClient();
  const { data, isLoading, error, refetch } = useQuery<ReviewResponse>({
    queryKey: ["cloud", "form-review", folderId],
    queryFn: async () => {
      const res = await fetch(
        `/api/cloud/assignments/${folderId}/form/attempts`,
        { cache: "no-store" }
      );
      if (!res.ok) throw new Error("Gagal memuat data pengerjaan");
      return res.json();
    },
    refetchInterval: 10_000,
  });

  if (isLoading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-8 w-1/2" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }
  if (error || !data) {
    return (
      <div className="p-4 text-center text-sm text-destructive">
        Gagal memuat data.{" "}
        <Button variant="link" onClick={() => refetch()}>
          Coba lagi
        </Button>
      </div>
    );
  }

  const submitted = data.attempts.filter((a) => a.status === "SUBMITTED");
  const inProgress = data.attempts.filter((a) => a.status === "IN_PROGRESS");
  const notStarted = data.roster.filter(
    (r) => r.role === "STUDENT" && !r.hasAttempt
  );
  const flagged = submitted.filter((a) => a.violations.length > 0);
  const avg =
    submitted.length > 0
      ? Math.round(
          submitted.reduce((s, a) => s + (a.score ?? 0), 0) / submitted.length
        )
      : null;

  return (
    <div className="space-y-4">
      {/* Summary */}
      <div className="flex items-center gap-2 flex-wrap">
        <Users className="size-4 text-muted-foreground" />
        <span className="text-sm font-medium">
          {submitted.length} terkumpul · {inProgress.length} sedang mengerjakan
          · {notStarted.length} belum mulai
        </span>
        {avg != null ? <Badge variant="outline">Rata-rata {avg}</Badge> : null}
        {flagged.length > 0 ? (
          <Badge className="bg-amber-500/15 text-amber-600 dark:text-amber-400 border border-amber-500/30">
            <ShieldAlert className="size-3" /> {flagged.length} terindikasi
            pelanggaran
          </Badge>
        ) : null}
      </div>

      {/* Attempts list */}
      <div className="space-y-3">
        {data.attempts.map((a) => (
          <AttemptCard
            key={a.id}
            folderId={folderId}
            attempt={a}
            questions={data.questions}
            onGraded={() =>
              qc.invalidateQueries({
                queryKey: ["cloud", "form-review", folderId],
              })
            }
          />
        ))}
        {data.attempts.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-6">
            Belum ada siswa yang membuka tugas ini.
          </p>
        ) : null}
      </div>
    </div>
  );
}

function AttemptCard({
  folderId,
  attempt,
  questions,
  onGraded,
}: {
  folderId: string;
  attempt: ReviewAttempt;
  questions: ReviewQuestion[];
  onGraded: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [previewFile, setPreviewFile] = useState<CloudFileItem | null>(null);
  const answerByQ = new Map(attempt.answers.map((a) => [a.questionId, a]));

  const submitted = attempt.status === "SUBMITTED";

  const toPreviewItem = (
    f: NonNullable<FormAnswerDTO["file"]>
  ): CloudFileItem => ({
    id: f.id,
    name: f.name,
    size: f.size,
    mimetype: f.mimetype,
    storageKey: f.storageKey,
    cloudAccountId: null,
    createdAt: new Date().toISOString(),
    uploadedBy: "",
    uploader: {
      id: attempt.user.id,
      name: attempt.user.name,
      username: attempt.user.username,
    },
    visibility: "ALL",
  });

  return (
    <Card className="overflow-hidden">
      {/* Header row */}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-3 w-full px-4 py-3 hover:bg-accent/40 transition-colors text-left"
      >
        {open ? (
          <ChevronDown className="size-4 text-muted-foreground shrink-0" />
        ) : (
          <ChevronRight className="size-4 text-muted-foreground shrink-0" />
        )}
        <div className="flex-1 min-w-0">
          <p className="font-medium text-sm truncate">{attempt.user.name}</p>
          <p className="text-xs text-muted-foreground truncate">
            @{attempt.user.username} · mulai{" "}
            {format(new Date(attempt.startedAt), "d MMM HH:mm")}
            {attempt.submittedAt
              ? ` · kirim ${format(new Date(attempt.submittedAt), "HH:mm")}`
              : " · belum dikumpulkan"}
          </p>
        </div>
        {attempt.violations.length > 0 ? (
          <Badge className="bg-amber-500/15 text-amber-600 dark:text-amber-400 border border-amber-500/30 gap-1 shrink-0">
            <AlertTriangle className="size-3" />
            {attempt.violations.length}
          </Badge>
        ) : null}
        <Badge variant="outline" className="shrink-0 gap-1">
          {submitted ? (
            <>
              <CheckCircle2 className="size-3 text-emerald-500" />
              {attempt.score != null
                ? `${attempt.score}/${attempt.maxScore}`
                : "—"}
            </>
          ) : (
            <>
              <Loader2 className="size-3 animate-spin" />
              Berlangsung
            </>
          )}
        </Badge>
      </button>

      {/* Expanded detail */}
      {open ? (
        <div className="border-t border-border px-4 py-4 space-y-4">
          {/* Violations log */}
          {attempt.violations.length > 0 ? (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 space-y-1.5">
              <p className="text-xs font-semibold uppercase tracking-wide text-amber-600 dark:text-amber-400 flex items-center gap-1.5">
                <ShieldAlert className="size-3.5" /> Log pelanggaran
                anti-nyontek
              </p>
              {attempt.violations.slice(0, 20).map((v, i) => (
                <p
                  key={i}
                  className="text-xs text-muted-foreground flex items-start gap-1.5"
                >
                  <span className="text-amber-500">•</span>
                  <span>
                    {violationLabel(v as never)} —{" "}
                    {format(new Date(v.at), "HH:mm:ss")}
                    {v.detail ? ` (${v.detail})` : ""}
                  </span>
                </p>
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground flex items-center gap-1.5">
              <CheckCircle2 className="size-3.5 text-emerald-500" />
              Tidak ada pelanggaran tercatat.
            </p>
          )}

          {/* Answers per question */}
          <div className="space-y-3">
            {questions.map((q, i) => (
              <AnswerRow
                key={q.id}
                folderId={folderId}
                q={q as unknown as FormQuestionDTO}
                index={i}
                answer={answerByQ.get(q.id)}
                submitted={submitted}
                onGraded={onGraded}
                onPreviewFile={(f) => setPreviewFile(toPreviewItem(f))}
              />
            ))}
          </div>
        </div>
      ) : null}

      {/* Pratinjau file jawaban — tanpa download */}
      <FilePreview file={previewFile} onClose={() => setPreviewFile(null)} />
    </Card>
  );
}

function AnswerRow({
  folderId,
  q,
  index,
  answer,
  submitted,
  onGraded,
  onPreviewFile,
}: {
  folderId: string;
  q: FormQuestionDTO;
  index: number;
  answer: ReviewAnswer | undefined;
  submitted: boolean;
  onGraded: () => void;
  onPreviewFile: (file: NonNullable<FormAnswerDTO["file"]>) => void;
}) {
  const meta = questionTypeMeta(q.type);
  const [scoreInput, setScoreInput] = useState<string>(
    answer?.score != null ? String(answer.score) : ""
  );
  const [saving, setSaving] = useState(false);

  const selected = answer?.optionIds ?? [];
  const correct = q.correct ?? [];
  const isAuto = meta.autoGradable;
  const isCorrect =
    isAuto &&
    selected.length === correct.length &&
    correct.every((c) => selected.includes(c));
  const answered = selected.length > 0 || !!answer?.text || !!answer?.fileId;

  async function saveScore() {
    if (!answer || scoreInput === "") {
      toast.error("Isi nilai dulu");
      return;
    }
    const score = parseInt(scoreInput, 10);
    if (Number.isNaN(score) || score < 0 || score > q.points) {
      toast.error(`Nilai harus 0–${q.points}`);
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(
        `/api/cloud/assignments/${folderId}/form/attempts`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ answerId: answer.id, score }),
        }
      );
      if (!res.ok) {
        const json = await res.json().catch(() => null);
        toast.error(json?.error || "Gagal menyimpan nilai");
        return;
      }
      toast.success("Nilai tersimpan");
      onGraded();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-lg border border-border p-3 space-y-2">
      <div className="flex items-start justify-between gap-2 flex-wrap">
        <p className="text-sm font-medium flex items-start gap-2 min-w-0 flex-1">
          <span className="text-muted-foreground font-mono text-xs shrink-0 mt-0.5">
            #{index + 1}
          </span>
          <span className="truncate">{q.text}</span>
        </p>
        <div className="flex items-center gap-1.5 shrink-0">
          <Badge variant="secondary" className="text-[10px]">
            {meta.label} · {q.points} poin
          </Badge>
          {isAuto && answered ? (
            isCorrect ? (
              <CheckCircle2 className="size-4 text-emerald-500" />
            ) : (
              <XCircle className="size-4 text-destructive" />
            )
          ) : null}
        </div>
      </div>

      {/* Option review */}
      {meta.hasOptions ? (
        <div className="space-y-1">
          {q.options.map((o) => {
            const isSelected = selected.includes(o.id);
            const isRight = correct.includes(o.id);
            return (
              <div
                key={o.id}
                className={cn(
                  "flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm border",
                  isRight
                    ? "border-emerald-500/40 bg-emerald-500/10"
                    : isSelected
                      ? "border-destructive/40 bg-destructive/10"
                      : "border-border"
                )}
              >
                <span className="flex-1">{o.label}</span>
                {isRight ? (
                  <Badge className="bg-emerald-500 text-white border-transparent text-[9px]">
                    kunci
                  </Badge>
                ) : null}
                {isSelected ? (
                  <Badge variant="secondary" className="text-[9px]">
                    dipilih
                  </Badge>
                ) : null}
              </div>
            );
          })}
          {!answered ? (
            <p className="text-xs text-muted-foreground italic">
              Tidak dijawab.
            </p>
          ) : null}
        </div>
      ) : null}

      {/* Text answer */}
      {answer?.text ? (
        <div className="rounded-md bg-muted/50 border border-border px-3 py-2 text-sm whitespace-pre-wrap max-h-40 overflow-y-auto">
          {answer.text}
        </div>
      ) : meta.isText && !answer?.text ? (
        <p className="text-xs text-muted-foreground italic">Tidak dijawab.</p>
      ) : null}

      {/* File answer */}
      {answer?.file ? (
        <div className="flex items-center gap-1.5 flex-wrap">
          <Button
            size="sm"
            variant="outline"
            className="h-8 gap-2"
            onClick={() => onPreviewFile(answer.file!)}
            title="Pratinjau tanpa download"
          >
            <Eye className="size-3.5" />
            <span className="truncate max-w-[240px]">{answer.file.name}</span>
          </Button>
          <Button asChild size="sm" variant="ghost" className="h-8">
            <a
              href={`/api/storage/${answer.file.storageKey}?download=1`}
              target="_blank"
              rel="noopener noreferrer"
              download={answer.file.name}
              title="Unduh"
            >
              <Download className="size-3.5" />
            </a>
          </Button>
        </div>
      ) : meta.isUpload && !answer?.fileId ? (
        <p className="text-xs text-muted-foreground italic">
          Tidak ada file terunggah.
        </p>
      ) : null}

      {/* Manual grading */}
      {!isAuto && answer && submitted ? (
        <div className="flex items-center gap-2 pt-1 flex-wrap">
          <Input
            className="w-20 h-8"
            inputMode="numeric"
            placeholder="0"
            value={scoreInput}
            onChange={(e) =>
              setScoreInput(e.target.value.replace(/[^0-9]/g, "").slice(0, 3))
            }
          />
          <span className="text-xs text-muted-foreground">/ {q.points} poin</span>
          <Button size="sm" className="h-8" onClick={() => void saveScore()}>
            {saving ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <ClipboardCheck className="size-3.5" />
            )}
            Nilai
          </Button>
          {answer?.score != null ? (
            <Badge variant="secondary" className="gap-1">
              <CheckCircle2 className="size-3 text-emerald-500" />
              {answer.score} tersimpan
            </Badge>
          ) : null}
        </div>
      ) : null}
      {!isAuto && !submitted ? (
        <p className="text-[11px] text-muted-foreground">
          Bisa dinilai setelah siswa mengumpulkan jawaban.
        </p>
      ) : null}
    </div>
  );
}
