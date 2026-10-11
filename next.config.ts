import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  // pdfjs-dist (legacy build) dipakai SERVER-SIDE untuk ekstraksi teks
  // lampiran materi AI — harus dijalankan dari node_modules asli, bukan
  // dibundel webpack (worker/fs dinamis pecah saat dibundle).
  // @napi-rs/canvas: binding native .node (render halaman PDF → JPEG
  // untuk OCR vision) — tidak bisa dibundel ke chunk ESM.
  // tar: ekstraksi arsip Piper TTS — pakai require runtime agar dinamis
  // internalnya (minizlib dkk.) tidak pecah saat dibundel.
  serverExternalPackages: ["pdfjs-dist", "@napi-rs/canvas", "tar"],
};

export default nextConfig;
