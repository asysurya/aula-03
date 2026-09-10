"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  ArrowDown,
  ArrowUp,
  BookMarked,
  BookOpen,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Circle,
  Copy,
  Download,
  FileJson,
  FileQuestion,
  ImagePlus,
  LayoutTemplate,
  Loader2,
  Plus,
  Save,
  ShieldAlert,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { uploadSmart } from "@/lib/upload-client";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import {
  FORM_QUESTION_TYPES,
  makeOptionId,
  makeQuestionId,
  questionTypeMeta,
  type FormOption,
  type FormQuestionDTO,
  type FormQuestionType,
  type FormSettings,
} from "@/lib/form-types";
import type { FormIOParsedQuestion } from "@/lib/form-io";
import {
  AiGenerateDialog,
  FormImportDialog,
  downloadFormJson,
  type ApplyMode,
} from "./form-io-dialogs";
import { QuestionBankDialog } from "./question-bank-dialog";
import { FORM_TEMPLATES } from "./form-templates";

// ── Local question model (editable, may have local ids) ──────────

interface EditableQuestion {
  localId: string;
  id?: string; // server id after first save
  type: FormQuestionType;
  text: string;
  points: number;
  required: boolean;
  options: FormOption[];
  correct: string[];
  imageFileId: string | null;
  imagePreview?: { name: string; url: string } | null;
}

function dtoToEditable(q: FormQuestionDTO): EditableQuestion {
  return {
    localId: makeQuestionId(),
    id: q.id,
    type: q.type,
    text: q.text,
    points: q.points,
    required: q.required,
    options: q.options.map((o) => ({ ...o })),
    correct: q.correct ?? [],
    imageFileId: null,
    imagePreview: q.imageFile
      ? {
          name: q.imageFile.name,
          url: `/api/storage/${q.imageFile.storageKey}`,
        }
      : null,
  };
}

