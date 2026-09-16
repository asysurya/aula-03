// Client-safe shared types & helpers for the Form Tugas (anti-nyontek) feature.

export type FormQuestionType =
  | "PG" // Pilihan Ganda (single)
  | "MULTI_PG" // Pilihan Ganda (multi jawaban)
  | "ESSAY" // Esai panjang
  | "SHORT" // Jawaban singkat / isian
  | "FILE" // Upload file
  | "IMAGE"; // Upload gambar/foto jawaban

export const FORM_QUESTION_TYPES: {
  value: FormQuestionType;
  label: string;
  hint: string;
  hasOptions: boolean;
  isUpload: boolean;
  isText: boolean;
  autoGradable: boolean;
}[] = [
  {
    value: "PG",
    label: "Pilihan Ganda",
    hint: "Satu jawaban benar — dinilai otomatis",
    hasOptions: true,
    isUpload: false,
    isText: false,
    autoGradable: true,
  },
  {
    value: "MULTI_PG",
    label: "PG Multi Jawaban",
    hint: "Beberapa jawaban benar — dinilai otomatis",
    hasOptions: true,
    isUpload: false,
    isText: false,
    autoGradable: true,
  },
  {
    value: "SHORT",
    label: "Isian Singkat",
    hint: "Jawaban teks pendek — otomatis bila kunci diisi, manual bila kosong",
    hasOptions: false,
    isUpload: false,
    isText: true,
    autoGradable: false,
  },
  {
    value: "ESSAY",
    label: "Esai",
    hint: "Jawaban panjang — dinilai manual",
    hasOptions: false,
    isUpload: false,
    isText: true,
    autoGradable: false,
  },
  {
    value: "FILE",
    label: "Upload File",
    hint: "Unggah dokumen/file — dinilai manual",
    hasOptions: false,
    isUpload: true,
    isText: false,
    autoGradable: false,
  },
  {
    value: "IMAGE",
    label: "Upload Gambar",
    hint: "Unggah foto jawaban (tulis di kertas) — dinilai manual",
    hasOptions: false,
    isUpload: true,
    isText: false,
    autoGradable: false,
  },
];

export function questionTypeMeta(t: string) {
  return (
    FORM_QUESTION_TYPES.find((q) => q.value === t) ?? FORM_QUESTION_TYPES[0]
  );
}

// ── Wire types ────────────────────────────────────────────────────

export interface FormOption {
  id: string;
  label: string;
}

export interface FormQuestionDTO {
  id: string;
  type: FormQuestionType;
  text: string;
  points: number;
  required: boolean;
  order: number;
  options: FormOption[];
  correct: string[] | null; // only present for teachers / after submit+showResult. SHORT: kunci isian (bukan id opsi)
  /** MULTI_PG: nilai parsial per jawaban benar (null = semua-atau-tidak). */
  partialScoring?: boolean | null;
  /** % poin dikurangi untuk jawaban SALAH (0-100; null/0 = tanpa penalti).
   *  Hanya untuk soal yang dinilai otomatis: PG, MULTI_PG, SHORT berkunci. */
  penaltyPercent?: number | null;
  imageFile: {
    id: string;
    name: string;
    storageKey: string;
    mimetype: string;
  } | null;
}

export interface FormSettings {
  shuffleQuestions: boolean;
  shuffleOptions: boolean;
  oneByOne: boolean;
  preventPaste: boolean;
  trackTabSwitch: boolean;
  timeLimitMin: number | null;
  showResult: boolean;
  /** Tampilkan KUNCI JAWABAN + pembahasan ke siswa setelah submit
   *  (independen dari showResult). Null (form lama) = mengikuti showResult
   *  — kompatibilitas penuh dengan behavior sebelum field ini ada. */
  showAnswerKey?: boolean | null;
  /** Izinkan siswa kembali ke soal sebelumnya (mode satu-soal-per-layar). */
  allowBack?: boolean;
  /** Jumlah percobaan pengerjaan yang diizinkan (1–10; null/undefined = 1). */
  maxAttempts?: number | null;
  /** Rekam pengerjaan siswa: snapshot area kerja dikirim berkala saat
   *  siswa mengerjakan → guru memantau LIVE; setelah submit rekaman
   *  tersimpan & bisa diputar ulang. Null (form lama) = false. */
  recordWork?: boolean | null;
}

