// ─────────────────────────────────────────────────────────────────────────
// Form JSON I/O — format bersama untuk EXPORT / IMPORT / AI generator soal.
// Client-safe (tanpa dependency React/server).
//
// Format:
// {
//   "kind": "aula-form",
//   "version": 1,
//   "settings": { ...opsi anti-nyontek (semua opsional) },
//   "questions": [
//     {
//       "type": "PG" | "MULTI_PG" | "SHORT" | "ESSAY" | "FILE" | "IMAGE",
//       "text": "Pertanyaan…",
//       "points": 1,
//       "required": true,
//       "options": [ { "label": "Jawaban A", "correct": true },
//                    { "label": "Jawaban B" } ]
//     }
//   ]
// }
//
// Catatan opsi:
// - Untuk kenyamanan penulisan manual & AI, opsi memakai marker "correct": true.
// - Format { "id", "label" } + "correct": ["id", …] (output builder) juga
//   DITERIMA parser — keduanya dinormalisasi.
// ─────────────────────────────────────────────────────────────────────────

import {
  FORM_QUESTION_TYPES,
  makeOptionId,
  type FormOption,
  type FormQuestionType,
  type FormSettings,
} from "./form-types";

export interface FormIOParsedQuestion {
  type: FormQuestionType;
  text: string;
  points: number;
  required: boolean;
  options: FormOption[];
  correct: string[];
}

export interface FormIOParsed {
  settings: Partial<FormSettings>;
  questions: FormIOParsedQuestion[];
}

const VALID_TYPES = new Set<string>(FORM_QUESTION_TYPES.map((t) => t.value));

const MAX_QUESTIONS = 100;
const MAX_TEXT = 2000;
const MAX_OPTIONS = 10;
const MIN_OPTIONS = 2;

function asBool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

function normalizeOption(
  o: unknown,
  idx: number
): { label: string; id: string; correct: boolean } | null {
  if (typeof o === "string") {
    // Bentuk singkat: "Jawaban" → opsi tanpa correct.
    const label = o.trim();
    if (!label) return null;
    return { label: label.slice(0, 500), id: makeOptionId(), correct: false };
  }
  if (!o || typeof o !== "object") return null;
  const obj = o as Record<string, unknown>;
  const label = String(obj.label ?? "").trim();
  if (!label) return null;
  const id =
    typeof obj.id === "string" && obj.id.length > 0 && obj.id.length <= 40
      ? obj.id
      : makeOptionId();
  return {
    label: label.slice(0, 500),
    id,
    correct: asBool(obj.correct, false),
  };
}

/**
 * Parse + validasi teks JSON form. Melempar Error dengan pesan Bahasa
 * Indonesia yang menunjuk soal ke-(n) yang bermasalah — cocok untuk toast.
 */
