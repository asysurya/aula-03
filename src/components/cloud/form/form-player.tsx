"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { format } from "date-fns";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  Circle,
  ClipboardList,
  Clock,
  Eye,
  EyeOff,
  FileUp,
  ImagePlus,
  Loader2,
  Play,
  Send,
  ShieldAlert,
  Timer,
  Upload,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import {
  questionTypeMeta,
  violationLabel,
  type FormAnswerDTO,
  type FormAttemptDTO,
  type FormQuestionDTO,
  type FormSettings,
  type FormSubmitResult,
  type FormViolation,
} from "@/lib/form-types";

// ── Local answer state ─────────────────────────────────────────────

interface LocalAnswer {
  text: string;
  optionIds: string[];
  fileId: string | null;
  fileName?: string | null;
}

function answersFromAttempt(
  attempt: FormAttemptDTO | null
): Record<string, LocalAnswer> {
  const out: Record<string, LocalAnswer> = {};
  for (const a of attempt?.answers ?? []) {
    out[a.questionId] = {
      text: a.text ?? "",
      optionIds: a.optionIds ?? [],
      fileId: a.fileId,
      fileName: a.file?.name ?? null,
    };
  }
  return out;
}

export function FormPlayer({
  folderId,
  form,
  attempt,
  canStart,
  deadlinePassed,
  deadlineLabel,
}: {
  folderId: string;
  form: (FormSettings & { id: string; questions: FormQuestionDTO[] }) | null;
  attempt: FormAttemptDTO | null;
  canStart: boolean;
  deadlinePassed: boolean;
  deadlineLabel: string;
}) {
  const qc = useQueryClient();

  // Phase: "intro" (belum mulai) | "playing" | "done"
  const existing = attempt?.status === "SUBMITTED";
  const [phase, setPhase] = useState<"intro" | "playing" | "done">(
    existing ? "done" : attempt ? "playing" : "intro"
  );
  const [starting, setStarting] = useState(false);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [questions, setQuestions] = useState<FormQuestionDTO[]>(
    form?.questions ?? []
  );
  const [settings, setSettings] = useState<FormSettings | null>(form ?? null);
  const [answers, setAnswers] = useState<Record<string, LocalAnswer>>(() =>
    answersFromAttempt(attempt)
  );
  const [currentIdx, setCurrentIdx] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [warning, setWarning] = useState<string | null>(null);
  const [result, setResult] = useState<FormSubmitResult | null>(null);
  const [remainingSec, setRemainingSec] = useState<number | null>(null);

  // Violations buffer + dirty flag for autosave
  const violationsRef = useRef<FormViolation[]>([]);
  const dirtyRef = useRef(false);
  const saveTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const invalidate = useCallback(() => {
    qc.invalidateQueries({ queryKey: ["cloud", "assignment", folderId] });
    qc.invalidateQueries({ queryKey: ["cloud", "assignment-form", folderId] });
  }, [qc, folderId]);

  const logViolation = useCallback(
    (type: FormViolation["type"], detail?: string) => {
      violationsRef.current.push({
        type,
        at: new Date().toISOString(),
        detail,
      });
      dirtyRef.current = true;
    },
    []
  );

  // ── Start attempt ─────────────────────────────────────────────────
  async function startAttempt() {
    setStarting(true);
    try {
      const res = await fetch(
        `/api/cloud/assignments/${folderId}/form/attempt`,
        { method: "POST" }
      );
      const json = await res.json();
      if (!res.ok) {
        if (json?.error === "ATTEMPT_EXISTS") {
          toast.error("Kamu sudah mulai mengerjakan tugas ini.");
          invalidate();
          return;
        }
        if (json?.error === "DEADLINE_PASSED") {
          toast.error("Tenggat sudah lewat — tidak bisa mulai.");
          invalidate();
          return;
        }
        toast.error(json?.error || "Gagal memulai tugas");
        return;
      }
      setQuestions(json.questions);
      setSettings(json.settings);
      setAnswers({});
      setCurrentIdx(0);
      setPhase("playing");
      toast.success("Pengerjaan dimulai — semangat!");
      invalidate();
    } finally {
      setStarting(false);
      setRulesOpen(false);
    }
  }

  // ── Autosave (every 5s if dirty) ─────────────────────────────────
  const persist = useCallback(async () => {
    if (phase !== "playing" || !dirtyRef.current) return;
    dirtyRef.current = false;
    const payload = {
      answers: Object.entries(answers).map(([questionId, a]) => ({
        questionId,
        text: a.text || null,
        optionIds: a.optionIds.length ? a.optionIds : null,
        fileId: a.fileId,
      })),
      violations: violationsRef.current.slice(-50),
    };
    try {
      await fetch(`/api/cloud/assignments/${folderId}/form/attempt`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      // keep buffer: server dedupes
    } catch {
      // autosave failures are silent; retried on next tick
      dirtyRef.current = true;
    }
  }, [answers, folderId, phase]);

  useEffect(() => {
    if (phase !== "playing") return;
    saveTimerRef.current = setInterval(() => void persist(), 5000);
    return () => {
      if (saveTimerRef.current) clearInterval(saveTimerRef.current);
    };
  }, [phase, persist]);

  // ── Timer countdown ───────────────────────────────────────────────
  const startedAt = attempt?.startedAt;
  const timeLimitMin = settings?.timeLimitMin ?? form?.timeLimitMin ?? null;

  useEffect(() => {
    if (phase !== "playing" || !timeLimitMin) {
      setRemainingSec(null);
      return;
    }
    const base = startedAt ? new Date(startedAt).getTime() : Date.now();
    function tick() {
      const elapsed = (Date.now() - base) / 1000;
      const left = Math.max(0, Math.round(timeLimitMin * 60 - elapsed));
      setRemainingSec(left);
      if (left <= 0) {
        // auto-submit
        void submit(true);
      }
    }
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);

  }, [phase, timeLimitMin, startedAt]);

  // ── Anti-cheat: tab switch / blur detection ───────────────────────
  useEffect(() => {
    if (phase !== "playing" || !settings?.trackTabSwitch) return;
    function onVisibility() {
      if (document.hidden) {
        logViolation("TAB_SWITCH", document.visibilityState);
        setWarning(
          "Kamu meninggalkan halaman! Perpindahan tab tercatat sebagai pelanggaran."
        );
      }
    }
    document.addEventListener("visibilitychange", onVisibility);
    return () =>
      document.removeEventListener("visibilitychange", onVisibility);
  }, [phase, settings?.trackTabSwitch, logViolation]);

  // ── Anti-cheat: block paste + context menu ────────────────────────
  const antiPasteHandlers = useMemo(() => {
    if (phase !== "playing" || !settings?.preventPaste)
      return {};
    return {
      onPaste: (e: React.ClipboardEvent) => {
        e.preventDefault();
        logViolation("PASTE");
        setWarning("Paste diblokir! Percobaan paste tercatat.");
      },
      onCopy: (e: React.ClipboardEvent) => e.preventDefault(),
      onCut: (e: React.ClipboardEvent) => e.preventDefault(),
      onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
    };
  }, [phase, settings?.preventPaste, logViolation]);

  // ── Submit ────────────────────────────────────────────────────────
  async function submit(auto = false) {
    if (submitting) return;
    setSubmitting(true);
    try {
      await persist(); // flush latest answers first
      const res = await fetch(
        `/api/cloud/assignments/${folderId}/form/attempt/submit`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ auto }),
        }
      );
      const json = await res.json();
      if (!res.ok) {
        toast.error(json?.error || "Gagal mengirim jawaban");
        return;
      }
      if (auto) logViolation("TIMEOUT");
      setResult(json as FormSubmitResult);
      setPhase("done");
      toast.success(
        auto ? "Waktu habis — jawaban otomatis dikirim." : "Jawaban terkirim!"
      );
      invalidate();
    } finally {
      setSubmitting(false);
      setConfirmOpen(false);
    }
  }

  // ── Answer mutators ───────────────────────────────────────────────
  function setText(questionId: string, text: string) {
    setAnswers((prev) => ({
      ...prev,
      [questionId]: { ...(prev[questionId] ?? { optionIds: [], fileId: null }), text },
    }));
    dirtyRef.current = true;
  }

  function selectOption(questionId: string, optionId: string, multi: boolean) {
    setAnswers((prev) => {
      const cur = prev[questionId] ?? { text: "", optionIds: [], fileId: null };
      let next: string[];
      if (multi) {
        next = cur.optionIds.includes(optionId)
          ? cur.optionIds.filter((o) => o !== optionId)
          : [...cur.optionIds, optionId];
      } else {
        next = cur.optionIds.includes(optionId) ? [] : [optionId];
      }
      return { ...prev, [questionId]: { ...cur, optionIds: next } };
    });
    dirtyRef.current = true;
  }

  async function uploadAnswerFile(
    questionId: string,
    file: File,
    isImage: boolean
  ) {
    if (isImage && !file.type.startsWith("image/")) {
      toast.error("Soal ini meminta upload gambar");
      return;
    }
    const fd = new FormData();
    fd.append("file", file);
    fd.append("questionId", questionId);
    try {
      const res = await fetch(
        `/api/cloud/assignments/${folderId}/form/answer-file`,
        { method: "POST", body: fd }
      );
      const json = await res.json();
      if (!res.ok) {
        toast.error(json?.error || "Gagal mengunggah jawaban");
        return;
      }
      setAnswers((prev) => ({
        ...prev,
        [questionId]: {
          text: "",
          optionIds: [],
          fileId: json.file.id,
          fileName: json.file.name,
        },
      }));
      dirtyRef.current = true;
      toast.success("File terunggah (MEGA)");
    } catch {
      toast.error("Gagal mengunggah jawaban");
    }
  }

  // ── Render helpers ────────────────────────────────────────────────
  const qs = questions;
  const current = qs[currentIdx];
  const oneByOne = settings?.oneByOne ?? true;
  const answeredCount = qs.filter((q) => {
    const a = answers[q.id];
    if (!a) return false;
    if (q.type === "PG" || q.type === "MULTI_PG") return a.optionIds.length > 0;
    if (q.type === "FILE" || q.type === "IMAGE") return !!a.fileId;
    return a.text.trim().length > 0;
  }).length;

  // ── INTRO (belum mulai) ───────────────────────────────────────────
  if (phase === "intro") {
    return (
      <Card className="p-5 space-y-4">
        <div className="flex items-start gap-3">
          <div className="rounded-md bg-primary/10 text-primary p-2.5">
            <ClipboardList className="size-6" />
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="font-semibold text-lg">Tugas Form</h3>
            <p className="text-sm text-muted-foreground">
              Tugas ini dikerjakan dalam bentuk formulir dengan pengawasan
              anti-nyontek.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-center">
          <MiniStat label="Jumlah soal" value={String(qs.length)} />
          <MiniStat
            label="Total poin"
            value={String(qs.reduce((s, q) => s + q.points, 0))}
          />
          <MiniStat
            label="Batas waktu"
            value={form?.timeLimitMin ? `${form.timeLimitMin} menit` : "—"}
          />
          <MiniStat
            label="Percobaan"
            value="1×"
          />
        </div>

        <div className="rounded-lg border border-border/60 bg-muted/40 p-3 space-y-1.5">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Aturan pengerjaan
          </p>
          <Rule text="Hanya ada satu kesempatan pengerjaan — tidak bisa diulang." />
          {form?.shuffleQuestions ? (
            <Rule text="Urutan soal diacak khusus untukmu." />
          ) : null}
          {form?.shuffleOptions ? <Rule text="Urutan opsi jawaban diacak." /> : null}
          {form?.oneByOne ? (
            <Rule text="Soal tampil satu per satu dan tidak bisa mundur." />
          ) : null}
          {form?.preventPaste ? (
            <Rule text="Copy-paste diblokir; percobaan paste tercatat." />
          ) : null}
          {form?.trackTabSwitch ? (
            <Rule text="Pindah tab / menutup jendela tercatat sebagai pelanggaran." />
          ) : null}
          {form?.timeLimitMin ? (
            <Rule text={`Timer ${form.timeLimitMin} menit — jawaban terkirim otomatis saat habis.`} />
          ) : null}
        </div>

        {deadlinePassed ? (
          <div className="flex items-center gap-2 rounded-md bg-destructive/10 text-destructive px-3 py-2 text-sm">
            <AlertTriangle className="size-4 shrink-0" />
            Tenggat sudah lewat — tugas tidak bisa dikerjakan lagi.
          </div>
        ) : (
          <div className="flex items-center justify-between flex-wrap gap-2">
            <span className="text-xs text-muted-foreground inline-flex items-center gap-1">
              <Clock className="size-3.5" /> Tenggat: {deadlineLabel}
            </span>
            <Button
              onClick={() => setRulesOpen(true)}
              disabled={starting}
            >
              {starting ? (
                <Loader2 className="size-4 animate-spin mr-1" />
              ) : (
                <Play className="size-4 mr-1" />
              )}
              Mulai Mengerjakan
            </Button>
          </div>
        )}

        <Dialog open={rulesOpen} onOpenChange={setRulesOpen}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <ShieldAlert className="size-5 text-primary" />
                Konfirmasi mulai pengerjaan
              </DialogTitle>
              <DialogDescription>
                Pastikan kamu siap — pengerjaan hanya bisa dilakukan{" "}
                <b>satu kali</b> dan tidak bisa dibatalkan.
              </DialogDescription>
            </DialogHeader>
            <ul className="text-sm space-y-2 list-disc pl-4">
              <li>Timer (jika ada) mulai berjalan saat kamu klik "Ya, mulai".</li>
              <li>Jangan berpindah tab — setiap perpindahan tercatat.</li>
              <li>Progress jawaban tersimpan otomatis tiap 5 detik.</li>
              {form?.timeLimitMin ? (
                <li>
                  Batas waktu <b>{form.timeLimitMin} menit</b>; jawaban dikirim
                  otomatis saat waktu habis.
                </li>
              ) : null}
            </ul>
            <DialogFooter>
              <Button variant="outline" onClick={() => setRulesOpen(false)}>
                Batal
              </Button>
              <Button onClick={() => void startAttempt()} disabled={starting}>
                {starting ? (
                  <Loader2 className="size-4 animate-spin mr-1" />
                ) : (
                  <Play className="size-4 mr-1" />
                )}
                Ya, mulai sekarang
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </Card>
    );
  }

  // ── DONE (submitted) ──────────────────────────────────────────────
  if (phase === "done") {
    const myAttempt = attempt;
    const score = result?.score ?? myAttempt?.score ?? null;
    const maxScore = result?.maxScore ?? myAttempt?.maxScore ?? 0;
    const showResult = result?.showResult ?? form?.showResult ?? false;
    return (
      <Card className="p-5 space-y-4">
        <div className="flex items-start gap-3">
          <div className="rounded-md bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 p-2.5">
            <CheckCircle2 className="size-6" />
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="font-semibold text-lg">Jawaban terkirim</h3>
            <p className="text-sm text-muted-foreground">
              {myAttempt?.submittedAt
                ? `Dikirim ${format(
                    new Date(myAttempt.submittedAt),
                    "d MMM yyyy, HH:mm"
                  )}`
                : "Terima kasih sudah mengerjakan."}
            </p>
          </div>
        </div>

        {showResult && score != null ? (
          <div className="rounded-lg border border-primary/30 bg-primary/10 p-4 text-center">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">
              Nilai
            </p>
            <p className="text-3xl font-bold text-primary tabular-nums">
              {score}
              <span className="text-lg text-muted-foreground"> / {maxScore}</span>
            </p>
            {result?.results ? (
              <p className="text-xs text-muted-foreground mt-1">
                {result.results.filter((r) => r.auto && r.correct).length} soal
                objektif benar dari{" "}
                {result.results.filter((r) => r.auto).length} — soal esai/upload
                menunggu penilaian guru.
              </p>
            ) : null}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            Nilai akan diberitahukan oleh guru setelah penilaian selesai.
          </p>
        )}

        {myAttempt && myAttempt.violations.length > 0 ? (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 space-y-1">
            <p className="text-xs font-semibold text-amber-600 dark:text-amber-400 uppercase tracking-wide">
              Catatan pengerjaan ({myAttempt.violations.length})
            </p>
            {myAttempt.violations.slice(0, 5).map((v, i) => (
              <p key={i} className="text-xs text-muted-foreground">
                • {violationLabel(v)} — {format(new Date(v.at), "HH:mm:ss")}
              </p>
            ))}
          </div>
        ) : null}
      </Card>
    );
  }

  // ── PLAYING ───────────────────────────────────────────────────────
  const timerDanger = remainingSec != null && remainingSec <= 60;
  const minutes = remainingSec != null ? Math.floor(remainingSec / 60) : 0;
  const seconds = remainingSec != null ? remainingSec % 60 : 0;

  return (
    <div
      className="space-y-4 select-none"
      {...antiPasteHandlers}
    >
      {/* Warning banner */}
      {warning ? (
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 text-sm">
          <AlertTriangle className="size-4 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
          <span className="flex-1">{warning}</span>
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground"
            onClick={() => setWarning(null)}
            aria-label="Tutup peringatan"
          >
            ✕
          </button>
        </div>
      ) : null}

      {/* Status bar */}
      <Card className="p-3 space-y-2.5">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-2">
            <Badge variant="secondary" className="gap-1">
              <EyeOff className="size-3" /> Mode anti-nyontek aktif
            </Badge>
            <span className="text-xs text-muted-foreground">
              Terjawab {answeredCount}/{qs.length}
            </span>
          </div>
          {remainingSec != null ? (
            <span
              className={cn(
                "inline-flex items-center gap-1.5 font-mono text-sm font-semibold tabular-nums px-2.5 py-1 rounded-md",
                timerDanger
                  ? "bg-destructive/15 text-destructive animate-pulse"
                  : "bg-secondary"
              )}
            >
              <Timer className="size-3.5" />
              {minutes}:{String(seconds).padStart(2, "0")}
            </span>
          ) : null}
        </div>
        <Progress
          value={
            oneByOne
              ? ((currentIdx + 1) / qs.length) * 100
              : (answeredCount / Math.max(1, qs.length)) * 100
          }
          className="h-1.5"
        />
      </Card>

      {oneByOne && current ? (
        <QuestionCard
          q={current}
          index={currentIdx}
          total={qs.length}
          answer={answers[current.id]}
          onText={(t) => setText(current.id, t)}
          onSelect={(oid) =>
            selectOption(current.id, oid, current.type === "MULTI_PG")
          }
          onUpload={(f) =>
            void uploadAnswerFile(
              current.id,
              f,
              current.type === "IMAGE"
            )
          }
          handlers={antiPasteHandlers}
        />
      ) : (
        <div className="space-y-4">
          {qs.map((q, i) => (
            <QuestionCard
              key={q.id}
              q={q}
              index={i}
              total={qs.length}
              answer={answers[q.id]}
              onText={(t) => setText(q.id, t)}
              onSelect={(oid) =>
                selectOption(q.id, oid, q.type === "MULTI_PG")
              }
              onUpload={(f) =>
                void uploadAnswerFile(q.id, f, q.type === "IMAGE")
              }
              handlers={antiPasteHandlers}
            />
          ))}
        </div>
      )}

      {/* Bottom bar */}
      <div className="flex items-center justify-between gap-2 flex-wrap sticky bottom-0 bg-background/90 backdrop-blur border-t border-border pt-3 pb-1">
        {oneByOne ? (
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground tabular-nums">
              Soal {currentIdx + 1} / {qs.length}
            </span>
            <Button
              size="sm"
              disabled={currentIdx === qs.length - 1}
              onClick={() =>
                setCurrentIdx((i) => Math.min(qs.length - 1, i + 1))
              }
            >
              Berikutnya <ChevronRight className="size-4" />
            </Button>
          </div>
        ) : (
          <span className="text-xs text-muted-foreground">
            {answeredCount} dari {qs.length} soal terjawab
          </span>
        )}
        <Button
          onClick={() => setConfirmOpen(true)}
          disabled={submitting}
          className="bg-emerald-600 hover:bg-emerald-700"
        >
          {submitting ? (
            <Loader2 className="size-4 animate-spin mr-1" />
          ) : (
            <Send className="size-4 mr-1" />
          )}
          Kumpulkan Jawaban
        </Button>
      </div>

      {/* Confirm dialog */}
      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Kumpulkan jawaban?</DialogTitle>
            <DialogDescription>
              Jawaban akan dikirim dan <b>tidak bisa diubah lagi</b>.
            </DialogDescription>
          </DialogHeader>
          <div className="text-sm space-y-1.5">
            <p>
              Terjawab:{" "}
              <b className={answeredCount === qs.length ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400"}>
                {answeredCount}/{qs.length}
              </b>{" "}
              soal
            </p>
            {answeredCount < qs.length ? (
              <p className="text-xs text-muted-foreground">
                Soal yang belum dijawab akan tetap kosong (0 poin) — kecuali
                tidak wajib.
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)}>
              Periksa lagi
            </Button>
            <Button
              onClick={() => void submit(false)}
              disabled={submitting}
              className="bg-emerald-600 hover:bg-emerald-700"
            >
              {submitting ? (
                <Loader2 className="size-4 animate-spin mr-1" />
              ) : (
                <Send className="size-4 mr-1" />
              )}
              Ya, kumpulkan
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── Sub-components ─────────────────────────────────────────────────

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-card p-2.5">
      <p className="text-lg font-bold tabular-nums">{value}</p>
      <p className="text-[10px] text-muted-foreground uppercase tracking-wide">
        {label}
      </p>
    </div>
  );
}

