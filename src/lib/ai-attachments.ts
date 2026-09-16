// ── Resolusi lampiran materi → blok konteks untuk request AI ──────────
// Dipakai endpoint AI (chat, study, builder, ai-generate): daftar id
// AiAttachment milik user + materi teks manual digabung menjadi satu
// blok "MATERI LAMPIRAN" untuk disisipkan ke prompt. Id milik user lain
// diabaikan diam-diam (ownership check di query).

import { db } from "@/lib/db";

/** Batas total karakter konteks lampiran (semua sumber digabung). */
export const ATTACH_CONTEXT_LIMIT = 60_000;
/** Maks berkas per request AI. */
export const MAX_ATTACHMENTS_PER_REQUEST = 8;

/**
 * Bangun blok konteks lampiran. Mengembalikan null bila tidak ada
 * materi (teks kosong & tidak ada lampiran valid) — pemanggil boleh
 * melewati penambahan prompt.
 */
export async function resolveAttachmentContext(
  userId: string,
  ids: string[],
  extraText?: string | null,
  limit: number = ATTACH_CONTEXT_LIMIT
): Promise<string | null> {
  const cleanIds = (ids ?? [])
    .filter((x) => typeof x === "string" && x.length > 0)
    .slice(0, MAX_ATTACHMENTS_PER_REQUEST);
  const text = (extraText ?? "").trim();

  let rows: { name: string; kind: string; text: string; chars: number }[] = [];
  if (cleanIds.length) {
    const found = await db.aiAttachment.findMany({
      where: { id: { in: cleanIds }, userId },
      select: { id: true, name: true, kind: true, text: true, chars: true },
    });
    // pertahankan urutan yang dikirim user; id milik user lain diabaikan.
    const byId = new Map(found.map((r) => [r.id, r]));
    rows = cleanIds
      .map((id) => byId.get(id))
      .filter((r): r is { name: string; kind: string; text: string; chars: number } => !!r);
  }

  if (!rows.length && !text) return null;

  const parts: string[] = ["=== MATERI LAMPIRAN ==="];
  if (text) parts.push(`[Materi teks]\n${text}`);
  for (const r of rows) {
    parts.push(
      `--- Berkas: ${r.name} (${r.kind}${r.chars ? `, ${r.chars} karakter` : ""}) ---\n${r.text}`
    );
  }
  let out = parts.join("\n\n");
  if (out.length > limit) {
    out = out.slice(0, limit) + "\n…[materi dipotong — terlalu panjang]";
  }
  return out;
}