export function parseFormJson(text: string): FormIOParsed {
  let raw: string = text.trim();
  if (!raw) throw new Error("Teks JSON kosong");

  // Buang pembungkus code fence ```json … ``` (sering dipakai AI).
  const fence = raw.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence) raw = fence[1].trim();

  // Kalau masih ada teks di sekeliling JSON, coba ambil blok {...} terbesar.
  if (!raw.startsWith("{") && !raw.startsWith("[")) {
    const s = raw.indexOf("{");
    const e = raw.lastIndexOf("}");
    if (s >= 0 && e > s) raw = raw.slice(s, e + 1);
  }

  let data: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      // Bentuk singkat: array soal langsung.
      data = { questions: parsed };
    } else if (parsed && typeof parsed === "object") {
      data = parsed as Record<string, unknown>;
    } else {
      throw new Error("Bukan objek JSON");
    }
  } catch {
    throw new Error("JSON tidak valid — periksa tanda kurung dan tanda kutip");
  }

  const questionsRaw = Array.isArray(data.questions)
    ? (data.questions as unknown[])
    : [];
  if (questionsRaw.length === 0)
    throw new Error('Tidak ada soal — sertakan array "questions"');
  if (questionsRaw.length > MAX_QUESTIONS)
    throw new Error(`Maksimal ${MAX_QUESTIONS} soal per form`);

  const questions: FormIOParsedQuestion[] = [];
  for (let i = 0; i < questionsRaw.length; i++) {
    const qRaw = questionsRaw[i];
    if (!qRaw || typeof qRaw !== "object")
      throw new Error(`Soal #${i + 1}: bukan objek yang valid`);
    const q = qRaw as Record<string, unknown>;

    const type = String(q.type ?? "").toUpperCase().trim();
    if (!VALID_TYPES.has(type))
      throw new Error(
        `Soal #${i + 1}: jenis "${type || "(kosong)"}" tidak dikenal (gunakan PG, MULTI_PG, SHORT, ESSAY, FILE, atau IMAGE)`
      );

    const text = String(q.text ?? "").trim();
    if (!text) throw new Error(`Soal #${i + 1}: teks soal kosong`);
    if (text.length > MAX_TEXT)
      throw new Error(`Soal #${i + 1}: teks soal lebih dari ${MAX_TEXT} karakter`);

    const pointsRaw = q.points == null ? 1 : Number(q.points);
    if (!Number.isFinite(pointsRaw) || pointsRaw < 0 || pointsRaw > 1000)
      throw new Error(`Soal #${i + 1}: poin tidak valid (0–1000)`);
    const points = Math.round(pointsRaw);

    const required = asBool(q.required, true);

    let options: FormOption[] = [];
    let correct: string[] = [];

    if (type === "PG" || type === "MULTI_PG") {
      const optsRaw = Array.isArray(q.options) ? q.options : [];
      if (optsRaw.length < MIN_OPTIONS)
        throw new Error(`Soal #${i + 1}: minimal ${MIN_OPTIONS} opsi jawaban`);
      if (optsRaw.length > MAX_OPTIONS)
        throw new Error(`Soal #${i + 1}: maksimal ${MAX_OPTIONS} opsi jawaban`);
      const norm = optsRaw.map((o, j) => normalizeOption(o, j));
      if (norm.some((n) => !n))
        throw new Error(`Soal #${i + 1}: ada opsi dengan label kosong`);
      const clean = norm as { label: string; id: string; correct: boolean }[];
      options = clean.map((o) => ({ id: o.id, label: o.label }));
      correct = clean.filter((o) => o.correct).map((o) => o.id);

      // Dukung juga "correct": ["id",…] gaya builder.
      if (Array.isArray(q.correct)) {
        const byId = new Map(clean.map((o) => [o.id, o]));
        const listed = (q.correct as unknown[])
          .map((c) => String(c))
          .filter((c) => byId.has(c));
        if (listed.length > 0 && correct.length === 0) correct = listed;
      }

      if (type === "PG" && correct.length !== 1)
        throw new Error(`Soal #${i + 1}: PG harus punya tepat 1 jawaban benar`);
      if (type === "MULTI_PG" && correct.length < 1)
        throw new Error(
          `Soal #${i + 1}: PG multi-jawaban minimal 1 jawaban benar`
        );
    }

    questions.push({
      type: type as FormQuestionType,
      text,
      points,
      required,
      options,
      correct,
    });
  }

  // Settings opsional — whitelist, validasi ringan.
  const s = (data.settings ?? {}) as Record<string, unknown>;
  const settings: Partial<FormSettings> = {};
  if ("shuffleQuestions" in s) settings.shuffleQuestions = asBool(s.shuffleQuestions, true);
  if ("shuffleOptions" in s) settings.shuffleOptions = asBool(s.shuffleOptions, true);
  if ("oneByOne" in s) settings.oneByOne = asBool(s.oneByOne, true);
  if ("preventPaste" in s) settings.preventPaste = asBool(s.preventPaste, true);
  if ("trackTabSwitch" in s) settings.trackTabSwitch = asBool(s.trackTabSwitch, true);
  if ("showResult" in s) settings.showResult = asBool(s.showResult, true);
  if ("allowBack" in s) settings.allowBack = asBool(s.allowBack, false);
  if (s.timeLimitMin != null) {
    const t = Number(s.timeLimitMin);
    if (Number.isFinite(t) && t >= 1 && t <= 300) settings.timeLimitMin = Math.round(t);
  }

  return { settings, questions };
}

/** Serialisasi form → teks JSON (pretty, siap dibagikan/di-edit manual). */
export function exportFormJson(
  settings: FormSettings,
  questions: FormIOParsedQuestion[]
): string {
  return JSON.stringify(
    {
      kind: "aula-form",
      version: 1,
      settings: {
        shuffleQuestions: settings.shuffleQuestions,
        shuffleOptions: settings.shuffleOptions,
        oneByOne: settings.oneByOne,
        preventPaste: settings.preventPaste,
        trackTabSwitch: settings.trackTabSwitch,
        timeLimitMin: settings.timeLimitMin ?? null,
        showResult: settings.showResult,
        allowBack: settings.allowBack ?? false,
      },
      questions: questions.map((q) => ({
        type: q.type,
        text: q.text,
        points: q.points,
        required: q.required,
        options:
          q.type === "PG" || q.type === "MULTI_PG"
            ? q.options.map((o) => ({
                label: o.label,
                correct: q.correct.includes(o.id),
              }))
            : undefined,
      })),
    },
    null,
    2
  );
}
