// ─────────────────────────────────────────────────────────────────────
// Enkripsi secret at-rest (API key Teman AI) — AES-256-GCM.
//
// Kunci enkripsi diderivasi dari NEXTAUTH_SECRET lewat SHA-256 (32 byte).
// Format tersimpan: "v1:<ivBase64>:<tagBase64>:<cipherBase64>".
// Versi "v1" memudahkan rotasi format di masa depan.
// Server-only (node:crypto) — JANGAN import dari komponen client.
// ─────────────────────────────────────────────────────────────────────

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";

function deriveKey(): Buffer {
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret || secret.length === 0) {
    throw new Error(
      "NEXTAUTH_SECRET belum diatur — enkripsi API key Teman AI butuh secret ini. Set NEXTAUTH_SECRET di environment server."
    );
  }
  return createHash("sha256").update(secret).digest();
}

/** Enkripsi secret plaintext → string "v1:iv:tag:cipher" (semua base64). */
export function encryptSecret(plain: string): string {
  const key = deriveKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    "v1",
    iv.toString("base64"),
    tag.toString("base64"),
    enc.toString("base64"),
  ].join(":");
}

/**
 * Dekripsi string "v1:iv:tag:cipher" → plaintext.
 * Return null bila format salah / tag tidak cocok (secret berubah) / rusak —
 * pemanggil tinggal memperlakukan kunci sebagai tidak ada.
 */
export function decryptSecret(enc: string | null | undefined): string | null {
  if (!enc) return null;
  try {
    const parts = enc.split(":");
    if (parts.length !== 4 || parts[0] !== "v1") return null;
    const iv = Buffer.from(parts[1], "base64");
    const tag = Buffer.from(parts[2], "base64");
    const data = Buffer.from(parts[3], "base64");
    if (iv.length === 0 || tag.length === 0 || data.length === 0) return null;
    const decipher = createDecipheriv("aes-256-gcm", deriveKey(), iv);
    decipher.setAuthTag(tag);
    const out = Buffer.concat([decipher.update(data), decipher.final()]);
    return out.toString("utf8");
  } catch {
    return null;
  }
}
