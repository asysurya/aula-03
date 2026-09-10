"use client";

// Template tugas siap pakai — struktur soal + pengaturan anti-nyontek yang
// sudah terisi, tinggal disesuaikan gurunya (teks soal placeholder).

import type { FormIOParsedQuestion } from "@/lib/form-types";
import type { FormSettings } from "@/lib/form-types";

export interface FormTemplate {
  key: string;
  name: string;
  description: string;
  emoji: string;
  settings: Partial<FormSettings>;
  questions: FormIOParsedQuestion[];
}

function opt(label: string) {
  return { id: `o${Math.random().toString(36).slice(2, 9)}`, label };
}

export const FORM_TEMPLATES: FormTemplate[] = [
  {
    key: "kuis-pg",
    name: "Kuis Pilihan Ganda",
    description: "5 soal PG standar + anti-nyontek ketat, 10 menit.",
    emoji: "📝",
    settings: {
      shuffleQuestions: true,
      shuffleOptions: true,
      oneByOne: true,
      preventPaste: true,
      trackTabSwitch: true,
      timeLimitMin: 10,
      showResult: true,
      allowBack: false,
      maxAttempts: 1,
    },
    questions: [
      {
        type: "PG",
        text: "(Soal 1) Tulis pertanyaan di sini…",
        points: 2,
        required: true,
        options: [opt("Opsi A"), opt("Opsi B"), opt("Opsi C"), opt("Opsi D")],
        correct: [],
      },
      {
        type: "PG",
        text: "(Soal 2) Tulis pertanyaan di sini…",
        points: 2,
        required: true,
        options: [opt("Opsi A"), opt("Opsi B"), opt("Opsi C"), opt("Opsi D")],
        correct: [],
      },
      {
        type: "PG",
        text: "(Soal 3) Tulis pertanyaan di sini…",
        points: 2,
        required: true,
        options: [opt("Opsi A"), opt("Opsi B"), opt("Opsi C"), opt("Opsi D")],
        correct: [],
      },
      {
        type: "PG",
        text: "(Soal 4) Tulis pertanyaan di sini…",
        points: 2,
        required: true,
        options: [opt("Opsi A"), opt("Opsi B"), opt("Opsi C"), opt("Opsi D")],
        correct: [],
      },
      {
        type: "PG",
        text: "(Soal 5) Tulis pertanyaan di sini…",
        points: 2,
        required: true,
        options: [opt("Opsi A"), opt("Opsi B"), opt("Opsi C"), opt("Opsi D")],
        correct: [],
      },
    ],
  },
  {
    key: "ulangan-harian",
    name: "Ulangan Harian Campuran",
    description: "PG + isian + esai, 30 menit, boleh balik soal.",
    emoji: "🎓",
    settings: {
      shuffleQuestions: true,
      shuffleOptions: true,
      oneByOne: true,
      preventPaste: true,
      trackTabSwitch: true,
      timeLimitMin: 30,
      showResult: true,
      allowBack: true,
      maxAttempts: 1,
    },
    questions: [
      {
        type: "PG",
        text: "(Soal 1 · PG) Tulis pertanyaan…",
        points: 2,
        required: true,
        options: [opt("Opsi A"), opt("Opsi B"), opt("Opsi C"), opt("Opsi D")],
        correct: [],
      },
      {
        type: "PG",
        text: "(Soal 2 · PG) Tulis pertanyaan…",
        points: 2,
        required: true,
        options: [opt("Opsi A"), opt("Opsi B"), opt("Opsi C"), opt("Opsi D")],
        correct: [],
      },
      {
        type: "MULTI_PG",
        text: "(Soal 3 · PG multi) Pilih semua jawaban yang benar…",
        points: 3,
        required: true,
        options: [opt("Opsi A"), opt("Opsi B"), opt("Opsi C"), opt("Opsi D")],
        correct: [],
      },
      {
        type: "SHORT",
        text: "(Soal 4 · Isian) Jawab singkat…",
        points: 3,
        required: true,
        options: [],
        correct: [],
      },
      {
        type: "ESSAY",
        text: "(Soal 5 · Esai) Uraikan jawabanmu…",
        points: 10,
        required: true,
        options: [],
        correct: [],
      },
    ],
  },
  {
    key: "latihan-esai",
    name: "Latihan Esai",
    description: "3 soal esai reflektif, tanpa timer, dinilai manual.",
    emoji: "✍️",
    settings: {
      shuffleQuestions: false,
      shuffleOptions: false,
      oneByOne: false,
      preventPaste: false,
      trackTabSwitch: false,
      timeLimitMin: null,
      showResult: false,
      allowBack: true,
      maxAttempts: 1,
    },
    questions: [
      {
        type: "ESSAY",
        text: "(Soal 1) Jelaskan pengertian…",
        points: 10,
        required: true,
        options: [],
        correct: [],
      },
      {
        type: "ESSAY",
        text: "(Soal 2) Bandingkan dan berikan contoh…",
        points: 10,
        required: true,
        options: [],
        correct: [],
      },
      {
        type: "ESSAY",
        text: "(Soal 3) Tulis kesimpulanmu…",
        points: 10,
        required: true,
        options: [],
        correct: [],
      },
    ],
  },
  {
    key: "kuis-kilat-ketat",
    name: "Kuis Kilat Anti-nyontek",
    description: "10 soal PG, 15 menit, pengawasan maksimal, 2 percobaan.",
    emoji: "⚡",
    settings: {
      shuffleQuestions: true,
      shuffleOptions: true,
      oneByOne: true,
      preventPaste: true,
      trackTabSwitch: true,
      timeLimitMin: 15,
      showResult: true,
      allowBack: false,
      maxAttempts: 2,
    },
    questions: Array.from({ length: 10 }, (_, i) => ({
      type: "PG" as const,
      text: `(Soal ${i + 1}) Pertanyaan cepat…`,
      points: 1,
      required: true,
      options: [opt("A"), opt("B"), opt("C"), opt("D")],
      correct: [],
    })),
  },
  {
    key: "tugas-praktik",
    name: "Tugas Praktik (Upload)",
    description: "Instruksi + upload file/foto hasil kerja siswa.",
    emoji: "📁",
    settings: {
      shuffleQuestions: false,
      shuffleOptions: false,
      oneByOne: false,
      preventPaste: false,
      trackTabSwitch: true,
      timeLimitMin: null,
      showResult: false,
      allowBack: true,
      maxAttempts: 1,
    },
    questions: [
      {
        type: "ESSAY",
        text: "Baca instruksi praktik di lampiran folder, lalu ringkaskan langkah-langkah yang kamu lakukan.",
        points: 10,
        required: true,
        options: [],
        correct: [],
      },
      {
        type: "IMAGE",
        text: "Unggah FOTO hasil kerjamu (tulis di kertas lalu foto).",
        points: 20,
        required: true,
        options: [],
        correct: [],
      },
      {
        type: "FILE",
        text: "Unggah file dokumen pendukung (jika ada).",
        points: 10,
        required: false,
        options: [],
        correct: [],
      },
    ],
  },
  {
    key: "angket",
    name: "Angket / Survei",
    description: "Tanpa kunci & tanpa anti-nyontek — untuk opini/refleksi.",
    emoji: "📊",
    settings: {
      shuffleQuestions: false,
      shuffleOptions: false,
      oneByOne: false,
      preventPaste: false,
      trackTabSwitch: false,
      timeLimitMin: null,
      showResult: false,
      allowBack: true,
      maxAttempts: 1,
    },
    questions: [
      {
        type: "PG",
        text: "Bagaimana pengalamanmu belajar minggu ini?",
        points: 1,
        required: true,
        options: [opt("Sangat menyenangkan"), opt("Cukup"), opt("Kurang"), opt("Belum bisa menilai")],
        correct: [],
      },
      {
        type: "MULTI_PG",
        text: "Materi mana yang paling menantang? (pilih beberapa)",
        points: 1,
        required: false,
        options: [opt("Materi A"), opt("Materi B"), opt("Materi C"), opt("Materi D")],
        correct: [],
      },
      {
        type: "ESSAY",
        text: "Saran untuk perbaikan kelas:",
        points: 1,
        required: false,
        options: [],
        correct: [],
      },
    ],
  },
];
