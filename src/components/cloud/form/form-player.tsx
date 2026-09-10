"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { format } from "date-fns";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Circle,
  ClipboardList,
  Clock,
  Eye,
  EyeOff,
  FileUp,
  Gamepad2,
  ImagePlus,
  ListChecks,
  Loader2,
  Maximize2,
  Minimize2,
  Play,
  RotateCcw,
  Send,
  ShieldAlert,
  Timer,
  Trophy,
  Upload,
  Zap,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { uploadSmart } from "@/lib/upload-client";
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
  attemptsUsed = 1,
  canRetry = false,
}: {
  folderId: string;
  form: (FormSettings & { id: string; questions: FormQuestionDTO[] }) | null;
  attempt: FormAttemptDTO | null;
  canStart: boolean;
  deadlinePassed: boolean;
  deadlineLabel: string;
  attemptsUsed?: number;
  canRetry?: boolean;
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
  // Pesan error submit terakhir — panel "coba kirim lagi" yang jelas,
  // supaya siswa tahu pengiriman gagal dan BISA mengulang submit.
  const [submitError, setSubmitError] = useState<string | null>(null);
  // Ulangi percobaan (guru mengizinkan > 1 percobaan)
  const [retryOpen, setRetryOpen] = useState(false);
  const [retrying, setRetrying] = useState(false);
  // Game Kuis Kilat (latihan soal PG race-time)
  const [quizOpen, setQuizOpen] = useState(false);
  // Layar penuh saat mengerjakan (anti-nyontek tambahan)
  const [isFullscreen, setIsFullscreen] = useState(false);

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
  function applyAttemptResponse(json: {
    questions: FormQuestionDTO[];
    settings: FormSettings;
  }) {
    setQuestions(json.questions);
    setSettings(json.settings);
    setAnswers({});
    setCurrentIdx(0);
    setSubmitError(null);
    setResult(null);
    setPhase("playing");
  }

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
      applyAttemptResponse(json);
      toast.success("Pengerjaan dimulai — semangat!");
      invalidate();
    } finally {
      setStarting(false);
      setRulesOpen(false);
    }
  }

  // ── Ulangi percobaan (guru set maxAttempts > 1) ──────────────────────
  async function retryAttempt() {
    if (retrying) return;
    setRetrying(true);
    try {
      const res = await fetch(
        `/api/cloud/assignments/${folderId}/form/attempt/retry`,
        { method: "POST" }
      );
      const json = await res.json();
      if (!res.ok) {
        toast.error(json?.error || "Gagal mengulang pengerjaan");
        if (
          json?.error === "RETRY_LIMIT_REACHED" ||
          json?.error === "DEADLINE_PASSED" ||
          json?.error === "ATTEMPT_NOT_FOUND"
        ) {
          invalidate();
        }
        return;
      }
      applyAttemptResponse(json);
      toast.success("Percobaan baru dimulai — semangat!");
      invalidate();
    } catch {
      toast.error("Koneksi terputus — coba lagi");
    } finally {
      setRetrying(false);
      setRetryOpen(false);
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
    const limitSec = timeLimitMin * 60; // sudah di-guard non-null di atas
    // Throttle auto-submit: maks 1 percobaan tiap 10 detik. Kalau koneksi
    // mati saat waktu habis, auto-submit TERUS mencoba (tidak diam-diam
    // gagal) — dan siswa juga bisa kirim manual lewat tombol.
    let lastAutoTry = 0;
    function tick() {
      const elapsed = (Date.now() - base) / 1000;
      const left = Math.max(0, Math.round(limitSec - elapsed));
      setRemainingSec(left);
      if (left <= 0 && Date.now() - lastAutoTry > 10_000) {
        lastAutoTry = Date.now();
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

  // ── Anti-cheat: block copy/cut + context menu (React handlers) ────
  // Catatan: PASTE tidak ditangani di sini — ditangkap native capture
  // di efek bawah supaya tidak tercatat dobel.
  const antiPasteHandlers = useMemo(() => {
    if (phase !== "playing" || !settings?.preventPaste)
      return {};
    return {
      onCopy: (e: React.ClipboardEvent) => e.preventDefault(),
      onCut: (e: React.ClipboardEvent) => e.preventDefault(),
      onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
    };
  }, [phase, settings?.preventPaste]);

  // ── Anti-cheat: paste detection SUPER SENSITIF (cross-device) ──────
  // Masalah lama: paste dari HP (keyboard Gboard/SwiftKey) sering TIDAK
  // memicu event "paste" — jadi lolos tanpa tercatat. Solusi berlapis:
  //   1. keydown capture — Ctrl/Cmd+V/X/C diblokir SEBELUM event paste
  //      dibentuk (menangkap semua browser desktop).
  //   2. paste capture di document — menangkap paste dari menu klik-kanan
  //      dan menu konteks mobile (React handler lama sering tak terpasang
  //      di input yang difokus keyboard virtual).
  //   3. beforeinput capture (inputType insertFromPaste / deleteByCut) —
  //      jalur yang dipakai keyboard mobile pihak ketiga; preventDefault
  //      di sini mencegah teks masuk SEKALIGUS mencatat pelanggaran.
  useEffect(() => {
    if (phase !== "playing" || !settings?.preventPaste) return;

    function flag(detail: string, msg: string) {
      logViolation("PASTE", detail);
      setWarning(msg);
    }
    const onKeyDown = (e: KeyboardEvent) => {
      const k = (e.key || "").toLowerCase();
      if ((e.ctrlKey || e.metaKey) && ["v", "x", "c"].includes(k)) {
        e.preventDefault();
        flag(`ctrl+${k}`, "Copy/paste/cut diblokir! Percobaan tercatat.");
      }
    };
    const onPasteNative = (e: Event) => {
      e.preventDefault();
      flag("paste-event", "Paste diblokir! Percobaan paste tercatat.");
    };
    const onBeforeInput = (e: Event) => {
      const ie = e as InputEvent;
      if (
        ie.inputType === "insertFromPaste" ||
        ie.inputType === "insertTransposePaste" ||
        ie.inputType === "deleteByCut"
      ) {
        e.preventDefault();
        flag(ie.inputType, "Paste diblokir! Percobaan paste tercatat.");
      }
    };

    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("paste", onPasteNative, true);
    document.addEventListener("beforeinput", onBeforeInput, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("paste", onPasteNative, true);
      document.removeEventListener("beforeinput", onBeforeInput, true);
    };
  }, [phase, settings?.preventPaste, logViolation]);

  // ── Anti-cheat: window blur (pindah aplikasi di HP) ─────────────────
  // visibilitychange tidak selalu terpicu saat berpindah APLIKASI di
  // beberapa browser mobile — window blur menutup celah itu.
  useEffect(() => {
    if (phase !== "playing" || !settings?.trackTabSwitch) return;
    const onBlur = () => {
      logViolation("EXIT", "window-blur");
      setWarning(
        "Kamu meninggalkan halaman! Perpindahan aplikasi tercatat sebagai pelanggaran."
      );
    };
    window.addEventListener("blur", onBlur);
    return () => window.removeEventListener("blur", onBlur);
  }, [phase, settings?.trackTabSwitch, logViolation]);

  // ── Layar penuh saat mengerjakan (anti-nyontek tambahan) ───────────
  function toggleFullscreen() {
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else {
      void document.documentElement.requestFullscreen();
    }
  }
  useEffect(() => {
    const onFs = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFs);
    return () =>
      document.removeEventListener("fullscreenchange", onFs);
  }, []);

  // ── Submit ────────────────────────────────────────────────────────
  async function submit(auto = false) {
    if (submitting) return;
    setSubmitting(true);
    setSubmitError(null);
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
        if (res.status === 409 && json?.error === "ATTEMPT_ALREADY_SUBMITTED") {
          // Submit sebenarnya sudah masuk (mis. percobaan sebelumnya sukses
          // di server tapi responsnya tidak sampai ke client). Muat ulang.
          invalidate();
          setPhase("done");
          toast.success("Jawabanmu sudah terkirim sebelumnya.");
          return;
        }
        const msg =
          json?.error ||
          "Gagal mengirim jawaban — coba lagi. Jawabanmu tetap tersimpan.";
        setSubmitError(msg);
        toast.error(msg);
        return;
      }
      if (auto) logViolation("TIMEOUT");
      setResult(json as FormSubmitResult);
      setPhase("done");
      toast.success(
        auto ? "Waktu habis — jawaban otomatis dikirim." : "Jawaban terkirim!"
      );
      invalidate();
    } catch {
      // Network error — autosave server-side tetap jalan; tawarkan retry.
      setSubmitError(
        "Koneksi terputus saat mengirim. Jawabanmu tersimpan — klik “Coba kirim lagi”."
      );
      toast.error("Koneksi terputus — jawaban tersimpan, coba kirim lagi.");
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
    try {
      const res = await uploadSmart<
        { file?: { id: string; name: string }; error?: string } & Record<
          string,
          unknown
        >
      >(file, { kind: "answer-file", folderId, questionId });
      const json = res.json;
      const uploaded = json.file;
      if (!res.ok || !uploaded) {
        toast.error(json?.error || "Gagal mengunggah jawaban");
        return;
      }
      setAnswers((prev) => ({
        ...prev,
        [questionId]: {
          text: "",
          optionIds: [],
          fileId: uploaded.id,
          fileName: uploaded.name,
        },
      }));
      dirtyRef.current = true;
      toast.success("File terunggah (cloud)");
    } catch {
      toast.error("Gagal mengunggah jawaban");
    }
  }

  // ── Render helpers ────────────────────────────────────────────────
  const qs = questions;
  const current = qs[currentIdx];
  const oneByOne = settings?.oneByOne ?? true;
  const allowBack = settings?.allowBack ?? false;
  const maxAttempts = form?.maxAttempts ?? settings?.maxAttempts ?? 1;
  const answeredCount = qs.filter((q) => {
    const a = answers[q.id];
    if (!a) return false;
    if (q.type === "PG" || q.type === "MULTI_PG") return a.optionIds.length > 0;
    if (q.type === "FILE" || q.type === "IMAGE") return !!a.fileId;
    return a.text.trim().length > 0;
  }).length;

  // Soal WAJIB yang belum dijawab — untuk peringatan sebelum submit.
  const unansweredRequired = qs
    .map((q, i) => ({ q, i }))
    .filter(({ q }) => {
      if (!q.required) return false;
      const a = answers[q.id];
      if (!a) return true;
      if (q.type === "PG" || q.type === "MULTI_PG") return a.optionIds.length === 0;
      if (q.type === "FILE" || q.type === "IMAGE") return !a.fileId;
      return a.text.trim().length === 0;
    });

  // Lompat ke soal tertentu (mode satu-per-layar atau semua-soal).
  function jumpToQuestion(idx: number, questionId: string) {
    if (oneByOne) {
      setCurrentIdx(idx);
    } else {
      document
        .getElementById(`student-q-${questionId}`)
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }

  // Soal PG (dengan kunci) untuk game Kuis Kilat — hanya tersedia setelah
  // submit (jawaban benar dibuka oleh server).
  const quizQuestions = qs.filter(
    (q) => q.type === "PG" && q.correct && q.correct.length === 1
  );

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
            value={
              maxAttempts > 1
                ? `${attemptsUsed}/${maxAttempts}×`
                : "1×"
            }
          />
        </div>

        <div className="rounded-lg border border-border/60 bg-muted/40 p-3 space-y-1.5">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Aturan pengerjaan
          </p>
          <Rule
            text={
              maxAttempts > 1
                ? `Kamu punya ${maxAttempts} kesempatan pengerjaan — nilai yang dipakai adalah percobaan TERAKHIR.`
                : "Hanya ada satu kesempatan pengerjaan — tidak bisa diulang."
            }
          />
          {form?.shuffleQuestions ? (
            <Rule text="Urutan soal diacak khusus untukmu." />
          ) : null}
          {form?.shuffleOptions ? <Rule text="Urutan opsi jawaban diacak." /> : null}
          {form?.oneByOne ? (
            <Rule
              text={
                form?.allowBack
                  ? "Soal tampil satu per satu — kamu boleh kembali ke soal sebelumnya."
                  : "Soal tampil satu per satu dan tidak bisa kembali ke soal sebelumnya."
              }
            />
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
              {maxAttempts > 1 ? (
                <li>
                  Kamu punya <b>{maxAttempts} percobaan</b> — percobaan baru
                  tersedia setelah yang sekarang dikumpulkan.
                </li>
              ) : null}
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

        {/* Ulangi percobaan (guru mengizinkan maxAttempts > 1) */}
        {canRetry ? (
          <div className="rounded-lg border border-primary/30 bg-primary/5 p-4 space-y-2.5">
            <p className="text-sm">
              Percobaan <b>{attemptsUsed}</b> dari <b>{maxAttempts}</b>{" "}
              terpakai. Kamu masih bisa mengulang — nilai yang dipakai adalah
              percobaan <b>terakhir</b>.
            </p>
            <Button
              onClick={() => setRetryOpen(true)}
              disabled={retrying}
              className="gap-1.5"
            >
              {retrying ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <RotateCcw className="size-4" />
              )}
              {retrying ? "Menyiapkan…" : "Ulangi pengerjaan"}
            </Button>
          </div>
        ) : null}

        {/* Game Kuis Kilat — latihan soal PG race-time */}
        {quizQuestions.length >= 3 ? (
          <div className="rounded-lg border border-violet-500/30 bg-violet-500/5 p-4 space-y-2.5">
            <p className="text-sm flex items-start gap-2">
              <Gamepad2 className="size-4 text-violet-500 shrink-0 mt-0.5" />
              <span>
                Ulangi materi ini sambil bermain <b>Kuis Kilat</b> — jawab{" "}
                {quizQuestions.length} soal pilihan ganda, 15 detik per soal,
                kumpulkan poin &amp; combo sebanyak mungkin. Tidak memengaruhi
                nilaimu.
              </span>
            </p>
            <Button
              variant="outline"
              onClick={() => setQuizOpen(true)}
              className="gap-1.5 border-violet-500/40 text-violet-600 dark:text-violet-400 hover:bg-violet-500/10"
            >
              <Zap className="size-4" /> Main Kuis Kilat
            </Button>
          </div>
        ) : null}

        {/* Dialog konfirmasi ulangi percobaan */}
        <Dialog open={retryOpen} onOpenChange={setRetryOpen}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <RotateCcw className="size-5 text-primary" />
                Ulangi pengerjaan?
              </DialogTitle>
              <DialogDescription>
                Percobaan ini diarsipkan dan mulai dari awal lagi. Kamu punya{" "}
                <b>{maxAttempts - attemptsUsed}</b> percobaan tersisa.
              </DialogDescription>
            </DialogHeader>
            <ul className="text-sm space-y-2 list-disc pl-4">
              <li>Jawaban percobaan lama tetap tersimpan di arsip guru.</li>
              <li>
                Nilai yang dipakai adalah percobaan{" "}
                <b>terakhir yang dikumpulkan</b>.
              </li>
              <li>Soal dan opsi diacak ulang.</li>
            </ul>
            <DialogFooter>
              <Button variant="outline" onClick={() => setRetryOpen(false)}>
                Batal
              </Button>
              <Button
                onClick={() => void retryAttempt()}
                disabled={retrying}
                className="gap-1.5"
              >
                {retrying ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Play className="size-4" />
                )}
                Ya, ulangi sekarang
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Game Kuis Kilat */}
        {quizOpen ? (
          <QuickQuiz
            questions={quizQuestions}
            onClose={() => setQuizOpen(false)}
          />
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
          <div className="flex items-center gap-2">
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
            <Button
              size="sm"
              variant="ghost"
              onClick={toggleFullscreen}
              title={
                isFullscreen
                  ? "Keluar dari layar penuh"
                  : "Kerjakan dalam layar penuh (anti-nyontek)"
              }
              aria-label="Layar penuh"
            >
              {isFullscreen ? (
                <Minimize2 className="size-4" />
              ) : (
                <Maximize2 className="size-4" />
              )}
            </Button>
          </div>
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

      {/* Panel error submit — siswa TETAP BISA mengirim ulang (jawaban
          tersimpan di server via autosave). */}
      {phase === "playing" && submitError ? (
        <Card className="p-3.5 border-destructive/40 bg-destructive/5 space-y-2">
          <div className="flex items-start gap-2.5">
            <AlertTriangle className="size-4.5 text-destructive shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0 space-y-1">
              <p className="text-sm font-medium text-destructive">
                Pengiriman jawaban belum berhasil
              </p>
              <p className="text-xs text-muted-foreground">
                {submitError} Jawabanmu aman — tersimpan otomatis di server.
                Periksa koneksi lalu kirim ulang.
              </p>
            </div>
            <Button
              size="sm"
              onClick={() => void submit(false)}
              disabled={submitting}
              className="bg-destructive hover:bg-destructive/90 shrink-0"
            >
              {submitting ? (
                <Loader2 className="size-3.5 animate-spin mr-1" />
              ) : (
                <RotateCcw className="size-3.5 mr-1" />
              )}
              Coba kirim lagi
            </Button>
          </div>
        </Card>
      ) : null}

      {/* Bottom bar */}
      <div className="flex items-center justify-between gap-2 flex-wrap sticky bottom-0 bg-background/90 backdrop-blur border-t border-border pt-3 pb-1">
        {oneByOne ? (
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground tabular-nums">
              Soal {currentIdx + 1} / {qs.length}
            </span>
            {allowBack ? (
              <Button
                size="sm"
                variant="outline"
                disabled={currentIdx === 0}
                onClick={() => setCurrentIdx((i) => Math.max(0, i - 1))}
              >
                <ChevronLeft className="size-4" /> Sebelumnya
              </Button>
            ) : null}
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

      {/* Confirm dialog — dengan peringatan soal WAJIB belum dijawab */}
      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Kumpulkan jawaban?</DialogTitle>
            <DialogDescription>
              Jawaban akan dikirim dan <b>tidak bisa diubah lagi</b>
              {maxAttempts > 1 ? " untuk percobaan ini." : "."}
            </DialogDescription>
          </DialogHeader>
          <div className="text-sm space-y-2">
            <p>
              Terjawab:{" "}
              <b className={answeredCount === qs.length ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400"}>
                {answeredCount}/{qs.length}
              </b>{" "}
              soal
            </p>
            {unansweredRequired.length > 0 ? (
              <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 space-y-2">
                <p className="text-sm font-medium text-destructive flex items-center gap-1.5">
                  <AlertTriangle className="size-4 shrink-0" />
                  {unansweredRequired.length} soal WAJIB belum dijawab!
                </p>
                <p className="text-xs text-muted-foreground">
                  Soal nomor{" "}
                  <b className="text-foreground">
                    {unansweredRequired
                      .slice(0, 12)
                      .map((u) => `#${u.i + 1}`)
                      .join(", ")}
                    {unansweredRequired.length > 12
                      ? ` +${unansweredRequired.length - 12} lainnya`
                      : ""}
                  </b>{" "}
                  wajib diisi — nilai kosong = 0 poin.
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {unansweredRequired.slice(0, 12).map(({ q, i }) => (
                    <Button
                      key={q.id}
                      size="sm"
                      variant="outline"
                      className="h-7 px-2 text-xs"
                      onClick={() => {
                        setConfirmOpen(false);
                        jumpToQuestion(i, q.id);
                      }}
                    >
                      <ListChecks className="size-3 mr-1" /> Soal {i + 1}
                    </Button>
                  ))}
                </div>
              </div>
            ) : answeredCount < qs.length ? (
              <p className="text-xs text-muted-foreground">
                {qs.length - answeredCount} soal opsional belum dijawab —
                akan tetap kosong (0 poin).
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)}>
              {unansweredRequired.length > 0 ? "Periksa dulu" : "Periksa lagi"}
            </Button>
            <Button
              onClick={() => void submit(false)}
              disabled={submitting}
              className={cn(
                "gap-1.5",
                unansweredRequired.length > 0 &&
                  "bg-destructive hover:bg-destructive/90"
              )}
            >
              {submitting ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Send className="size-4" />
              )}
              {unansweredRequired.length > 0
                ? `Tetap kirim (${unansweredRequired.length} kosong)`
                : "Ya, kumpulkan"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── Sub-components ─────────────────────────────────────────────────

// Kuis Kilat — game latihan PG race-time (tidak memengaruhi nilai).
// 15 detik per soal, poin = 10 benar + bonus combo, soal diacak.
function QuickQuiz({
  questions,
  onClose,
}: {
  questions: FormQuestionDTO[];
  onClose: () => void;
}) {
  const TIME_PER_Q = 15;
  const [deck] = useState(() =>
    [...questions].sort(() => Math.random() - 0.5)
  );
  const [idx, setIdx] = useState(0);
  const [timeLeft, setTimeLeft] = useState(TIME_PER_Q);
  const [chosen, setChosen] = useState<string | null>(null);
  const [score, setScore] = useState(0);
  const [streak, setStreak] = useState(0);
  const [bestStreak, setBestStreak] = useState(0);
  const [correctCount, setCorrectCount] = useState(0);
  const [finished, setFinished] = useState(false);

  const q = deck[idx];

  function next() {
    if (idx + 1 >= deck.length) {
      setFinished(true);
      return;
    }
    setIdx((i) => i + 1);
    setChosen(null);
  }

  // Guard: soal ini sudah dijawab / di-timeout? (ref — tanpa re-render)
  const settledRef = useRef(false);

  // Timer per soal — semua setState terjadi dalam callback interval
  // (bukan sinkron di body efek). Habis waktu = salah, lanjut otomatis.
  useEffect(() => {
    if (finished) return;
    settledRef.current = false;
    const startedAt = Date.now();
    const t = setInterval(() => {
      const left = Math.max(
        0,
        TIME_PER_Q - Math.floor((Date.now() - startedAt) / 1000)
      );
      setTimeLeft(left);
      if (left <= 0) {
        clearInterval(t);
        if (!settledRef.current) {
          settledRef.current = true;
          setChosen("__timeout__");
          setStreak(0);
          setTimeout(() => next(), 1200);
        }
      }
    }, 250);
    return () => clearInterval(t);
  }, [idx, finished]);

  function pick(optionId: string) {
    if (settledRef.current) return;
    settledRef.current = true;
    setChosen(optionId);
    const correct = q?.correct?.includes(optionId) ?? false;
    if (correct) {
      const newStreak = streak + 1;
      setCorrectCount((c) => c + 1);
      setScore((s) => s + 10 + streak * 2);
      setStreak(newStreak);
      setBestStreak((b) => Math.max(b, newStreak));
    } else {
      setStreak(0);
    }
    setTimeout(() => next(), 1200);
  }

  function restart() {
    setIdx(0);
    setChosen(null);
    setScore(0);
    setStreak(0);
    setBestStreak(0);
    setCorrectCount(0);
    setFinished(false);
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        {finished ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Trophy className="size-5 text-amber-500" /> Kuis Kilat
                selesai!
              </DialogTitle>
            </DialogHeader>
            <div className="text-center space-y-3 py-2">
              <p className="text-5xl font-bold text-primary tabular-nums">
                {score}
              </p>
              <p className="text-sm text-muted-foreground">poin</p>
              <div className="grid grid-cols-3 gap-2 text-center">
                <div className="rounded-lg border border-border p-2.5">
                  <p className="text-lg font-bold">
                    {correctCount}/{deck.length}
                  </p>
                  <p className="text-[10px] text-muted-foreground uppercase">
                    Benar
                  </p>
                </div>
                <div className="rounded-lg border border-border p-2.5">
                  <p className="text-lg font-bold">
                    {deck.length > 0
                      ? Math.round((correctCount / deck.length) * 100)
                      : 0}
                    %
                  </p>
                  <p className="text-[10px] text-muted-foreground uppercase">
                    Akurasi
                  </p>
                </div>
                <div className="rounded-lg border border-border p-2.5">
                  <p className="text-lg font-bold">×{bestStreak}</p>
                  <p className="text-[10px] text-muted-foreground uppercase">
                    Combo terbaik
                  </p>
                </div>
              </div>
            </div>
            <DialogFooter className="gap-2">
              <Button variant="outline" onClick={restart}>
                <RotateCcw className="size-4 mr-1" /> Main lagi
              </Button>
              <Button onClick={onClose}>Selesai</Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <div className="flex items-center justify-between gap-2 w-full">
                <DialogTitle className="text-base flex items-center gap-2">
                  <Zap className="size-4 text-violet-500" /> Kuis Kilat
                </DialogTitle>
                <span className="text-xs text-muted-foreground tabular-nums">
                  {idx + 1}/{deck.length} · Skor {score}
                </span>
              </div>
            </DialogHeader>
            <div className="space-y-3">
              {/* Timer bar */}
              <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                <div
                  className={cn(
                    "h-full rounded-full transition-all duration-1000 ease-linear",
                    timeLeft <= 5 ? "bg-destructive" : "bg-violet-500"
                  )}
                  style={{ width: `${(timeLeft / TIME_PER_Q) * 100}%` }}
                />
              </div>
              <div className="flex items-center justify-between text-xs">
                <span
                  className={cn(
                    "font-mono font-bold tabular-nums",
                    timeLeft <= 5 && "text-destructive animate-pulse"
                  )}
                >
                  ⏱ {timeLeft}s
                </span>
                {streak >= 2 ? (
                  <span className="font-semibold text-orange-500">
                    🔥 Combo ×{streak}
                  </span>
                ) : null}
              </div>
              <p className="text-sm font-medium whitespace-pre-wrap leading-relaxed">
                {q?.text}
              </p>
              <div className="space-y-1.5">
                {q?.options.map((o) => {
                  const chosenThis = chosen === o.id;
                  const correctThis =
                    chosen != null && (q.correct?.includes(o.id) ?? false);
                  return (
                    <button
                      key={o.id}
                      type="button"
                      onClick={() => pick(o.id)}
                      disabled={chosen != null}
                      className={cn(
                        "flex items-center gap-2.5 w-full rounded-lg border px-3 py-2.5 text-left text-sm transition-all",
                        chosen == null
                          ? "border-border hover:border-violet-500/50 hover:bg-violet-500/5"
                          : correctThis
                            ? "border-emerald-500 bg-emerald-500/10"
                            : chosenThis
                              ? "border-destructive bg-destructive/10"
                              : "border-border opacity-50"
                      )}
                    >
                      <span className="text-sm">{o.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>
            <DialogFooter>
              <Button variant="ghost" size="sm" onClick={onClose}>
                Keluar
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

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
