"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { id as localeId } from "date-fns/locale";
import { toast } from "sonner";
import {
  AlertTriangle,
  BarChart3,
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  ClipboardCheck,
  Clock,
  Download,
  Eye,
  History,
  Loader2,
  MessageSquareText,
  Paperclip,
  Printer,
  Radio,
  RotateCcw,
  ShieldAlert,
  Table2,
  Users,
  XCircle,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
  feedback?: string | null;
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

// Snapshot jawaban satu percobaan terarsip (bentuk disimpan di
// FormAttemptArchive.answers sebagai JSON string oleh retry route).
interface ReviewArchiveAnswer {
  questionId: string;
  text: string | null;
  optionIds: string[];
  fileId: string | null;
  fileName: string | null;
  score: number | null;
}

// Satu percobaan lama (hasil retry siswa) — dipetakan ke siswa via userId.
interface ReviewArchive {
  id: string;
  attemptId: string;
  userId: string;
  score: number | null;
  maxScore: number;
  violations: { type: string; at: string; detail?: string }[];
  startedAt: string;
  submittedAt: string;
  archivedAt: string;
  answers: ReviewArchiveAnswer[];
  /** false = arsip lama sebelum fitur snapshot jawaban (detail tidak tersimpan). */
  hasAnswerDetail: boolean;
}

interface ReviewResponse {
  form: { id: string; timeLimitMin: number | null; showResult: boolean };
  questions: ReviewQuestion[];
  attempts: ReviewAttempt[];
  /** Riwayat percobaan lama (arsip) — bisa kosong bila belum ada yang mengulang. */
  archives?: ReviewArchive[];
  roster: {
    user: { id: string; name: string; username: string };
    role: string;
    hasAttempt: boolean;
    status: string | null;
  }[];
}

export function FormReview({ folderId }: { folderId: string }) {
  const qc = useQueryClient();
  // Live monitoring: auto-refresh 5 dtk (bisa dimatikan).
  const [live, setLive] = useState(true);
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
    refetchInterval: live ? 5_000 : false,
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
  const scores = submitted
    .map((a) => a.score)
    .filter((s): s is number => s != null);
  const avg =
    scores.length > 0
      ? Math.round(scores.reduce((s, v) => s + v, 0) / scores.length)
      : null;
  const highest = scores.length > 0 ? Math.max(...scores) : null;
  const lowest = scores.length > 0 ? Math.min(...scores) : null;

  // Distribusi nilai (5 bin) — batang CSS sederhana.
  const bins = [
    { label: "0–59", lo: 0, hi: 59 },
    { label: "60–69", lo: 60, hi: 69 },
    { label: "70–79", lo: 70, hi: 79 },
    { label: "80–89", lo: 80, hi: 89 },
    { label: "90–100", lo: 90, hi: 100000 },
  ].map((b) => ({
    label: b.label,
    count: scores.filter((s) => s >= b.lo && s <= b.hi).length,
  }));
  const maxBin = Math.max(1, ...bins.map((b) => b.count));

  // Peta arsip per siswa (userId → daftar percobaan lama).
  const archivesByUser = new Map<string, ReviewArchive[]>();
  for (const ar of data.archives ?? []) {
    const list = archivesByUser.get(ar.userId);
    if (list) list.push(ar);
    else archivesByUser.set(ar.userId, [ar]);
  }

  // Export CSV — nama, status, nilai, pelanggaran, waktu.
  function exportCsv() {
    const rowsData = data;
    if (!rowsData) return;
    const esc = (v: string | number | null | undefined) =>
      `"${String(v ?? "").replace(/"/g, '""')}"`;
    const rows = [
      [
        "Nama",
        "Username",
        "Status",
        "Nilai",
        "Nilai Maks",
        "Pelanggaran",
        "Mulai",
        "Dikumpulkan",
      ].join(";"),
      ...rowsData.attempts.map((a) =>
        [
          esc(a.user.name),
          esc(a.user.username),
          a.status === "SUBMITTED" ? "Terkumpul" : "Sedang mengerjakan",
          a.score != null ? a.score : "-",
          a.maxScore,
          a.violations.length,
          a.startedAt ? format(new Date(a.startedAt), "yyyy-MM-dd HH:mm") : "",
          a.submittedAt
            ? format(new Date(a.submittedAt), "yyyy-MM-dd HH:mm")
            : "",
        ].join(";")
      ),
    ].join("\n");
    const blob = new Blob(["\uFEFF" + rows], {
      type: "text/csv;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const aEl = document.createElement("a");
    aEl.href = url;
    aEl.download = `nilai-tugas-${folderId.slice(-8)}.csv`;
    document.body.appendChild(aEl);
    aEl.click();
    aEl.remove();
    URL.revokeObjectURL(url);
    toast.success("Data nilai diexport ke CSV");
  }

  // Cetak rekap nilai — buka jendela cetak bersih (tanpa CSS aplikasi).
  function printRecap() {
    if (!data) return;
    const rows = data.attempts
      .map(
        (a) => `
        <tr>
          <td>${escapeHtml(a.user.name)}</td>
          <td>@${escapeHtml(a.user.username)}</td>
          <td>${a.status === "SUBMITTED" ? "Terkumpul" : "Berlangsung"}</td>
          <td style="text-align:center">${
            a.status === "SUBMITTED" && a.score != null
              ? `${a.score} / ${a.maxScore}`
              : "—"
          }</td>
          <td style="text-align:center">${a.violations.length}</td>
          <td>${
            a.submittedAt
              ? format(new Date(a.submittedAt), "d MMM yyyy HH:mm")
              : "—"
          }</td>
        </tr>`
      )
      .join("");
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>Rekap Nilai</title>
      <style>
        body { font-family: system-ui, -apple-system, sans-serif; padding: 32px; color: #111; }
        h1 { font-size: 18px; }
        p.meta { color: #555; font-size: 12px; }
        table { width: 100%; border-collapse: collapse; margin-top: 12px; font-size: 12px; }
        th, td { border: 1px solid #ccc; padding: 6px 8px; text-align: left; }
        th { background: #f3f4f6; }
      </style></head><body>
      <h1>Rekap Nilai Tugas</h1>
      <p class="meta">Dicetak ${format(new Date(), "d MMM yyyy HH:mm", {
        locale: localeId,
      })} · ${submitted.length} terkumpul · rata-rata ${avg ?? "—"}</p>
      <table>
        <thead><tr><th>Nama</th><th>Username</th><th>Status</th><th>Nilai</th><th>Pelanggaran</th><th>Dikumpulkan</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      </body></html>`;
    const w = window.open("", "_blank", "width=900,height=700");
    if (!w) {
      toast.error("Popup diblokir — izinkan popup untuk mencetak");
      return;
    }
    w.document.write(html);
    w.document.close();
    w.focus();
    setTimeout(() => w.print(), 350);
  }

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
        {highest != null ? (
          <Badge variant="outline">Tertinggi {highest}</Badge>
        ) : null}
        {lowest != null ? (
          <Badge variant="outline">Terendah {lowest}</Badge>
        ) : null}
        {flagged.length > 0 ? (
          <Badge className="bg-amber-500/15 text-amber-600 dark:text-amber-400 border border-amber-500/30">
            <ShieldAlert className="size-3" /> {flagged.length} terindikasi
            pelanggaran
          </Badge>
        ) : null}
        {/* Live monitoring toggle */}
        <button
          type="button"
          onClick={() => setLive((v) => !v)}
          title={
            live
              ? "Pantau langsung aktif — data diperbarui tiap 5 detik. Klik untuk mematikan."
              : "Pantau langsung mati — klik untuk mengaktifkan (perbarui tiap 5 detik)."
          }
          className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium transition-colors ${
            live
              ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
              : "border-border text-muted-foreground"
          }`}
        >
          {live ? (
            <Radio className="size-3 animate-pulse" />
          ) : (
            <Radio className="size-3" />
          )}
          {live ? "Live" : "Live mati"}
        </button>
        <div className="flex-1" />
        <Button size="sm" variant="outline" onClick={printRecap}>
          <Printer className="size-3.5 mr-1" /> Cetak
        </Button>
        <Button size="sm" variant="outline" onClick={exportCsv}>
          <Table2 className="size-3.5 mr-1" /> Export CSV
        </Button>
      </div>

      {/* Distribusi nilai */}
      {scores.length > 0 ? (
        <Card className="p-4 space-y-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-1.5">
            <BarChart3 className="size-3.5" /> Distribusi nilai (n={
              scores.length
            })
          </p>
          <div className="flex items-end gap-3 h-24 px-1">
            {bins.map((b) => (
              <div
                key={b.label}
                className="flex-1 flex flex-col items-center gap-1"
                title={`${b.count} siswa (${
                  scores.length > 0
                    ? Math.round((b.count / scores.length) * 100)
                    : 0
                }%)`}
              >
                <span className="text-[10px] font-semibold tabular-nums">
                  {b.count}
                </span>
                <div
                  className="w-full rounded-t bg-primary/70 transition-all"
                  style={{
                    height: `${Math.max(
                      b.count > 0 ? 8 : 2,
                      (b.count / maxBin) * 64
                    )}px`,
                  }}
                />
                <span className="text-[10px] text-muted-foreground">
                  {b.label}
                </span>
              </div>
            ))}
          </div>
        </Card>
      ) : null}

      {/* Attempts list */}
      <div className="space-y-3">
        {data.attempts.map((a) => (
          <AttemptCard
            key={a.id}
            folderId={folderId}
            attempt={a}
            questions={data.questions}
            archives={archivesByUser.get(a.user.id) ?? []}
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
  archives,
  onGraded,
}: {
  folderId: string;
  attempt: ReviewAttempt;
  questions: ReviewQuestion[];
  archives: ReviewArchive[];
  onGraded: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [previewFile, setPreviewFile] = useState<CloudFileItem | null>(null);
  const [resetOpen, setResetOpen] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const answerByQ = new Map(attempt.answers.map((a) => [a.questionId, a]));

  const submitted = attempt.status === "SUBMITTED";

  // Guru mereset pengerjaan siswa — jawaban, file, pelanggaran, dan skor
  // dihapus; siswa bisa mulai dari awal (mis. submit gagal / terlanjur salah).
  async function resetAttempt() {
    setResetting(true);
    try {
      const res = await fetch(
        `/api/cloud/assignments/${folderId}/form/attempts/reset`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userId: attempt.user.id }),
        }
      );
      const json = await res.json();
      if (!res.ok) {
        toast.error(json?.error || "Gagal mereset pengerjaan");
        return;
      }
      toast.success(
        `Pengerjaan ${attempt.user.name} direset — siswa dapat mengerjakan ulang.`
      );
      setResetOpen(false);
      onGraded();
    } catch {
      toast.error("Gagal mereset pengerjaan");
    } finally {
      setResetting(false);
    }
  }

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
      {/* Header row: expand/collapse + tombol reset terpisah */}
      <div className="flex items-center">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="flex items-center gap-3 flex-1 min-w-0 px-4 py-3 hover:bg-accent/40 transition-colors text-left"
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
          {archives.length > 0 ? (
            <Badge variant="outline" className="shrink-0 gap-1">
              <History className="size-3" />
              {archives.length + 1} percobaan
            </Badge>
          ) : null}
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
        <div className="shrink-0 pr-3 pl-1 flex items-center gap-1">
          <Button
            size="icon"
            variant="ghost"
            onClick={() => setHistoryOpen(true)}
            title="Riwayat percobaan siswa ini (semua percobaan + arsip)"
            aria-label="Riwayat percobaan siswa"
          >
            <History className="size-4 text-muted-foreground" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            onClick={() => setResetOpen(true)}
            title="Reset pengerjaan siswa ini (siswa bisa mengerjakan ulang)"
            aria-label="Reset pengerjaan siswa"
          >
            <RotateCcw className="size-4 text-muted-foreground" />
          </Button>
        </div>
      </div>

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

      {/* Dialog riwayat semua percobaan (arsip + percobaan aktif) */}
      <AttemptHistoryDialog
        open={historyOpen}
        onOpenChange={setHistoryOpen}
        user={attempt.user}
        attempt={attempt}
        archives={archives}
        questions={questions}
      />

      {/* Dialog konfirmasi reset pengerjaan */}
      <Dialog open={resetOpen} onOpenChange={setResetOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Reset pengerjaan {attempt.user.name}?</DialogTitle>
            <DialogDescription>
              Seluruh jawaban, file yang diunggah, skor, dan log pelanggaran
              pengerjaan ini akan <b>dihapus permanen</b>. Siswa tersebut dapat
              mengerjakan tugas dari awal lagi.
            </DialogDescription>
          </DialogHeader>
          <p className="text-xs text-muted-foreground">
            Status saat ini:{" "}
            <b>{submitted ? "sudah dikumpulkan" : "sedang berlangsung"}</b>
            {attempt.score != null ? ` · nilai ${attempt.score}/${attempt.maxScore}` : ""}
            {attempt.answers.length > 0 ? ` · ${attempt.answers.length} jawaban tersimpan` : ""}
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setResetOpen(false)}>
              Batal
            </Button>
            <Button
              onClick={() => void resetAttempt()}
              disabled={resetting}
              className="bg-destructive hover:bg-destructive/90"
            >
              {resetting ? (
                <Loader2 className="size-4 animate-spin mr-1" />
              ) : (
                <RotateCcw className="size-4 mr-1" />
              )}
              Reset &amp; ulangi
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

// ── Riwayat percobaan per siswa (arsip + percobaan aktif) ───────────

// Durasi pengerjaan "Xm Ys" (manual — tanpa dependensi tambahan).
function formatDuration(
  startedAt: string,
  submittedAt: string | null
): string {
  if (!submittedAt) return "—";
  const ms =
    new Date(submittedAt).getTime() - new Date(startedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}m ${String(s).padStart(2, "0")}s`;
}

// Satu baris percobaan di dialog riwayat (arsip ATAU percobaan aktif).
interface HistoryEntry {
  k: number;
  isCurrent: boolean;
  score: number | null;
  maxScore: number;
  violations: { type: string; at: string; detail?: string }[];
  startedAt: string;
  submittedAt: string | null;
  answers: ReviewArchiveAnswer[];
  hasAnswerDetail: boolean;
}

function AttemptHistoryDialog({
  open,
  onOpenChange,
  user,
  attempt,
  archives,
  questions,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  user: ReviewAttempt["user"];
  attempt: ReviewAttempt;
  archives: ReviewArchive[];
  questions: ReviewQuestion[];
}) {
  // Detail jawaban percobaan yang dipilih (dialog kedua, read-only).
  const [detail, setDetail] = useState<HistoryEntry | null>(null);

  // Arsip diurutkan dari yang paling lama → nomor percobaan menaik;
  // percobaan AKTIF selalu paling akhir dengan nomor terbesar.
  const sorted = [...archives].sort(
    (a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime()
  );

  const entries: HistoryEntry[] = [
    ...sorted.map((ar, i) => ({
      k: i + 1,
      isCurrent: false,
      score: ar.score,
      maxScore: ar.maxScore,
      violations: ar.violations,
      startedAt: ar.startedAt,
      submittedAt: ar.submittedAt,
      answers: ar.answers,
      hasAnswerDetail: ar.hasAnswerDetail,
    })),
    {
      k: sorted.length + 1,
      isCurrent: true,
      score: attempt.score,
      maxScore: attempt.maxScore,
      violations: attempt.violations,
      startedAt: attempt.startedAt,
      submittedAt: attempt.submittedAt,
      // Attempt aktif: jawaban live dipetakan ke bentuk snapshot yang sama.
      answers: attempt.answers.map((a) => ({
        questionId: a.questionId,
        text: a.text,
        optionIds: a.optionIds ?? [],
        fileId: a.fileId,
        fileName: a.file?.name ?? null,
        score: a.score,
      })),
      hasAnswerDetail: true,
    },
  ];

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(v) => {
          // Tutup juga dialog detail jawaban bila masih terbuka.
          if (!v) setDetail(null);
          onOpenChange(v);
        }}
      >
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <History className="size-4 text-muted-foreground" />
              Riwayat percobaan — {user.name}
            </DialogTitle>
            <DialogDescription>
              Semua percobaan pengerjaan siswa ini (paling lama ke terbaru).
              Nilai akhir yang dipakai = percobaan terakhir.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            {entries.map((e) => (
              <div
                key={e.isCurrent ? `current-${e.k}` : `archive-${e.k}`}
                className="rounded-lg border border-border p-3 space-y-2"
              >
                {/* Baris judul percobaan */}
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-semibold">
                    Percobaan #{e.k}
                  </span>
                  {e.isCurrent ? (
                    <Badge className="bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border border-emerald-500/30 gap-1 text-[10px]">
                      <CheckCircle2 className="size-3" />
                      Dipakai untuk nilai
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="text-[10px]">
                      Arsip
                    </Badge>
                  )}
                  <div className="flex-1" />
                  <Badge variant="outline" className="gap-1">
                    <CheckCircle2 className="size-3 text-muted-foreground" />
                    {e.score != null ? `${e.score}/${e.maxScore}` : "—"}
                  </Badge>
                </div>

                {/* Meta: durasi, pelanggaran, waktu kirim */}
                <div className="flex items-center gap-x-4 gap-y-1 flex-wrap text-xs text-muted-foreground">
                  <span className="inline-flex items-center gap-1">
                    <Clock className="size-3" />
                    Durasi {formatDuration(e.startedAt, e.submittedAt)}
                  </span>
                  <span
                    className="inline-flex items-center gap-1"
                    title={
                      e.violations.length > 0
                        ? e.violations
                            .map(
                              (v) =>
                                `${violationLabel(v as never)} (${format(
                                  new Date(v.at),
                                  "HH:mm:ss"
                                )})`
                            )
                            .join("\n")
                        : "Tidak ada pelanggaran"
                    }
                  >
                    <ShieldAlert className="size-3" />
                    {e.violations.length} pelanggaran
                  </span>
                  <span>
                    Dikumpulkan{" "}
                    {e.submittedAt
                      ? format(new Date(e.submittedAt), "d MMM yyyy HH:mm")
                      : "— belum dikumpulkan"}
                  </span>
                </div>

                {/* Detail jenis pelanggaran (bila ada) */}
                {e.violations.length > 0 ? (
                  <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 space-y-0.5">
                    {e.violations.slice(0, 10).map((v, i) => (
                      <p key={i} className="text-[11px] text-muted-foreground">
                        • {violationLabel(v as never)} —{" "}
                        {format(new Date(v.at), "HH:mm:ss")}
                        {v.detail ? ` (${v.detail})` : ""}
                      </p>
                    ))}
                    {e.violations.length > 10 ? (
                      <p className="text-[11px] text-muted-foreground">
                        …dan {e.violations.length - 10} lainnya
                      </p>
                    ) : null}
                  </div>
                ) : null}

                {/* Detail jawaban per percobaan */}
                {e.hasAnswerDetail ? (
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <span className="text-[11px] text-muted-foreground">
                      {e.answers.length} jawaban tersimpan
                    </span>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 gap-1.5 text-xs"
                      onClick={() => setDetail(e)}
                    >
                      <Eye className="size-3.5" />
                      Lihat jawaban
                    </Button>
                  </div>
                ) : (
                  <p className="text-[11px] text-muted-foreground italic">
                    Detail jawaban tidak tersimpan (arsip lama) — skor, durasi,
                    dan pelanggaran tetap tercatat.
                  </p>
                )}
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>

      {/* Dialog kedua: detail jawaban satu percobaan (read-only) */}
      <AttemptAnswersDialog
        open={detail != null}
        onOpenChange={(v) => {
          if (!v) setDetail(null);
        }}
        user={user}
        entry={detail}
        questions={questions}
      />
    </>
  );
}

// Detail jawaban satu percobaan — read-only (arsip maupun percobaan aktif).
function AttemptAnswersDialog({
  open,
  onOpenChange,
  user,
  entry,
  questions,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  user: ReviewAttempt["user"];
  entry: HistoryEntry | null;
  questions: ReviewQuestion[];
}) {
  if (!entry) return null;

  const qById = new Map(questions.map((q) => [q.id, q]));
  const ansByQ = new Map(entry.answers.map((a) => [a.questionId, a]));
  // Jawaban untuk soal yang sudah dihapus dari form (tetap ditampilkan).
  const orphans = entry.answers.filter((a) => !qById.has(a.questionId));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            Jawaban percobaan #{entry.k} — {user.name}
          </DialogTitle>
          <DialogDescription>
            {entry.isCurrent
              ? "Percobaan terakhir (dipakai untuk nilai)."
              : "Percobaan lama (terarsip)."}{" "}
            Skor {entry.score != null ? `${entry.score}/${entry.maxScore}` : "—"}{" "}
            · durasi {formatDuration(entry.startedAt, entry.submittedAt)}.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          {questions.map((q, i) => {
            const a = ansByQ.get(q.id);
            const opts = a?.optionIds ?? [];
            const optLabels = opts
              .map(
                (id) =>
                  q.options.find((o) => o.id === id)?.label ?? `(opsi ${id})`
              )
              .join(", ");
            const answered =
              opts.length > 0 || !!a?.text || !!a?.fileName || !!a?.fileId;
            return (
              <div
                key={q.id}
                className="rounded-lg border border-border p-3 space-y-1.5"
              >
                <div className="flex items-start justify-between gap-2">
                  <p className="text-sm font-medium flex items-start gap-2 min-w-0 flex-1">
                    <span className="text-muted-foreground font-mono text-xs shrink-0 mt-0.5">
                      #{i + 1}
                    </span>
                    <span className="line-clamp-2">{q.text}</span>
                  </p>
                  {a?.score != null ? (
                    <Badge variant="secondary" className="shrink-0">
                      skor {a.score}
                    </Badge>
                  ) : null}
                </div>
                {/* Isi jawaban siswa */}
                {optLabels ? (
                  <p className="text-sm rounded-md bg-muted/50 border border-border px-3 py-1.5">
                    {optLabels}
                  </p>
                ) : a?.text ? (
                  <p className="text-sm whitespace-pre-wrap rounded-md bg-muted/50 border border-border px-3 py-2 max-h-32 overflow-y-auto">
                    {a.text}
                  </p>
                ) : a?.fileName ? (
                  <p className="text-sm inline-flex items-center gap-1.5 rounded-md bg-muted/50 border border-border px-3 py-1.5">
                    <Paperclip className="size-3.5 text-muted-foreground shrink-0" />
                    <span className="truncate">{a.fileName}</span>
                  </p>
                ) : answered ? (
                  <p className="text-xs text-muted-foreground italic">
                    Terjawab (detail tidak tersimpan).
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground italic">
                    —kosong—
                  </p>
                )}
              </div>
            );
          })}
          {/* Jawaban untuk soal yang sudah dihapus dari form */}
          {orphans.map((a, i) => (
            <div key={a.questionId} className="rounded-lg border border-border border-dashed p-3 space-y-1.5">
              <div className="flex items-start justify-between gap-2">
                <p className="text-sm font-medium flex items-start gap-2 min-w-0 flex-1">
                  <span className="text-muted-foreground font-mono text-xs shrink-0 mt-0.5">
                    —
                  </span>
                  <span className="text-muted-foreground italic">
                    Soal (sudah dihapus dari form) #{i + 1}
                  </span>
                </p>
                {a.score != null ? (
                  <Badge variant="secondary" className="shrink-0">
                    skor {a.score}
                  </Badge>
                ) : null}
              </div>
              <p className="text-sm rounded-md bg-muted/50 border border-border px-3 py-1.5 truncate">
                {a.text ??
                  a.fileName ??
                  (a.optionIds.length > 0
                    ? a.optionIds.join(", ")
                    : "—kosong—")}
              </p>
            </div>
          ))}
          {questions.length === 0 && orphans.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-4">
              Tidak ada jawaban tersimpan pada percobaan ini.
            </p>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
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
  // Umpan balik (feedback) guru per jawaban.
  const [feedbackInput, setFeedbackInput] = useState<string>(
    answer?.feedback ?? ""
  );
  const [savingFeedback, setSavingFeedback] = useState(false);

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

  async function saveFeedback() {
    if (!answer) return;
    setSavingFeedback(true);
    try {
      const res = await fetch(
        `/api/cloud/assignments/${folderId}/form/feedback`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            answerId: answer.id,
            feedback: feedbackInput,
          }),
        }
      );
      if (!res.ok) {
        const json = await res.json().catch(() => null);
        toast.error(json?.error || "Gagal menyimpan umpan balik");
        return;
      }
      toast.success("Umpan balik tersimpan — siswa melihatnya di hasilnya");
      onGraded();
    } finally {
      setSavingFeedback(false);
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

      {/* Umpan balik guru per jawaban (feedback) */}
      {answer && submitted ? (
        <div className="space-y-1.5 pt-1 border-t border-border/60">
          <div className="flex items-center gap-1.5">
            <MessageSquareText className="size-3.5 text-primary" />
            <Label className="text-[11px] font-medium">
              Umpan balik untuk siswa
            </Label>
            {answer.feedback ? (
              <Badge variant="secondary" className="text-[9px]">
                tersimpan
              </Badge>
            ) : null}
          </div>
          <div className="flex items-start gap-2">
            <Textarea
              value={feedbackInput}
              onChange={(e) => setFeedbackInput(e.target.value)}
              placeholder="cth: Jawabanmu hampir tepat, tapi perhatikan rumus di langkah kedua…"
              rows={2}
              maxLength={1000}
              className="text-xs"
            />
            <Button
              size="sm"
              variant="outline"
              className="h-8 shrink-0"
              onClick={() => void saveFeedback()}
              disabled={savingFeedback}
              title="Simpan umpan balik"
            >
              {savingFeedback ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <ClipboardCheck className="size-3.5" />
              )}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
