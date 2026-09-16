import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  // pdfjs-dist (legacy build) dipakai SERVER-SIDE untuk ekstraksi teks
  // lampiran materi AI — harus dijalankan dari node_modules asli, bukan
  // dibundel webpack (worker/fs dinamis pecah saat dibundle).
  serverExternalPackages: ["pdfjs-dist"],
};

export default nextConfig;