function Rule({ text }: { text: string }) {
  return (
    <p className="text-xs text-muted-foreground flex items-start gap-1.5">
      <span className="text-primary mt-px">•</span>
      {text}
    </p>
  );
}

function QuestionCard({
  q,
  index,
  total,
  answer,
  onText,
  onSelect,
  onUpload,
  handlers,
}: {
  q: FormQuestionDTO;
  index: number;
  total: number;
  answer: LocalAnswer | undefined;
  onText: (t: string) => void;
  onSelect: (optionId: string) => void;
  onUpload: (file: File) => void;
  handlers: React.HTMLAttributes<HTMLDivElement>;
}) {
  const meta = questionTypeMeta(q.type);
  const [uploading, setUploading] = useState(false);

  const multi = q.type === "MULTI_PG";

  return (
    <Card className="p-4 sm:p-5 space-y-4">
      {/* Question header */}
      <div className="flex items-start justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          <Badge className="bg-primary/15 text-primary border-transparent font-mono">
            Soal {index + 1}/{total}
          </Badge>
          <Badge variant="outline" className="text-[10px]">
            {meta.label}
          </Badge>
          <Badge variant="secondary" className="text-[10px]">
            {q.points} poin
          </Badge>
          {q.required ? (
            <span className="text-[10px] text-destructive">wajib</span>
          ) : (
            <span className="text-[10px] text-muted-foreground">opsional</span>
          )}
        </div>
      </div>

      {/* Question text */}
      <p className="text-base font-medium whitespace-pre-wrap leading-relaxed">
        {q.text}
      </p>

      {/* Question image */}
      {q.imageFile ? (

        <img
          src={`/api/storage/${q.imageFile.storageKey}`}
          alt={q.imageFile.name}
          className="max-h-72 rounded-lg border border-border object-contain"
        />
      ) : null}

      <Separator />

      {/* Answer inputs */}
      {q.type === "PG" || q.type === "MULTI_PG" ? (
        <div className="space-y-2" {...handlers}>
          {q.options.map((o, i) => {
            const selected = answer?.optionIds.includes(o.id) ?? false;
            return (
              <button
                key={o.id}
                type="button"
                onClick={() => onSelect(o.id)}
                className={cn(
                  "flex items-center gap-3 w-full rounded-lg border px-3.5 py-3 text-left text-sm transition-all",
                  selected
                    ? "border-primary bg-primary/10 shadow-sm"
                    : "border-border hover:border-primary/40 hover:bg-accent/40"
                )}
              >
                <span
                  className={cn(
                    "flex items-center justify-center shrink-0 font-semibold text-xs",
                    multi ? "size-5 rounded-md border-2" : "size-5 rounded-full border-2",
                    selected
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-muted-foreground/40"
                  )}
                >
                  {selected ? "✓" : String.fromCharCode(65 + i)}
                </span>
                <span className="flex-1">{o.label}</span>
              </button>
            );
          })}
          {multi ? (
            <p className="text-[11px] text-muted-foreground">
              Pilih semua jawaban yang benar.
            </p>
          ) : null}
        </div>
      ) : null}

      {q.type === "SHORT" ? (
        <div className="space-y-1.5" {...handlers}>
          <Label>Jawaban singkat</Label>
          <Input
            value={answer?.text ?? ""}
            onChange={(e) => onText(e.target.value)}
            placeholder="Tulis jawaban singkat…"
            maxLength={500}
          />
        </div>
      ) : null}

      {q.type === "ESSAY" ? (
        <div className="space-y-1.5" {...handlers}>
          <Label>Jawaban esai</Label>
          <Textarea
            value={answer?.text ?? ""}
            onChange={(e) => onText(e.target.value)}
            rows={6}
            maxLength={8000}
            placeholder="Tulis jawabanmu di sini…"
          />
          <p className="text-[11px] text-muted-foreground text-right">
            {(answer?.text ?? "").length}/8000
          </p>
        </div>
      ) : null}

      {q.type === "FILE" || q.type === "IMAGE" ? (
        <div className="space-y-2">
          {answer?.fileId ? (
            <div className="flex items-center gap-2 rounded-lg border border-primary/40 bg-primary/10 px-3 py-2.5">
              <CheckCircle2 className="size-4 text-primary shrink-0" />
              <span className="text-sm truncate flex-1">
                {answer.fileName ?? "File terunggah"}
              </span>
              <Badge variant="secondary" className="text-[10px] shrink-0">
                tersimpan
              </Badge>
            </div>
          ) : (
            <label
              className="flex flex-col items-center gap-1.5 rounded-lg border-2 border-dashed border-border hover:border-primary/50 hover:bg-accent/30 transition-colors px-4 py-8 text-center cursor-pointer"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const f = e.dataTransfer.files?.[0];
                if (f && !uploading) {
                  setUploading(true);
                  onUpload(f);
                }
              }}
            >
              {uploading ? (
                <Loader2 className="size-7 animate-spin text-muted-foreground" />
              ) : q.type === "IMAGE" ? (
                <ImagePlus className="size-7 text-muted-foreground" />
              ) : (
                <FileUp className="size-7 text-muted-foreground" />
              )}
              <p className="text-sm font-medium">
                {uploading
                  ? "Mengunggah…"
                  : q.type === "IMAGE"
                    ? "Unggah foto jawaban (klik / tarik gambar)"
                    : "Unggah file jawaban (klik / tarik file)"}
              </p>
              <p className="text-xs text-muted-foreground">
                Maks 100 MB · tersimpan di cloud MEGA
              </p>
              <input
                type="file"
                accept={q.type === "IMAGE" ? "image/*" : undefined}
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) {
                    setUploading(true);
                    onUpload(f);
                  }
                }}
              />
            </label>
          )}
        </div>
      ) : null}
    </Card>
  );
}
