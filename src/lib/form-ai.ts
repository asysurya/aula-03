// ─────────────────────────────────────────────────────────────────────────
// Prompt builder bersama untuk fitur "AI buat soal".
// Client-safe (tanpa dependency React/server) — dipakai:
// - src/app/api/forms/ai-generate (server, AI internal aula)
// - dialog builder mode "Lewat AI lain" (prompt disalin guru ke
//   ChatGPT/Gemini/Claude/dll, balasannya ditempel kembali).
// ─────────────────────────────────────────────────────────────────────────

export const AI_TYPE_LABELS: Record<string, string> = {
  PG: "Pilihan Ganda (satu jawaban benar)",
  MULTI_PG: "Pilihan Ganda multi-jawaban",
  SHORT: "Isian singkat",
  ESSAY: "Esai",
  FILE: "Upload file",
  IMAGE: "Upload gambar/foto",
};

function typeListText(types: string[]): string {
  return types.map((t) => `- ${t} (${AI_TYPE_LABELS[t] ?? t})`).join("\n");
}

const FORMAT_SPEC = `{
  "kind": "aula-form",
  "version": 1,
  "questions": [
    {
      "type": "PG",
      "text": "Teks pertanyaan yang jelas dan spesifik",
      "points": 1,
      "required": true,
      "options": [
        { "label": "Opsi jawaban benar", "correct": true },
        { "label": "Pengecoh yang masuk akal" },
        { "label": "Pengecoh lain" },
        { "label": "Pengecoh lagi" }
      ]
    }
  ]
}`;

const RULES = `Aturan penting:
- Soal PG: 4-5 opsi, TEPAT SATU opsi dengan "correct": true.
- Soal MULTI_PG: 4-6 opsi, 2-4 opsi dengan "correct": true.
- SHORT/ESSAY: TANPA field "options".
- FILE/IMAGE: gunakan untuk soal unggah jawaban; instruksikan format di teks soal; TANPA "options".
- Bahasa Indonesia yang baik dan benar, sesuaikan jenjang dari prompt pengguna.
- "text" maksimal 300 karakter. Jangan membocorkan jawaban di teks soal.
- Urutan soal dari mudah ke sulit.
- Jangan ulang soal yang sama persis.`;

/** System prompt untuk AI internal aula (endpoint /api/forms/ai-generate). */
export function buildAiSystemPrompt(count: number, types: string[]): string {
  return `Kamu adalah generator soal ujian berkualitas untuk guru Indonesia.

Tugas: buat ${count} soal berdasarkan permintaan pengguna, HANYA memakai jenis soal berikut:
${typeListText(types)}

Balas HANYA dengan satu objek JSON valid (tanpa teks lain, tanpa code fence) dengan struktur PERSIS:
${FORMAT_SPEC}

${RULES}`;
}

/**
 * Prompt MANDIRI untuk AI eksternal (ChatGPT / Gemini / Claude / dll).
 * Guru menyalin teks ini ke AI mana pun, lalu menempel balasannya kembali
 * ke aula — parser JSON aula toleran terhadap teks non-JSON di sekitarnya.
 */
export function buildExternalPrompt(
  userPrompt: string,
  count: number,
  types: string[]
): string {
  return `Kamu adalah generator soal ujian berkualitas untuk guru Indonesia.

Tugas: buat ${count} soal berdasarkan PERMINTAAN GURU di bagian paling bawah, HANYA memakai jenis soal berikut:
${typeListText(types)}

Balas HANYA dengan satu objek JSON valid — tanpa kalimat pengantar, tanpa penutup, tanpa code fence — dengan struktur PERSIS:
${FORMAT_SPEC}

${RULES}

Catatan format tambahan:
- Field "options" hanya untuk PG dan MULTI_PG.
- Untuk SHORT, ESSAY, FILE, dan IMAGE cukup: {"type", "text", "points", "required"}.

PERMINTAAN GURU:
${userPrompt}`;
}
