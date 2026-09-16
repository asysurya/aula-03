// ── Kamera wajah untuk REKAM PENGERJAAN TUGAS (PiP) ──────────────────────
// Saat guru mengaktifkan "Rekam pengerjaan siswa", kamera depan siswa
// dinyalakan: wajahnya ditangkap sebagai JPEG kecil (± 6–12 KB) lalu
// disisipkan sebagai jendela PiP pada setiap frame rekaman — guru melihat
// layar + wajah siswa berdampingan, baik saat LIVE maupun putar ulang.
//
// "Harus mukanya keliatan kamera": tiap ± 2 dtk dilakukan deteksi wajah.
// Bila wajah TIDAK terlihat beberapa detik berturut-turut, siswa diberi
// NOTIFIKASI (banner + toast) agar kembali menghadap kamera, dan status
// "wajah tak terlihat / kamera mati" ikut terlihat oleh guru.
//
// Deteksi memakai dua lapis (best-effort, tanpa model besar):
//   1. Shape Detection API (window.FaceDetector) bila browser menyediakan
//      (Chrome/Edge dengan flag, sebagian smart TV Chromium).
//   2. Heuristik rasio piksel "warna kulit" YCbCr pada frame 64×48 —
//      tahan terhadap variasi pencahayaan; frame gelap total dianggap
//      kamera tertutup. Dijalankan bila API #1 tak tersedia / gagal.

/** Ukuran JPEG PiP yang disimpan dalam frame rekaman. */
export const FACE_W = 160;
export const FACE_H = 120;

export interface FaceFrameInfo {
  /** JPEG data-URL dari frame kamera terakhir (null bila kamera mati). */
  dataUrl: string | null;
  /** Wajah terlihat pada frame terakhir? */
  ok: boolean;
}

/**
 * Tangkap frame video kamera sebagai JPEG data-URL (untuk PiP rekaman).
 * Mengembalikan null bila video belum punya frame (belum play).
 */
export function grabFaceJpeg(
  video: HTMLVideoElement,
  w = FACE_W,
  h = FACE_H,
  quality = 0.55
): string | null {
  try {
    if (!video.videoWidth || !video.videoHeight) return null;
    const cv = document.createElement("canvas");
    cv.width = w;
    cv.height = h;
    const ctx = cv.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0, w, h);
    return cv.toDataURL("image/jpeg", quality);
  } catch {
    return null;
  }
}

/** Uji satu piksel RGB memenuhi rentang warna kulit YCbCr. */
function isSkinYCbCr(r: number, g: number, b: number): boolean {
  const y = 0.299 * r + 0.587 * g + 0.114 * b;
  const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
  const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
  // Terlalu gelap (=kamera tertutup/lampu mati) bukan "wajah terlihat".
  return y > 40 && cb >= 77 && cb <= 127 && cr >= 133 && cr <= 173;
}

/**
 * Deteksi apakah wajah terlihat pada video kamera.
 * Piksel kulit ≥ 4,5% area frame → dianggap wajah menghadap kamera
 * (wajah yang mengisi frame normalnya 10–30%; 4,5% cukup rendah untuk
 * menghindari false alarm namun jauh di atas noise latar).
 */
export async function detectFaceOk(video: HTMLVideoElement): Promise<boolean> {
  // Lapis 1: Shape Detection API bila tersedia.
  const FD = (window as unknown as { FaceDetector?: new (o?: { fastMode?: boolean; maxDetectedFaces?: number }) => { detect: (s: CanvasImageSource) => Promise<Array<unknown>> } }).FaceDetector;
  if (typeof FD === "function") {
    try {
      const fd = new FD({ fastMode: true, maxDetectedFaces: 1 });
      const faces = await fd.detect(video);
      if (Array.isArray(faces)) return faces.length > 0;
    } catch {
      /* API ada tapi gagal (mis. stream canvas) → heuristik */
    }
  }
  // Lapis 2: heuristik rasio piksel kulit.
  try {
    if (!video.videoWidth || !video.videoHeight) return false;
    const cv = document.createElement("canvas");
    cv.width = 64;
    cv.height = 48;
    const ctx = cv.getContext("2d", { willReadFrequently: true });
    if (!ctx) return false;
    ctx.drawImage(video, 0, 0, 64, 48);
    const d = ctx.getImageData(0, 0, 64, 48).data;
    let skin = 0;
    let lum = 0;
    const total = 64 * 48;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i];
      const g = d[i + 1];
      const b = d[i + 2];
      lum += 0.299 * r + 0.587 * g + 0.114 * b;
      if (isSkinYCbCr(r, g, b)) skin++;
    }
    const avgLum = lum / total;
    if (avgLum < 25) return false; // gelap total → kamera ditutup
    return skin / total >= 0.045;
  } catch {
    return false;
  }
}
