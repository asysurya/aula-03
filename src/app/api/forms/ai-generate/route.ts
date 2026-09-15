import { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import { errorResponse } from "@/lib/cloud-utils";
import { db } from "@/lib/db";
import { decryptSecret } from "@/lib/crypto";
import {
  chatEndpoint,
  providerErrorMessage,
  resolveAiConfig,
  type AiSettingInput,
} from "@/lib/ai-providers";
import { parseFormJson, type FormIOParsedQuestion } from "@/lib/form-io";
import { AI_TYPE_LABELS, buildAiSystemPrompt } from "@/lib/form-ai";

// POST /api/forms/ai-generate
// body: { prompt: string, count?: number (1-40), types?: string[] }
//
// Guru menulis prompt bebas ("10 soal PG tentang fotosintesis untuk SMP
// kelas 8, sulit") → AI membuat DRAF soal dalam format form JSON yang
// divalidasi ketat oleh parseFormJson sebelum dikirim ke client.
// Draf tetap harus direview guru di builder sebelum disimpan.
//
// PROVIDER: default admin "ai.builder" (Admin Panel → tab AI Builder) —
// SAMA dengan AI Builder Pusat Belajar, dipisah dari Teman AI. Bila admin
// belum mengaturnya, guru mendapat pesan yang jelas (bukan AI internal).
export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_PROMPT = 2000;
const MAX_COUNT = 40;

export async function POST(req: NextRequest) {
  const user = await requireUser().catch(() => null);
  if (!user) return errorResponse("UNAUTHORIZED", 401);
  // Fitur guru: siswa tidak boleh memanggil generator ini (membakar kuota
  // provider & bisa memperoleh kunci jawaban draf).
  if (user.role === "STUDENT") return errorResponse("FORBIDDEN", 403);

  const body = await req.json().catch(() => null);
  const prompt = body?.prompt == null ? "" : String(body.prompt).trim();
  if (!prompt) return errorResponse("PROMPT_REQUIRED", 400);
  if (prompt.length > MAX_PROMPT)
    return errorResponse(`PROMPT_TOO_LONG (maks ${MAX_PROMPT} karakter)`, 400);

  const count = Math.min(
    MAX_COUNT,
    Math.max(1, Number(body?.count) || 10)
  );

  const requestedTypes = Array.isArray(body?.types)
    ? (body.types as unknown[]).map(String).filter((t) => AI_TYPE_LABELS[t])
    : [];
  const types = requestedTypes.length > 0 ? requestedTypes : ["PG"];

  // ── Config aktif: HANYA default admin "ai.builder" (sama seperti AI
  //    Builder Pusat Belajar — dipisah dari Teman AI, tanpa BYOK guru). ──
  const adminRow = await db.appSetting.findUnique({ where: { key: "ai.builder" } });
  let adminDefault: AiSettingInput | null = null;
  if (adminRow) {
    try {
      const raw = JSON.parse(adminRow.value) as {
        provider?: string;
        baseUrl?: string | null;
        apiKeyEnc?: string | null;
        model?: string | null;
      };
      adminDefault = {
        provider: raw.provider ?? "",
        baseUrl: raw.baseUrl ?? null,
        apiKey: decryptSecret(raw.apiKeyEnc ?? null),
        model: raw.model ?? null,
      };
    } catch {
      adminDefault = null;
    }
  }

  const config = resolveAiConfig(null, adminDefault);
  if (!config) {
    return errorResponse(
      "AI_BUILDER_NOT_SET — admin belum mengatur AI Builder. " +
        "Hubungi admin: Admin Panel → AI Builder (provider yang sama dipakai " +
        "untuk membuat soal tugas).",
      400
    );
  }

  try {
    // Panggil provider (kompatibel OpenAI chat completions — non-stream).
    const upstream = await fetch(chatEndpoint(config.baseUrl), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: config.model,
        messages: [
          // System prompt HARUS role "system" (bukan "assistant") supaya
          // instruksi format ditaati model secara konsisten.
          { role: "system", content: buildAiSystemPrompt(count, types) },
          { role: "user", content: prompt },
        ],
        stream: false,
        max_tokens: 8000,
      }),
    });

    if (!upstream.ok) {
      let detail: string | null = null;
      try {
        const errJson = (await upstream.json().catch(() => null)) as {
          error?: { metadata?: { raw?: string }; message?: string };
          message?: string;
        } | null;
        detail =
          errJson?.error?.metadata?.raw ??
          errJson?.error?.message ??
          errJson?.message ??
          null;
        if (typeof detail !== "string") detail = null;
      } catch {
        /* abaikan */
      }
      return errorResponse(providerErrorMessage(upstream.status, detail), 502);
    }

    const json = (await upstream.json().catch(() => null)) as {
      choices?: { message?: { content?: string } }[];
    } | null;
    const raw = json?.choices?.[0]?.message?.content ?? "";
    if (!raw.trim()) return errorResponse("AI_EMPTY_RESPONSE", 502);

    // Validasi ketat dengan parser yang sama dengan import JSON —
    // format AI yang tidak valid ditolak dengan pesan yang bisa ditindaklanjuti.
    let parsed;
    try {
      parsed = parseFormJson(raw);
    } catch (e) {
      return errorResponse(
        `AI menghasilkan format tidak valid (${
          e instanceof Error ? e.message : "parse gagal"
        }). Coba lagi atau sederhanakan prompt.`,
        502
      );
    }

    const questions: FormIOParsedQuestion[] = parsed.questions.slice(0, count);
    if (questions.length === 0)
      return errorResponse("AI_EMPTY_RESPONSE", 502);

    return Response.json({
      questions: questions.map((q) => ({
        type: q.type,
        text: q.text,
        points: q.points,
        required: q.required,
        options: q.options.map((o) => ({ id: o.id, label: o.label })),
        correct: q.correct,
      })),
      generatedCount: questions.length,
    });
  } catch {
    return errorResponse("AI_GENERATE_FAILED — coba lagi sebentar", 502);
  }
}
