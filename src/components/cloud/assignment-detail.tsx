"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  format,
  formatDistanceToNow,
  isPast,
  isToday,
  isTomorrow,
} from "date-fns";
import { id as localeId } from "date-fns/locale";
import { toast } from "sonner";
import {
  ArrowLeft,
  CalendarClock,
  CheckCircle2,
  ClipboardList,
  Clock,
  Download,
  Eye,
  Loader2,
  Upload,
  Users,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { AutoTextarea } from "@/components/ui/auto-textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";

import { FileUpload } from "@/components/cloud/file-upload";
import { FileIcon } from "@/components/cloud/file-icon";
import { FilePreview } from "@/components/cloud/file-preview";
import { useTransferStore } from "@/lib/transfer-store";
import { FormBuilder } from "@/components/cloud/form/form-builder";
import { FormPlayer } from "@/components/cloud/form/form-player";
import { FormReview } from "@/components/cloud/form/form-review";
import type { FormGetResponse } from "@/lib/form-types";
import {
  formatBytes,
  mimeToIcon,
  type AssignmentDetailResponse,
  type CloudFileItem,
  type SubmissionFile,
} from "@/lib/cloud-format";
import { uploadSmart } from "@/lib/upload-client";
import { useUIStore } from "@/stores/ui-store";
import type { MeResponse } from "@/hooks/use-me";

function fmtDate(iso: string) {
  try {
    return format(new Date(iso), "d MMM yyyy, HH:mm", { locale: localeId });
  } catch {
    return iso;
  }
}

function FormIconBadge() {
  return (
    <div className="rounded-md bg-primary/10 text-primary p-2 shrink-0">
      <ClipboardList className="size-5" />
    </div>
  );
}

function fmtRelative(iso: string) {
  try {
    return formatDistanceToNow(new Date(iso), {
      addSuffix: true,
      locale: localeId,
    });
  } catch {
    return iso;
  }
}

function deadlineInfo(iso: string) {
  const d = new Date(iso);
  const overdue = isPast(d);
  let label = "";
  if (overdue) label = "Terlambat";
  else if (isToday(d)) label = "Hari ini";
  else if (isTomorrow(d)) label = "Besok";
  else
    label = format(d, "d MMM yyyy, HH:mm", { locale: localeId });
  return { overdue, label, date: d };
}

// Countdown tenggat live (hari:jam:menit:detik) — update tiap detik.
function DeadlineCountdown({ deadline }: { deadline: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const left = new Date(deadline).getTime() - now;
  if (left <= 0) return null;
  const d = Math.floor(left / 86_400_000);
  const h = Math.floor((left % 86_400_000) / 3_600_000);
  const m = Math.floor((left % 3_600_000) / 60_000);
  const s = Math.floor((left % 60_000) / 1000);
  const urgent = left < 24 * 3600 * 1000; // < 1 hari
  return (
    <span
      className={
        urgent
          ? "font-mono font-semibold tabular-nums text-destructive"
          : "font-mono font-semibold tabular-nums text-amber-600 dark:text-amber-400"
      }
      title="Sisa waktu sebelum tenggat"
    >
      {d > 0 ? `${d}h ` : ""}
      {String(h).padStart(2, "0")}:{String(m).padStart(2, "0")}:
      {String(s).padStart(2, "0")}
    </span>
  );
}

/** Konversi SubmissionFile → item preview (tombol mata, tanpa download). */
function submissionToPreviewItem(
  f: SubmissionFile,
  uploaderName?: string
): CloudFileItem {
  return {
    id: f.id,
    name: f.name,
    size: f.size,
    mimetype: f.mimetype,
    storageKey: f.storageKey,
    cloudAccountId: null,
    createdAt: new Date().toISOString(),
    uploadedBy: "",
    uploader: uploaderName
      ? { id: "", name: uploaderName, username: uploaderName }
      : undefined,
    visibility: "ALL",
  };
}

export function AssignmentDetail({
  folderId,
  classroomId,
  me,
  ancestors,
  onNavigateUp,
}: {
  folderId: string;
  classroomId: string;
  me: MeResponse;
  ancestors: { id: string; name: string; classroomId: string | null }[];
  onNavigateUp: (folderId: string | null) => void;
}) {
  const qc = useQueryClient();
  const queryKey = ["cloud", "assignment", folderId];
  const formQueryKey = ["cloud", "assignment-form", folderId];
  const { data, isLoading, error, refetch } = useQuery<AssignmentDetailResponse>({
    queryKey,
    queryFn: async () => {
      const res = await fetch(`/api/cloud/assignments/${folderId}`, {
        cache: "no-store",
      });
      if (!res.ok) throw new Error("Gagal memuat tugas");
      return res.json();
    },
  });

  // Form tugas (anti-nyontek) — dimuat paralel dengan detail tugas.
  const [showBuilder, setShowBuilder] = useState(false);
  const [previewFile, setPreviewFile] = useState<CloudFileItem | null>(null);
  const enqueueDownload = useTransferStore((s) => s.enqueueDownload);
  const { data: formData } = useQuery<FormGetResponse>({
    queryKey: formQueryKey,
    queryFn: async () => {
      const res = await fetch(`/api/cloud/assignments/${folderId}/form`, {
        cache: "no-store",
      });
      if (!res.ok) throw new Error("Gagal memuat form");
      return res.json();
    },
    enabled: !isLoading && !error && !!data,
  });

  if (isLoading) {
    return (
      <div className="p-4 space-y-3">
        <Skeleton className="h-8 w-1/3" />
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }
  if (error || !data) {
    return (
      <div className="p-6 text-center text-sm text-destructive">
        Gagal memuat tugas.{" "}
        <Button variant="link" onClick={() => refetch()}>
          Coba lagi
        </Button>
      </div>
    );
  }

  const { assignment, myRole, mySubmission, roster, summary, referenceFiles } =
    data;
  const di = deadlineInfo(assignment.deadline);
  const hasForm = formData?.hasForm ?? false;

  return (
    <div className="flex flex-col h-full">
      {/* Breadcrumb */}
      <div className="border-b border-border px-4 py-3 flex items-center gap-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onNavigateUp(ancestors.length > 1 ? ancestors[ancestors.length - 2].id : null)}
        >
          <ArrowLeft className="size-4" /> Kembali
        </Button>
        <Breadcrumb className="ml-1">
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink
                className="cursor-pointer"
                onClick={() => onNavigateUp(null)}
              >
                Root
              </BreadcrumbLink>
            </BreadcrumbItem>
            {ancestors.map((a, i) => {
              const isLast = i === ancestors.length - 1;
              return (
                <span key={a.id} className="contents">
                  <BreadcrumbSeparator />
                  <BreadcrumbItem>
                    {isLast ? (
                      <BreadcrumbPage>{a.name}</BreadcrumbPage>
                    ) : (
                      <BreadcrumbLink
                        className="cursor-pointer"
                        onClick={() => onNavigateUp(a.id)}
                      >
                        {a.name}
                      </BreadcrumbLink>
                    )}
                  </BreadcrumbItem>
                </span>
              );
            })}
          </BreadcrumbList>
        </Breadcrumb>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto p-4 space-y-5 max-w-4xl w-full mx-auto">
        {/* Header */}
        <div className="space-y-2">
          <div className="flex items-center gap-2 flex-wrap">
            <Badge className="bg-amber-500 text-white border-transparent">
              Tugas
            </Badge>
            {hasForm ? (
              <Badge className="bg-primary text-primary-foreground border-transparent">
                Form Anti-nyontek
              </Badge>
            ) : null}
            {myRole === "TEACHER" ? (
              <Badge variant="secondary">Pengajar</Badge>
            ) : null}
            {assignment.maxScore ? (
              <Badge variant="outline">Skor maks {assignment.maxScore}</Badge>
            ) : null}
          </div>
          <h2 className="text-xl font-semibold">{assignment.title}</h2>
          {assignment.description ? (
            <p className="text-sm text-muted-foreground whitespace-pre-wrap">
              {assignment.description}
            </p>
          ) : null}
          <div className="flex items-center gap-2 text-sm flex-wrap">
            <span
              className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 font-medium ${
                di.overdue
                  ? "bg-destructive/10 text-destructive"
                  : "bg-amber-500/15 text-amber-700 dark:text-amber-300"
              }`}
            >
              <CalendarClock className="size-4" />
              Tenggat: {fmtDate(assignment.deadline)} ({di.label})
            </span>
            {!di.overdue ? (
              <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
                <Clock className="size-3.5" /> Sisa:{" "}
                <DeadlineCountdown deadline={assignment.deadline} />
              </span>
            ) : null}
            <span className="text-muted-foreground inline-flex items-center gap-1">
              <Clock className="size-3.5" /> Dibuat {fmtRelative(assignment.createdAt)}
            </span>
          </div>
        </div>

        <Separator />

        {/* ── Form tugas anti-nyontek ── */}
        {myRole === "STUDENT" && hasForm && formData?.form ? (
          <FormPlayer
            folderId={folderId}
            form={formData.form}
            attempt={formData.attempt}
            canStart={formData.canStart}
            deadlinePassed={formData.deadlinePassed}
            deadlineLabel={fmtDate(assignment.deadline)}
            deadlineISO={assignment.deadline}
            attemptsUsed={formData.attemptsUsed ?? 1}
            canRetry={formData.canRetry ?? false}
          />
        ) : myRole === "STUDENT" && !hasForm ? (
          <StudentSubmissionPanel
            assignmentId={assignment.id}
            mySubmission={mySubmission}
            overdue={di.overdue}
            onSubmitted={() => qc.invalidateQueries({ queryKey })}
            onPreview={(f) => setPreviewFile(submissionToPreviewItem(f, "Tugas saya"))}
          />
        ) : myRole === "TEACHER" ? (
          <div className="space-y-6">
            {/* Form builder / creator */}
            {hasForm && formData?.form ? (
              <div className="space-y-3">
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                    Susunan Form
                  </h3>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setShowBuilder((s) => !s)}
                  >
                    {showBuilder ? "Tutup editor" : "Lihat / Edit soal"}
                  </Button>
                </div>
                {showBuilder ? (
                  <FormBuilder
                    folderId={folderId}
                    initialSettings={formData.form}
                    initialQuestions={formData.form.questions}
                    hasAttempts={false}
                    onSaved={() => {
                      qc.invalidateQueries({ queryKey: formQueryKey });
                      qc.invalidateQueries({ queryKey });
                    }}
                  />
                ) : (
                  <Card className="p-4 flex items-center gap-3">
                    <FormIconBadge />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium">
                        Form anti-nyontek aktif ({formData.form.questions.length}{" "}
                        soal)
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Siswa mengerjakan lewat form dengan pengawasan
                        anti-nyontek.{" "}
                        {formData.form.timeLimitMin
                          ? `Batas waktu ${formData.form.timeLimitMin} menit.`
                          : "Tanpa batas waktu."}
                      </p>
                    </div>
                  </Card>
                )}
              </div>
            ) : (
              <Card className="p-5 space-y-3">
                <div className="flex items-start gap-3">
                  <FormIconBadge />
                  <div className="flex-1 min-w-0">
                    <h3 className="font-semibold">Buat Form Tugas (opsional)</h3>
                    <p className="text-sm text-muted-foreground">
                      Ubah tugas ini menjadi formulir anti-nyontek: soal PG,
                      multi-PG, isian, esai, upload file/gambar — dengan acak
                      soal, timer, dan deteksi pelanggaran.
                    </p>
                  </div>
                  <Button onClick={() => setShowBuilder(true)}>
                    <ClipboardList className="size-4 mr-1" /> Buat Form
                  </Button>
                </div>
                {showBuilder ? (
                  <FormBuilder
                    folderId={folderId}
                    initialSettings={null}
                    initialQuestions={[]}
                    hasAttempts={false}
                    onSaved={() => {
                      setShowBuilder(false);
                      qc.invalidateQueries({ queryKey: formQueryKey });
                      qc.invalidateQueries({ queryKey });
                    }}
                  />
                ) : null}
              </Card>
            )}

            {/* Form review panel */}
            {hasForm ? (
              <div className="space-y-3">
                <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                  Hasil & Pelanggaran
                </h3>
                <FormReview folderId={folderId} />
              </div>
            ) : (
              <TeacherRosterPanel
                roster={roster ?? []}
                summary={summary}
                onPreview={(f, name) =>
                  setPreviewFile(submissionToPreviewItem(f, name))
                }
              />
            )}
          </div>
        ) : null}

        {/* Student fallback (form mode but form data still loading) */}
        {myRole === "STUDENT" && hasForm && !formData?.form ? (
          <p className="text-sm text-muted-foreground">Memuat form tugas…</p>
        ) : null}

        {/* Reference materials */}
        <section className="space-y-2">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Materi pendukung
          </h3>
          {referenceFiles.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Belum ada materi diunggah pengajar.
            </p>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {referenceFiles.map((f) => (
                <Card key={f.id} className="p-3 gap-1">
                  <div className="flex items-start gap-3">
                    <div className="rounded-md bg-secondary p-2 text-secondary-foreground">
                      <FileIcon name={mimeToIcon(f.mimetype)} className="size-5" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-medium truncate" title={f.name}>
                        {f.name}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {formatBytes(f.size)} · {fmtRelative(f.createdAt)}
                      </p>
                    </div>
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-8"
                            onClick={() => setPreviewFile(f)}
                          >
                            <Eye className="size-4" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>Pratinjau</TooltipContent>
                      </Tooltip>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-8"
                            title="Unduh (latar belakang)"
                            onClick={() =>
                              enqueueDownload({
                                url: `/api/storage/${f.storageKey}?download=1`,
                                name: f.name,
                                size: f.size,
                                context: "Materi",
                                autoSave: true,
                              })
                            }
                          >
                            <Download className="size-4" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>Unduh</TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  </div>
                </Card>
              ))}
            </div>
          )}
          {myRole === "TEACHER" ? (
            <FileUpload
              folderId={folderId}
              classroomId={classroomId}
              onUploaded={() => qc.invalidateQueries({ queryKey })}
            />
          ) : null}
        </section>
      </div>

      {/* Pratinjau file (materi / pengumpulan siswa) — tanpa download */}
      <FilePreview file={previewFile} onClose={() => setPreviewFile(null)} />
    </div>
  );
}

function StudentSubmissionPanel({
  assignmentId,
  mySubmission,
  overdue,
  onSubmitted,
  onPreview,
}: {
  assignmentId: string;
  mySubmission: AssignmentDetailResponse["mySubmission"];
  overdue: boolean;
  onSubmitted: () => void;
  onPreview: (file: SubmissionFile) => void;
}) {
  const [note, setNote] = useState(mySubmission?.note ?? "");
  const [busy, setBusy] = useState(false);
  const [pendingFileId, setPendingFileId] = useState<string | null>(null);
  const enqueueDownload = useTransferStore((s) => s.enqueueDownload);

  // Keep note synced when remote submission changes.
  useMemo(() => {
    setNote(mySubmission?.note ?? "");
  }, [mySubmission?.note]);

  const submittedFile = mySubmission?.file ?? null;

  async function submitUlang() {
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append("assignmentId", assignmentId);
      if (note.trim()) fd.append("note", note.trim());
      const res = await fetch("/api/cloud/submissions", {
        method: "POST",
        body: fd,
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json?.error || "Gagal mengumpulkan");
        return;
      }
      toast.success(
        "Tugas dikumpulkan. File terbaru: " + (json.submission?.file?.name ?? "—")
      );
      onSubmitted();
    } finally {
      setBusy(false);
    }
  }

  async function submitPending() {
    if (!pendingFileId) {
      toast.error("Unggah file terlebih dahulu.");
      return;
    }
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append("assignmentId", assignmentId);
      if (note.trim()) fd.append("note", note.trim());
      // Use the pending uploaded file's id by re-uploading through submissions endpoint
      // (it expects a fresh File, so we instead instruct user to drag again? — simpler: upload directly here).
      // Re-upload not needed because submissions POST already takes a file. We provide nothing → no file.
      toast.error(
        "Gunakan tombol \"Kumpulkan tugas\" lalu unggah file pada dialog berikutnya."
      );
    } finally {
      setBusy(false);
    }
  }
  void submitPending;

  return (
    <Card className="p-4 gap-3">
      <div className="flex items-start gap-3">
        <div
          className={`rounded-md p-2 ${
            mySubmission
              ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
              : "bg-amber-500/15 text-amber-700 dark:text-amber-300"
          }`}
        >
          {mySubmission ? (
            <CheckCircle2 className="size-5" />
          ) : (
            <Upload className="size-5" />
          )}
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="font-semibold">
            {mySubmission ? "Sudah dikumpulkan" : "Belum dikumpulkan"}
          </h3>
          <p className="text-sm text-muted-foreground">
            {mySubmission
              ? `Dikumpulkan ${fmtRelative(mySubmission.submittedAt)}`
              : overdue
                ? "Tenggat sudah lewat. Masih bisa dikumpulkan (telat)."
                : "Unggah file tugas kamu di bawah."}
          </p>
        </div>
      </div>

      {submittedFile ? (
        <div className="rounded-md border border-border p-3 flex items-start gap-3">
          <div className="rounded-md bg-secondary p-2 text-secondary-foreground">
            <FileIcon
              name={mimeToIcon(submittedFile.mimetype)}
              className="size-5"
            />
          </div>
          <div className="flex-1 min-w-0">
            <p className="font-medium truncate" title={submittedFile.name}>
              {submittedFile.name}
            </p>
            <p className="text-xs text-muted-foreground">
              {formatBytes(submittedFile.size)} · {submittedFile.mimetype}
            </p>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <Button
              variant="ghost"
              size="icon"
              className="size-8"
              onClick={() => onPreview(submittedFile)}
              title="Pratinjau"
            >
              <Eye className="size-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-8"
              title="Unduh (latar belakang)"
              onClick={() =>
                enqueueDownload({
                  url: `/api/storage/${submittedFile.storageKey}?download=1`,
                  name: submittedFile.name,
                  size: submittedFile.size,
                  context: "Pengumpulan",
                  autoSave: true,
                })
              }
            >
              <Download className="size-4" />
            </Button>
          </div>
        </div>
      ) : null}

      <div className="space-y-2">
        <Label htmlFor="sub-note">Catatan (opsional)</Label>
        <AutoTextarea
          id="sub-note"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxHeight={160}
          placeholder="Pesan untuk pengajar…"
        />
      </div>

      {/* Upload + submit (file is uploaded directly in the submission request). */}
      <SubmissionUpload
        assignmentId={assignmentId}
        note={note}
        disabled={busy}
        onSubmitted={onSubmitted}
        onPendingFile={setPendingFileId}
      />
      <p className="text-xs text-muted-foreground">
        {pendingFileId
          ? "File terunggah. Klik \"Kumpulkan ulang\" untuk menyimpan."
          : "Unggah file untuk menggantikan pengumpulan saat ini."}
      </p>

      {mySubmission ? (
        <Button onClick={submitUlang} disabled={busy} variant="outline">
          {busy ? <Loader2 className="size-4 animate-spin" /> : null}
          Submit ulang (catatan)
        </Button>
      ) : null}
    </Card>
  );
}

function SubmissionUpload({
  assignmentId,
  note,
  disabled,
  onSubmitted,
  onPendingFile,
}: {
  assignmentId: string;
  note: string;
  disabled: boolean;
  onSubmitted: () => void;
  onPendingFile: (fileId: string | null) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [percent, setPercent] = useState<number | null>(null);

  async function handleFile(file: File) {
    if (file.size === 0) {
      toast.error("File kosong.");
      return;
    }
    setBusy(true);
    setPercent(0);
    try {
      const res = await uploadSmart<
        { submission?: { file?: { id?: string } }; error?: string } & Record<
          string,
          unknown
        >
      >(
        file,
        { kind: "submission", assignmentId, note },
        { onProgress: (p) => setPercent(p.percent) }
      );
      if (!res.ok) {
        toast.error(res.json.error || "Gagal mengumpulkan tugas");
        return;
      }
      toast.success("Tugas dikumpulkan.");
      onSubmitted();
      onPendingFile(null);
    } finally {
      setBusy(false);
      setPercent(null);
    }
  }

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
      }}
      onDrop={(e) => {
        e.preventDefault();
        if (disabled || busy) return;
        Array.from(e.dataTransfer.files).forEach(handleFile);
      }}
      className="rounded-lg border-2 border-dashed border-border hover:border-primary/50 hover:bg-accent/30 transition-colors px-4 py-5 text-center cursor-pointer"
      onClick={() => {
        if (disabled || busy) return;
        const input = document.createElement("input");
        input.type = "file";
        input.onchange = () => {
          if (input.files && input.files.length > 0) {
            Array.from(input.files).forEach(handleFile);
          }
        };
        input.click();
      }}
    >
      <div className="flex flex-col items-center gap-1.5">
        {busy ? (
          <>
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
            <p className="text-sm font-medium">
              {percent != null && percent < 95
                ? `Mengunggah… ${percent}%`
                : "Menyimpan ke cloud…"}
            </p>
            {percent != null ? (
              <div className="w-56 max-w-full">
                <Progress value={percent} className="h-1.5" />
              </div>
            ) : null}
          </>
        ) : (
          <>
            <Upload className="size-6 text-muted-foreground" />
            <p className="text-sm font-medium">
              Tarik file tugas di sini atau klik untuk pilih
            </p>
            <p className="text-xs text-muted-foreground">Maksimal 100 MB.</p>
          </>
        )}
      </div>
    </div>
  );
}

function TeacherRosterPanel({
  roster,
  summary,
  onPreview,
}: {
  roster: AssignmentDetailResponse["roster"];
  summary: AssignmentDetailResponse["summary"];
  onPreview: (file: SubmissionFile, uploaderName: string) => void;
}) {
  const enqueueDownload = useTransferStore((s) => s.enqueueDownload);
  if (!roster) return null;
  const submittedCount = summary?.submittedCount ?? roster.filter((r) => r.submitted).length;
  const studentCount = summary?.studentCount ?? roster.filter((r) => r.role === "STUDENT").length;
  const total = summary?.total ?? roster.length;
  const pct = studentCount > 0 ? Math.round((submittedCount / studentCount) * 100) : 0;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <Users className="size-4 text-muted-foreground" />
        <span className="text-sm font-medium">
          {submittedCount} dari {studentCount} siswa sudah mengumpulkan
        </span>
        <Badge variant="outline">{pct}%</Badge>
        <span className="text-xs text-muted-foreground">· Total {total} anggota</span>
      </div>

      <div className="rounded-lg border border-border overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Nama</TableHead>
              <TableHead className="w-[120px]">Status</TableHead>
              <TableHead className="w-[160px]">Waktu</TableHead>
              <TableHead>File</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {roster.map((r) => (
              <TableRow key={r.user.id}>
                <TableCell className="font-medium">
                  {r.user.name}
                  {r.role === "TEACHER" ? (
                    <Badge variant="outline" className="ml-2 text-xs">
                      Pengajar
                    </Badge>
                  ) : null}
                </TableCell>
                <TableCell>
                  {r.submitted ? (
                    <Badge className="bg-emerald-500 text-white border-transparent">
                      Terkumpul
                    </Badge>
                  ) : (
                    <Badge variant="secondary">Belum</Badge>
                  )}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {r.submittedAt ? fmtRelative(r.submittedAt) : "—"}
                </TableCell>
                <TableCell>
                  {r.file ? (
                    <span className="inline-flex items-center gap-2 min-w-0">
                      <button
                        type="button"
                        className="truncate max-w-[180px] text-left hover:underline"
                        title={`Pratinjau "${r.file.name}"`}
                        onClick={() => onPreview(r.file!, r.user.name)}
                      >
                        {r.file.name}
                      </button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-7"
                        onClick={() => r.file && onPreview(r.file, r.user.name)}
                        title="Pratinjau tanpa download"
                      >
                        <Eye className="size-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-7"
                        title="Unduh (latar belakang)"
                        onClick={() => {
                          if (!r.file) return;
                          enqueueDownload({
                            url: `/api/storage/${r.file.storageKey}?download=1`,
                            name: r.file.name,
                            size: r.file.size,
                            context: "Jawaban Form",
                            autoSave: true,
                          });
                        }}
                      >
                        <Download className="size-3.5" />
                      </Button>
                    </span>
                  ) : (
                    <span className="text-xs text-muted-foreground">—</span>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