export function FormBuilder({
  folderId,
  initialSettings,
  initialQuestions,
  hasAttempts,
  onSaved,
}: {
  folderId: string;
  initialSettings: FormSettings | null;
  initialQuestions: FormQuestionDTO[];
  hasAttempts: boolean;
  onSaved: () => void;
}) {
  const qc = useQueryClient();
  const [settings, setSettings] = useState<FormSettings>(
    initialSettings ?? {
      shuffleQuestions: true,
      shuffleOptions: true,
      oneByOne: true,
      preventPaste: true,
      trackTabSwitch: true,
      timeLimitMin: null,
      showResult: true,
      allowBack: false,
      maxAttempts: 1,
    }
  );
  const [questions, setQuestions] = useState<EditableQuestion[]>(
    initialQuestions.map(dtoToEditable)
  );
  const [saving, setSaving] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [bankOpen, setBankOpen] = useState(false);
  const [templateOpen, setTemplateOpen] = useState(false);
  const [timeLimitInput, setTimeLimitInput] = useState<string>(
    initialSettings?.timeLimitMin != null
      ? String(initialSettings.timeLimitMin)
      : ""
  );
  const [maxAttemptsInput, setMaxAttemptsInput] = useState<string>(
    initialSettings?.maxAttempts != null && initialSettings.maxAttempts > 1
      ? String(initialSettings.maxAttempts)
      : ""
  );
  // Soal yang di-collapse (ringkas) — biar layar tidak penuh saat banyak soal.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const locked = hasAttempts;

  // Terapkan hasil import JSON / draf AI: konversi ke model editable.
  function applyImported(
    imported: FormIOParsedQuestion[],
    mode: ApplyMode,
    importedSettings?: Partial<FormSettings>
  ) {
    if (imported.length === 0) return;
    const toEditable = imported.map((q) => ({
      localId: makeQuestionId(),
      type: q.type,
      text: q.text,
      points: q.points,
      required: q.required,
      options: q.options.map((o) => ({ ...o })),
      correct: [...q.correct],
      imageFileId: null,
      imagePreview: null,
    }));
    setQuestions((prev) =>
      mode === "replace" ? toEditable : [...prev, ...toEditable]
    );
    if (importedSettings && Object.keys(importedSettings).length > 0) {
      setSettings((prev) => ({ ...prev, ...importedSettings }));
      if (importedSettings.timeLimitMin != null) {
        setTimeLimitInput(String(importedSettings.timeLimitMin));
      } else if ("timeLimitMin" in importedSettings) {
        setTimeLimitInput("");
      }
    }
    toast.success(
      mode === "replace"
        ? `${imported.length} soal dimuat (mengganti yang lama)`
        : `${imported.length} soal ditambahkan`
    );
  }

  function exportCurrent() {
    if (questions.length === 0) {
      toast.error("Belum ada soal untuk diexport");
      return;
    }
    downloadFormJson(
      {
        ...settings,
        timeLimitMin: timeLimitInput ? parseInt(timeLimitInput, 10) : null,
      },
      questions.map((q) => ({
        type: q.type,
        text: q.text,
        points: q.points,
        required: q.required,
        options: q.options,
        correct: q.correct,
      })),
      `form-tugas-${folderId.slice(-8)}`
    );
  }

  // ── Simpan satu soal ke Bank Soal pribadi ──
  async function saveToBank(localId: string) {
    const q = questions.find((x) => x.localId === localId);
    if (!q) return;
    if (!q.text.trim()) {
      toast.error("Tulis dulu teks soalnya sebelum disimpan ke bank");
      return;
    }
    try {
      const res = await fetch("/api/forms/question-bank", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: q.type,
          text: q.text,
          points: q.points,
          options: q.options.map((o) => ({ id: o.id, label: o.label })),
          correct: q.type === "PG" || q.type === "MULTI_PG" ? q.correct : [],
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json?.error || "Gagal menyimpan ke bank soal");
        return;
      }
      toast.success("Soal tersimpan ke bank soalmu");
    } catch {
      toast.error("Gagal menyimpan ke bank soal");
    }
  }

  // ── Terapkan template siap pakai ──
  function applyTemplate(key: string) {
    const tpl = FORM_TEMPLATES.find((t) => t.key === key);
    if (!tpl) return;
    if (
      questions.length > 0 &&
      !window.confirm(
        `Template "${tpl.name}" akan MENGGANTI ${questions.length} soal yang sekarang. Lanjut?`
      )
    ) {
      return;
    }
    applyImported(tpl.questions, "replace", tpl.settings);
    if (tpl.settings.maxAttempts != null) {
      setMaxAttemptsInput(
        tpl.settings.maxAttempts > 1 ? String(tpl.settings.maxAttempts) : ""
      );
    }
    if (tpl.settings.timeLimitMin !== undefined) {
      setTimeLimitInput(
        tpl.settings.timeLimitMin != null
          ? String(tpl.settings.timeLimitMin)
          : ""
      );
    }
    setTemplateOpen(false);
    toast.success(`Template "${tpl.name}" diterapkan — sesuaikan teksnya`);
  }

  function addQuestion() {
    setQuestions((prev) => [
      ...prev,
      {
        localId: makeQuestionId(),
        type: "PG",
        text: "",
        points: 1,
        required: true,
        options: [
          { id: makeOptionId(), label: "" },
          { id: makeOptionId(), label: "" },
          { id: makeOptionId(), label: "" },
          { id: makeOptionId(), label: "" },
        ],
        correct: [],
        imageFileId: null,
      },
    ]);
  }

  function moveQuestion(localId: string, dir: -1 | 1) {
    setQuestions((prev) => {
      const idx = prev.findIndex((q) => q.localId === localId);
      if (idx < 0) return prev;
      const target = idx + dir;
      if (target < 0 || target >= prev.length) return prev;
      const copy = [...prev];
      [copy[idx], copy[target]] = [copy[target], copy[idx]];
      return copy;
    });
  }

  function duplicateQuestion(localId: string) {
    setQuestions((prev) => {
      const idx = prev.findIndex((q) => q.localId === localId);
      if (idx < 0) return prev;
      const src = prev[idx];
      const clone: EditableQuestion = {
        ...src,
        localId: makeQuestionId(),
        id: undefined,
        options: src.options.map((o) => ({ ...o, id: makeOptionId() })),
        correct: [], // force re-marking correct answers
      };
      const copy = [...prev];
      copy.splice(idx + 1, 0, clone);
      return copy;
    });
  }

  function removeQuestion(localId: string) {
    setQuestions((prev) => prev.filter((q) => q.localId !== localId));
  }

  function updateQuestion(
    localId: string,
    patch: Partial<EditableQuestion>
  ) {
    setQuestions((prev) =>
      prev.map((q) => (q.localId === localId ? { ...q, ...patch } : q))
    );
  }

  function addOption(localId: string) {
    setQuestions((prev) =>
      prev.map((q) =>
        q.localId === localId
          ? { ...q, options: [...q.options, { id: makeOptionId(), label: "" }] }
          : q
      )
    );
  }

  function updateOption(localId: string, optionId: string, label: string) {
    setQuestions((prev) =>
      prev.map((q) =>
        q.localId === localId
          ? {
              ...q,
              options: q.options.map((o) =>
                o.id === optionId ? { ...o, label } : o
              ),
            }
          : q
      )
    );
  }

  function removeOption(localId: string, optionId: string) {
    setQuestions((prev) =>
      prev.map((q) =>
        q.localId === localId
          ? {
              ...q,
              options: q.options.filter((o) => o.id !== optionId),
              correct: q.correct.filter((c) => c !== optionId),
            }
          : q
      )
    );
  }

  function toggleCorrect(localId: string, optionId: string) {
    setQuestions((prev) =>
      prev.map((q) => {
        if (q.localId !== localId) return q;
        if (q.type === "PG") {
          return { ...q, correct: [optionId] };
        }
        // MULTI_PG toggle
        const has = q.correct.includes(optionId);
        return {
          ...q,
          correct: has
            ? q.correct.filter((c) => c !== optionId)
            : [...q.correct, optionId],
        };
      })
    );
  }

  async function uploadQuestionImage(localId: string, file: File) {
    try {
      const res = await uploadSmart<
        { file?: { id: string; name: string; storageKey: string }; error?: string } &
          Record<string, unknown>
      >(file, { kind: "form-image", folderId });
      const json = res.json;
      if (!res.ok || !json.file) {
        toast.error(json?.error || "Gagal mengunggah gambar soal");
        return;
      }
      updateQuestion(localId, {
        imageFileId: json.file.id as string,
        imagePreview: {
          name: json.file.name,
          url: `/api/storage/${json.file.storageKey}`,
        },
      });
      toast.success("Gambar soal terunggah");
    } catch {
      toast.error("Gagal mengunggah gambar soal");
    }
  }

  async function save() {
    // Client-side validation
    if (questions.length === 0) {
      toast.error("Tambahkan minimal satu soal");
      return;
    }
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      if (!q.text.trim()) {
        toast.error(`Soal #${i + 1}: teks soal masih kosong`);
        return;
      }
      if (q.type === "PG" || q.type === "MULTI_PG") {
        if (q.options.length < 2) {
          toast.error(`Soal #${i + 1}: minimal 2 opsi jawaban`);
          return;
        }
        if (q.options.some((o) => !o.label.trim())) {
          toast.error(`Soal #${i + 1}: ada label opsi yang kosong`);
          return;
        }
        if (q.type === "PG" && q.correct.length !== 1) {
          toast.error(`Soal #${i + 1}: tandai tepat 1 jawaban benar`);
          return;
        }
        if (q.type === "MULTI_PG" && q.correct.length < 1) {
          toast.error(`Soal #${i + 1}: tandai minimal 1 jawaban benar`);
          return;
        }
      }
    }

    setSaving(true);
    try {
      const res = await fetch(`/api/cloud/assignments/${folderId}/form`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          settings: {
            ...settings,
            timeLimitMin: timeLimitInput
              ? parseInt(timeLimitInput, 10)
              : null,
            maxAttempts: maxAttemptsInput
              ? Math.min(10, Math.max(1, parseInt(maxAttemptsInput, 10) || 1))
              : 1,
          },
          questions: questions.map((q) => ({
            id: q.id,
            type: q.type,
            text: q.text,
            points: q.points,
            required: q.required,
            options: q.options,
            correct: q.type === "PG" || q.type === "MULTI_PG" ? q.correct : [],
            imageFileId: q.imageFileId,
          })),
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        if (json?.error === "FORM_LOCKED_ATTEMPTS") {
          toast.error(
            "Form terkunci — sudah ada siswa yang mulai mengerjakan. Tidak bisa diubah."
          );
        } else {
          toast.error(json?.error || "Gagal menyimpan form");
        }
        return;
      }
      toast.success("Form tugas tersimpan");
      qc.invalidateQueries({ queryKey: ["cloud", "assignment", folderId] });
      onSaved();
    } finally {
      setSaving(false);
    }
  }

  const totalPoints = questions.reduce(
    (s, q) => s + (Number.isFinite(q.points) ? q.points : 0),
    0
  );
  const autoGradable = questions.filter(
    (q) => questionTypeMeta(q.type).autoGradable
  ).length;

  return (
    <div className="space-y-5">
      {/* Anti-cheat settings */}
      <Card className="p-4 space-y-4">
        <div className="flex items-center gap-2 flex-wrap">
          <ShieldAlert className="size-5 text-primary" />
          <h3 className="font-semibold">Pengaturan Anti-nyontek</h3>
          {locked ? (
            <Badge variant="destructive">Terkunci — ada pengerjaan</Badge>
          ) : null}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <SettingSwitch
            label="Acak urutan soal"
            hint="Setiap siswa mendapat urutan soal berbeda"
            checked={settings.shuffleQuestions}
            disabled={locked}
            onChange={(v) =>
              setSettings((s) => ({ ...s, shuffleQuestions: v }))
            }
          />
          <SettingSwitch
            label="Acak urutan opsi"
            hint="Opsi jawaban PG ikut diacak"
            checked={settings.shuffleOptions}
            disabled={locked}
            onChange={(v) =>
              setSettings((s) => ({ ...s, shuffleOptions: v }))
            }
          />
          <SettingSwitch
            label="Satu soal per layar"
            hint="Soal tampil satu per satu secara berurutan"
            checked={settings.oneByOne}
            disabled={locked}
            onChange={(v) => setSettings((s) => ({ ...s, oneByOne: v }))}
          />
          <SettingSwitch
            label="Boleh kembali ke soal sebelumnya"
            hint="Tampilkan tombol “Sebelumnya” saat mengerjakan (mode satu soal per layar)"
            checked={settings.allowBack ?? false}
            disabled={locked || !settings.oneByOne}
            onChange={(v) => setSettings((s) => ({ ...s, allowBack: v }))}
          />
          <SettingSwitch
            label="Larang paste"
            hint="Copy-paste jawaban diblokir & dicatat"
            checked={settings.preventPaste}
            disabled={locked}
            onChange={(v) => setSettings((s) => ({ ...s, preventPaste: v }))}
          />
          <SettingSwitch
            label="Deteksi pindah tab"
            hint="Perpindahan tab/jendela dicatat sebagai pelanggaran"
            checked={settings.trackTabSwitch}
            disabled={locked}
            onChange={(v) =>
              setSettings((s) => ({ ...s, trackTabSwitch: v }))
            }
          />
          <SettingSwitch
            label="Tampilkan nilai ke siswa"
            hint="Nilai PG langsung muncul setelah submit"
            checked={settings.showResult}
            disabled={locked}
            onChange={(v) => setSettings((s) => ({ ...s, showResult: v }))}
          />
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div className="space-y-1">
            <Label htmlFor="timelimit">
              Batas waktu (menit, kosong = tanpa batas)
            </Label>
            <Input
              id="timelimit"
              inputMode="numeric"
              className="w-36"
              placeholder="cth: 30"
              value={timeLimitInput}
              disabled={locked}
              onChange={(e) =>
                setTimeLimitInput(
                  e.target.value.replace(/[^0-9]/g, "").slice(0, 3)
                )
              }
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="maxattempts">
              Jumlah percobaan (1–10, kosong = 1)
            </Label>
            <Input
              id="maxattempts"
              inputMode="numeric"
              className="w-36"
              placeholder="cth: 3"
              value={maxAttemptsInput}
              disabled={locked}
              onChange={(e) =>
                setMaxAttemptsInput(
                  e.target.value.replace(/[^0-9]/g, "").slice(0, 2)
                )
              }
            />
          </div>
          <div className="text-xs text-muted-foreground pt-5">
            Timer berjalan sejak siswa mulai. Saat habis, jawaban tersimpan
            otomatis dikirim. Percobaan &gt; 1: siswa boleh mengulang setelah
            mengumpulkan — nilai yang dipakai percobaan terakhir.
          </div>
        </div>
      </Card>

      {/* Questions */}
      <div className="space-y-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <h3 className="font-semibold flex items-center gap-2">
            <FileQuestion className="size-5 text-primary" />
            Soal ({questions.length})
          </h3>
          <div className="flex items-center gap-4 flex-wrap">
            <div className="text-xs text-muted-foreground flex gap-3">
              <span>
                Total poin: <b className="text-foreground">{totalPoints}</b>
              </span>
              <span>
                Dinilai otomatis:{" "}
                <b className="text-foreground">{autoGradable}</b>
              </span>
            </div>
            {questions.length > 1 ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  setCollapsed((prev) =>
                    prev.size > 0
                      ? new Set()
                      : new Set(questions.map((q) => q.localId))
                  )
                }
                title={
                  collapsed.size > 0
                    ? "Buka semua soal"
                    : "Ringkas semua soal (biar tidak memenuhi layar)"
                }
              >
                {collapsed.size > 0 ? (
                  <ChevronsDownUp className="size-3.5 mr-1" />
                ) : (
                  <ChevronsUpDown className="size-3.5 mr-1" />
                )}
                {collapsed.size > 0 ? "Buka semua" : "Ringkas semua"}
              </Button>
            ) : null}
            <div className="flex items-center gap-1.5">
              <Button
                size="sm"
                variant="outline"
                onClick={() => setTemplateOpen(true)}
                disabled={locked}
                title="Template tugas siap pakai"
              >
                <LayoutTemplate className="size-3.5 mr-1" /> Template
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setBankOpen(true)}
                title="Ambil soal dari Bank Soal pribadi"
              >
                <BookOpen className="size-3.5 mr-1" /> Bank
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setAiOpen(true)}
                disabled={locked}
                title="Buat draf soal dengan AI dari prompt bebas"
              >
                <Sparkles className="size-3.5 mr-1" /> Buat dengan AI
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setImportOpen(true)}
                disabled={locked}
                title="Impor soal dari file/teks JSON"
              >
                <FileJson className="size-3.5 mr-1" /> Impor
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={exportCurrent}
                disabled={questions.length === 0}
                title="Export soal + pengaturan ke file JSON"
              >
                <Download className="size-3.5 mr-1" /> Export
              </Button>
            </div>
          </div>
        </div>

        {locked ? (
          <p className="text-sm text-muted-foreground rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2">
            Form tidak bisa diedit karena sudah ada siswa yang mengerjakan.
          </p>
        ) : null}

        <div className="space-y-3">
          {questions.map((q, i) => {
            const meta = questionTypeMeta(q.type);
            const isCollapsed = collapsed.has(q.localId);
            return (
              <Card key={q.localId} className="p-4 space-y-3">
                {/* Question header */}
                <div className="flex items-center gap-2 flex-wrap">
                  <button
                    type="button"
                    onClick={() =>
                      setCollapsed((prev) => {
                        const next = new Set(prev);
                        if (next.has(q.localId)) next.delete(q.localId);
                        else next.add(q.localId);
                        return next;
                      })
                    }
                    className="flex items-center gap-1.5 rounded-md px-1.5 py-0.5 hover:bg-accent transition-colors"
                    aria-label={
                      isCollapsed ? "Buka soal ini" : "Ringkas soal ini"
                    }
                    title={
                      isCollapsed ? "Buka soal ini" : "Ringkas soal ini"
                    }
                  >
                    <Badge variant="secondary" className="font-mono">
                      #{i + 1}
                    </Badge>
                    {isCollapsed ? (
                      <ChevronRight className="size-4 text-muted-foreground" />
                    ) : (
                      <ChevronDown className="size-4 text-muted-foreground" />
                    )}
                  </button>
                  {isCollapsed ? (
                    <span className="text-sm text-muted-foreground truncate flex-1 min-w-0">
                      {q.text.trim() || "(soal belum ditulis)"}
                    </span>
                  ) : null}
                  <div className={cn("flex items-center gap-2 flex-wrap", isCollapsed && "ml-auto")}>
                    {isCollapsed ? (
                      <>
                        <Badge variant="outline" className="text-[10px] shrink-0">
                          {meta.label}
                        </Badge>
                        <Badge variant="secondary" className="text-[10px] shrink-0">
                          {q.points} poin
                        </Badge>
                      </>
                    ) : (
                      <Select
                        value={q.type}
                        disabled={locked}
                        onValueChange={(v) =>
                          updateQuestion(q.localId, {
                            type: v as FormQuestionType,
                            correct: [],
                          })
                        }
                      >
                        <SelectTrigger className="w-[200px] h-8">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {FORM_QUESTION_TYPES.map((t) => (
                            <SelectItem key={t.value} value={t.value}>
                              {t.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                    <span className="text-xs text-muted-foreground hidden sm:inline">
                      {!isCollapsed ? meta.hint : ""}
                    </span>
                    <div className="flex-1" />
                    <div className="flex items-center gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-7"
                        disabled={locked}
                        onClick={() => void saveToBank(q.localId)}
                        aria-label="Simpan ke bank soal"
                        title="Simpan soal ini ke Bank Soal pribadi"
                      >
                        <BookMarked className="size-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-7"
                        disabled={locked || i === 0}
                        onClick={() => moveQuestion(q.localId, -1)}
                        aria-label="Naikkan"
                      >
                        <ArrowUp className="size-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-7"
                        disabled={locked || i === questions.length - 1}
                        onClick={() => moveQuestion(q.localId, 1)}
                        aria-label="Turunkan"
                      >
                        <ArrowDown className="size-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-7"
                        disabled={locked}
                        onClick={() => duplicateQuestion(q.localId)}
                        aria-label="Duplikat"
                      >
                        <Copy className="size-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-7 text-destructive hover:text-destructive"
                        disabled={locked}
                        onClick={() => removeQuestion(q.localId)}
                        aria-label="Hapus soal"
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    </div>
                  </div>
                </div>

                {!isCollapsed ? (
                  <>
                {/* Question text */}
                <div className="space-y-1.5">
                  <Label>Teks soal</Label>
                  <Textarea
                    value={q.text}
                    disabled={locked}
                    rows={2}
                    maxLength={2000}
                    placeholder="Tulis pertanyaan di sini…"
                    onChange={(e) =>
                      updateQuestion(q.localId, { text: e.target.value })
                    }
                  />
                </div>

                {/* Question image */}
                {!meta.isUpload ? (
                  <div className="space-y-1.5">
                    <Label>Gambar soal (opsional)</Label>
                    {q.imagePreview ? (
                      <div className="flex items-center gap-2 rounded-md border border-border p-2">
                        <img
                          src={q.imagePreview.url}
                          alt={q.imagePreview.name}
                          className="h-14 rounded object-cover"
                        />
                        <span className="text-xs text-muted-foreground truncate flex-1">
                          {q.imagePreview.name}
                        </span>
                        {!locked ? (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-7"
                            onClick={() =>
                              updateQuestion(q.localId, {
                                imageFileId: null,
                                imagePreview: null,
                              })
                            }
                            aria-label="Hapus gambar"
                          >
                            <X className="size-3.5" />
                          </Button>
                        ) : null}
                      </div>
                    ) : (
                      <label
                        className={cn(
                          "flex items-center gap-2 rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted-foreground cursor-pointer hover:bg-accent/40 transition-colors",
                          locked && "opacity-50 pointer-events-none"
                        )}
                      >
                        <ImagePlus className="size-4" />
                        Klik untuk unggah gambar pendukung soal (MEGA)
                        <input
                          type="file"
                          accept="image/*"
                          className="hidden"
                          onChange={(e) => {
                            const f = e.target.files?.[0];
                            if (f) void uploadQuestionImage(q.localId, f);
                          }}
                        />
                      </label>
                    )}
                  </div>
                ) : null}

                {/* Options editor (PG / MULTI_PG) */}
                {meta.hasOptions ? (
                  <div className="space-y-2">
                    <Label>
                      Opsi jawaban — klik lingkaran untuk menandai jawaban benar{" "}
                      {q.type === "MULTI_PG" ? "(bisa lebih dari satu)" : ""}
                    </Label>
                    <div className="space-y-1.5">
                      {q.options.map((o, oi) => {
                        const isCorrect = q.correct.includes(o.id);
                        return (
                          <div key={o.id} className="flex items-center gap-2">
                            <button
                              type="button"
                              disabled={locked}
                              onClick={() => toggleCorrect(q.localId, o.id)}
                              className={cn(
                                "shrink-0 rounded-full transition-colors",
                                isCorrect
                                  ? "text-primary"
                                  : "text-muted-foreground hover:text-foreground"
                              )}
                              title={
                                isCorrect
                                  ? "Jawaban benar (klik untuk batal)"
                                  : "Tandai sebagai jawaban benar"
                              }
                            >
                              {isCorrect ? (
                                <CheckCircle2 className="size-5" />
                              ) : (
                                <Circle className="size-5" />
                              )}
                            </button>
                            <Input
                              value={o.label}
                              disabled={locked}
                              maxLength={300}
                              placeholder={`Opsi ${String.fromCharCode(65 + oi)}`}
                              onChange={(e) =>
                                updateOption(q.localId, o.id, e.target.value)
                              }
                            />
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-7 text-destructive hover:text-destructive shrink-0"
                              disabled={locked || q.options.length <= 2}
                              onClick={() => removeOption(q.localId, o.id)}
                              aria-label="Hapus opsi"
                            >
                              <Trash2 className="size-3.5" />
                            </Button>
                          </div>
                        );
                      })}
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={locked || q.options.length >= 10}
                      onClick={() => addOption(q.localId)}
                    >
                      <Plus className="size-3.5" /> Tambah opsi
                    </Button>
                  </div>
                ) : null}

                {/* Points & required */}
                <Separator />
                <div className="flex items-center gap-4 flex-wrap">
                  <div className="flex items-center gap-2">
                    <Label htmlFor={`pts-${q.localId}`} className="text-xs">
                      Poin
                    </Label>
                    <Input
                      id={`pts-${q.localId}`}
                      inputMode="numeric"
                      className="w-20 h-8"
                      value={String(q.points)}
                      disabled={locked}
                      onChange={(e) =>
                        updateQuestion(q.localId, {
                          points: parseInt(
                            e.target.value.replace(/[^0-9]/g, "") || "0",
                            10
                          ),
                        })
                      }
                    />
                  </div>
                  <label className="flex items-center gap-2 text-xs cursor-pointer">
                    <Switch
                      checked={q.required}
                      disabled={locked}
                      onCheckedChange={(v) =>
                        updateQuestion(q.localId, { required: v })
                      }
                    />
                    Wajib dijawab
                  </label>
                </div>
                  </>
                ) : null}
              </Card>
            );
          })}
        </div>

        {!locked ? (
          <Button variant="outline" onClick={addQuestion} className="w-full">
            <Plus className="size-4" /> Tambah Soal
          </Button>
        ) : null}
      </div>

      {/* Save */}
      <div className="flex items-center justify-end gap-2 pb-2">
        <Button onClick={save} disabled={saving || locked}>
          {saving ? (
            <Loader2 className="size-4 animate-spin mr-1" />
          ) : (
            <Save className="size-4 mr-1" />
          )}
          Simpan Form Tugas
        </Button>
      </div>

      {/* Dialog AI + Import JSON */}
      <AiGenerateDialog
        open={aiOpen}
        onOpenChange={setAiOpen}
        onApply={applyImported}
      />
      <FormImportDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        onApply={applyImported}
      />

      {/* Bank soal pribadi */}
      <QuestionBankDialog
        open={bankOpen}
        onOpenChange={setBankOpen}
        onPick={(q) => {
          setQuestions((prev) => [
            ...prev,
            {
              localId: makeQuestionId(),
              type: q.type,
              text: q.text,
              points: q.points,
              required: q.required,
              options: q.options.map((o) => ({ ...o })),
              correct: [...q.correct],
              imageFileId: null,
              imagePreview: null,
            },
          ]);
        }}
      />

      {/* Template tugas siap pakai */}
      <Dialog open={templateOpen} onOpenChange={setTemplateOpen}>
        <DialogContent className="max-w-lg max-h-[75vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <LayoutTemplate className="size-5 text-primary" /> Template Tugas
            </DialogTitle>
            <DialogDescription>
              Struktur soal + pengaturan anti-nyontek yang sudah terisi —
              tinggal sesuaikan teksnya.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            {FORM_TEMPLATES.map((t) => (
              <button
                key={t.key}
                type="button"
                onClick={() => applyTemplate(t.key)}
                disabled={locked}
                className="flex items-start gap-3 rounded-lg border border-border p-3 text-left hover:border-primary/50 hover:bg-accent/40 transition-colors disabled:opacity-50"
              >
                <span className="text-xl shrink-0">{t.emoji}</span>
                <div className="min-w-0">
                  <p className="text-sm font-semibold">{t.name}</p>
                  <p className="text-xs text-muted-foreground">{t.description}</p>
                  <p className="text-[10px] text-muted-foreground mt-1">
                    {t.questions.length} soal
                    {t.settings.timeLimitMin ? ` · ${t.settings.timeLimitMin} menit` : ""}
                    {t.settings.maxAttempts && t.settings.maxAttempts > 1
                      ? ` · ${t.settings.maxAttempts} percobaan`
                      : ""}
                  </p>
                </div>
              </button>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function SettingSwitch({
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label
      className={cn(
        "flex items-start gap-3 rounded-lg border border-border p-3 cursor-pointer hover:bg-accent/30 transition-colors",
        disabled && "opacity-60 pointer-events-none"
      )}
    >
      <Switch checked={checked} onCheckedChange={onChange} className="mt-0.5" />
      <div className="min-w-0">
        <p className="text-sm font-medium leading-tight">{label}</p>
        <p className="text-xs text-muted-foreground mt-0.5">{hint}</p>
      </div>
    </label>
  );
}
