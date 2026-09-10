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
 * Scanner blok JSON seimbang ({...} / [...]) pada teks bebas.
 * Sadar string + karakter escape — kurung di dalam string tidak dihitung —
 * sehingga mampu mengekstrak JSON utuh walau diselingi kalimat pengantar AI,
 * pembungkus ```json, atau teks lain di sekitarnya.
 * Mengembalikan kandidat diurutkan dari yang terpanjang duluan.
 */
export function extractJsonCandidates(text: string): string[] {
  const n = text.length;
  const out: string[] = [];
  let i = 0;
  while (i < n) {
    const ch = text[i];
    if (ch === '"' || ch === "'") {
      // Lewati string — kutip tunggal bukan JSON valid, tapi tetap dilewati
      // supaya apostrof di kalimat ("don't") tidak menggeser posisi kurung.
      const quote = ch;
      i++;
      while (i < n && text[i] !== quote) {
        if (text[i] === "\\") i++;
        i++;
      }
      i++;
      continue;
    }
    if (ch === "{" || ch === "[") {
      const open = ch;
      const close = open === "{" ? "}" : "]";
      let depth = 0;
      let j = i;
      let closed = false;
      while (j < n) {
        const cj = text[j];
        if (cj === '"') {
          j++;
          while (j < n && text[j] !== '"') {
            if (text[j] === "\\") j++;
            j++;
          }
          j++;
          continue;
        }
        if (cj === open) depth++;
        else if (cj === close) {
          depth--;
          if (depth === 0) {
            j++;
            closed = true;
            break;
          }
        }
        j++;
      }
      if (closed) {
        out.push(text.slice(i, j));
        i = j;
      } else {
        i++;
      }
      continue;
    }
    i++;
  }
  out.sort((a, b) => b.length - a.length);
  return out;
}

/**
 * Parse + validasi teks JSON form — TOLERAN terhadap teks di luar JSON.
 * Kalimat pengantar/jawaban AI non-JSON, code fence ```json … ```, sapaan
 * penutup, dsb. otomatis dibuang: cukup ada SATU blok JSON valid di mana
 * pun dalam teks (mis. hasil copy-paste dari ChatGPT/Gemini).
 * Melempar Error dengan pesan Bahasa Indonesia yang menunjuk soal ke-(n)
 * yang bermasalah — cocok untuk toast.
 */
export function parseFormJson(text: string): FormIOParsed {
  const raw = text.trim();
  if (!raw) throw new Error("Teks JSON kosong");

  // Kandidat: teks utuh dulu, lalu blok JSON yang tertanam di dalamnya.
  const candidates = [raw, ...extractJsonCandidates(raw)];

  let validationError: Error | null = null;
  let sawJson = false;

  for (const cand of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(cand);
    } catch {
      continue; // bukan JSON — coba kandidat berikutnya
    }
    sawJson = true;

    let data: Record<string, unknown> | null = null;
    if (Array.isArray(parsed)) {
      // Bentuk singkat: array soal langsung.
      data = { questions: parsed };
    } else if (parsed && typeof parsed === "object") {
      data = parsed as Record<string, unknown>;
    }
    if (!data) continue;

    try {
      return validateFormObject(data);
    } catch (e) {
      if (!validationError)
        validationError = e instanceof Error ? e : new Error(String(e));
      // Kandidat JSON lain mungkin lebih tepat — lanjut ke berikutnya.
    }
  }

  if (validationError) throw validationError;
  if (sawJson) throw new Error('Tidak ada soal — sertakan array "questions"');
  throw new Error(
    "JSON tidak valid — teks non-JSON di sekitar sudah diabaikan otomatis; periksa tanda kurung dan tanda kutip"
  );
}

function validateFormObject(data: Record<string, unknown>): FormIOParsed {
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