export interface FormViolation {
  type: "TAB_SWITCH" | "PASTE" | "TIMEOUT" | "EXIT";
  at: string;
  detail?: string;
}

// ── Rekaman pengerjaan (toggle guru Form.recordWork) ───────────────

/** Satu rekaman pengerjaan satu siswa (LIVE = masih dikerjakan,
 *  SAVED = sudah selesai & tersimpan untuk diputar ulang). */
export interface FormRecordingDTO {
  id: string;
  status: "LIVE" | "SAVED";
  startedAt: string;
  finishedAt: string | null;
  frameCount: number;
  lastSeq: number;
  lastFrameAt: string | null;
  /** Status wajah frame terakhir (kamera PiP rekaman); null = tanpa
   *  info (kamera belum settle saat frame dikirim). */
  faceOk?: boolean | null;
  camOff?: boolean | null;
  /** Hanya diisi pada response untuk guru (daftar rekaman). */
  user?: { id: string; name: string; username: string };
}

/** Satu frame snapshot rekaman (HTML area kerja siswa). */
export interface FormRecordingFrameDTO {
  seq: number;
  html: string;
  capturedAt: string;
}

export interface FormAnswerDTO {
  questionId: string;
  text: string | null;
  optionIds: string[] | null;
  fileId: string | null;
  file: {
    id: string;
    name: string;
    size: number;
    mimetype: string;
    storageKey: string;
  } | null;
  score: number | null;
}

export interface FormAttemptDTO {
  id: string;
  status: "IN_PROGRESS" | "SUBMITTED";
  startedAt: string;
  submittedAt: string | null;
  score: number | null;
  maxScore: number;
  violations: FormViolation[];
  answers: FormAnswerDTO[];
}

export interface FormGetResponse {
  role: "TEACHER" | "STUDENT";
  hasForm: boolean;
  form: (FormSettings & { id: string; questions: FormQuestionDTO[] }) | null;
  attempt: FormAttemptDTO | null;
  canStart: boolean;
  deadlinePassed: boolean;
  questionOrder: string[];
  /** Berapa kali siswa ini sudah memakai percobaan (attempt aktif + arsip). */
  attemptsUsed?: number;
  /** Siswa masih boleh mengulang pengerjaan (percobaan tersisa). */
  canRetry?: boolean;
}

export interface FormSubmitResult {
  score: number | null;
  maxScore: number;
  showResult: boolean;
  /** Apakah kunci jawaban + pembahasan boleh ditampilkan ke siswa
   *  setelah submit (null di DB = ikut showResult). */
  showAnswerKey?: boolean;
  results:
    | {
        questionId: string;
        auto: boolean;
        correct: boolean | null;
        correctOptionIds: string[] | null;
        earned: number | null;
      }[]
    | null;
}

// ── Pengaturan penilaian ───────────────────────────────────────────

/** Pilihan penalti (persentase poin soal yang dikurangi bila salah). */
export const PENALTY_OPTIONS: { value: number; label: string }[] = [
  { value: 0, label: "Tanpa penalti" },
  { value: 10, label: "Salah −10% poin" },
  { value: 25, label: "Salah −25% poin" },
  { value: 33, label: "Salah −33% poin" },
  { value: 50, label: "Salah −50% poin" },
  { value: 100, label: "Salah −100% poin" },
];

/** Normalisasi teks jawaban isian: trim, lowercase, spasi beruntun jadi 1,
 *  tanpa tanda baca di tepi — supaya "Jakarta " == "jakarta". */
export function normalizeShortAnswer(s: string): string {
  return s
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/^[\s.,;:!?'"]+|[\s.,;:!?'"]+$/g, "")
    .trim();
}

// ── Violation labels ──────────────────────────────────────────────

export function violationLabel(v: FormViolation): string {
  switch (v.type) {
    case "TAB_SWITCH":
      return "Pindah tab/jendela";
    case "PASTE":
      return "Menempel (paste) teks";
    case "TIMEOUT":
      return "Waktu habis";
    case "EXIT":
      return "Keluar dari halaman";
    default:
      return v.type;
  }
}

// ── Local helpers ─────────────────────────────────────────────────

export function makeOptionId(): string {
  return `o${Math.random().toString(36).slice(2, 9)}`;
}

export function makeQuestionId(): string {
  return `q_local_${Math.random().toString(36).slice(2, 11)}`;
}
