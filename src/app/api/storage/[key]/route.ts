import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";
import { db } from "@/lib/db";
import { deleteFile, getFile } from "@/lib/storage";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { parseMegaKey, megaDownloadStream } from "@/lib/mega-storage";
import { mimetypeFromName } from "@/lib/cloud-format";
import { fileCacheGetOrLoad } from "@/lib/file-cache";
import { s3Stream } from "@/lib/s3-storage";
import { s3AccountOf, checkStorageAccess } from "@/lib/storage-access";

// Serve uploaded files (preview-friendly & anti-lag):
// 1. Effective mimetype = magic bytes (deteksi isi asli) > mimetype DB > ekstensi.
//    Kasus nyata: "modul.pdf" yang di-rename ".docx" tetap terbuka sebagai PDF.
// 2. Content-Disposition inline untuk semua tipe yang bisa dirender browser
//    atau di-pratinjau aplikasi (pdf, gambar, video, audio, teks, office).
// 3. ETag + Cache-Control immutable → browser meng-cache; buka ulang instan.
// 4. LRU cache blob di memori proses → unduhan MEGA/S3 hanya sekali.
// 5. Dukungan Range (206) → video/audio bisa seek tanpa unduh ulang.
// 6. File besar di-stream → lolos batas response 4.5 MB serverless Vercel.

export const runtime = "nodejs";
export const maxDuration = 60;

// ───────────────────────── Magic-byte sniffing ─────────────────────────

function startsWith(bytes: Buffer, prefix: number[] | string, offset = 0): boolean {
  const pfx = typeof prefix === "string" ? Buffer.from(prefix, "latin1") : Buffer.from(prefix);
  if (bytes.length < offset + pfx.length) return false;
  for (let i = 0; i < pfx.length; i++) {
    if (bytes[offset + i] !== pfx[i]) return false;
  }
  return true;
}

/**
 * Deteksi tipe file dari isi (magic bytes). Mengembalikan mimetype "asli"
 * bila isi jelas-jelas berbeda dengan mimetype terdaftar (mis. PDF yang
 * di-rename .docx), atau null bila tidak bisa dideteksi.
 */
function sniffMimetype(bytes: Buffer): string | null {
  if (startsWith(bytes, "%PDF")) return "application/pdf";
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47])) return "image/png"; // PNG
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg"; // JPEG
  if (startsWith(bytes, "GIF8")) return "image/gif";
  if (startsWith(bytes, "RIFF") && startsWith(bytes, "WEBP", 8)) return "image/webp";
  if (startsWith(bytes, "BM") && bytes.length > 14) return "image/bmp";
  if (startsWith(bytes, "ID3") || startsWith(bytes, [0xff, 0xfb])) return "audio/mpeg";
  if (startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3])) return "video/webm"; // EBML (webm/mkv)
  if (startsWith(bytes, [0x00, 0x00, 0x00])) {
    // MP4/MOV: 4-byte length + "ftyp" pada offset 4.
    if (startsWith(bytes, "ftyp", 4)) return "video/mp4";
  }
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) || startsWith(bytes, [0x50, 0x4b, 0x05, 0x06])) {
    return "application/zip-container"; // docx/xlsx/pptx/zip — detail via ekstensi
  }
  return null;
}

/**
 * Mimetype efektif: baca isi asli, bandingkan dengan yang terdaftar.
 * - Isi PDF + terdaftar non-PDF (mis. .docx) → pakai PDF.
 * - Isi zip-container + terdaftar PDF → pakai tipe office dari ekstensi.
 * - Deteksi gambar/audio/video → pakai hasil deteksi.
 */
function effectiveMimetype(bytes: Buffer, declared: string, name: string): string {
  const sniffed = sniffMimetype(bytes);
  if (!sniffed) return declared || mimetypeFromName(name);

  if (sniffed === "application/pdf") {
    // PDF asli — apapun labelnya, layani sebagai PDF.
    return "application/pdf";
  }
  if (sniffed === "application/zip-container") {
    // Kontainer OOXML — percaya mimetype terdaftar bila wajar, kalau tidak
    // pakai ekstensi (docx/xlsx/pptx/zip).
    if (declared && /officedocument|msword|ms-excel|ms-powerpoint|zip|presentation|sheet|wordprocessing/.test(declared)) {
      return declared;
    }
    const byExt = mimetypeFromName(name);
    return byExt !== "application/octet-stream" ? byExt : "application/zip";
  }
  if (sniffed.startsWith("image/") || sniffed.startsWith("audio/") || sniffed.startsWith("video/")) {
    return sniffed;
  }
  return declared || mimetypeFromName(name);
}

// ───────────────────────── Content helpers ─────────────────────────

function isInlineMime(_mime: string): boolean {
  // SELALU inline kecuali user meminta unduhan eksplisit (?download=1
  // atau atribut download pada <a> yang men-trigger query sama).
  // Browser sendiri yang memutuskan bisa-tidaknya merender tipe tsb;
  // disposition=inline mencegah browser MEMAKSA unduh — pratinjau
  // (iframe/img/video/office via konversi client) jadi selalu mulus.
  // Unduhan tetap tersedia lewat tombol "Unduh" yang menambah ?download=1.
  return true;
}

/** Nama file aman untuk header ASCII (fallback RFC 5987). */
function asciiFilename(name: string): string {
  const base = (name || "file").split("/").pop() || "file";
  const cleaned = base.replace(/[\r\n"\\]/g, "_").replace(/[\x00-\x1f]/g, "");
  // Ganti karakter non-ASCII dengan _ supaya header tetap valid.
  return cleaned.replace(/[^\x20-\x7e]/g, "_") || "file";
}

function etagFor(key: string, size: number): string {
  return `"${createHash("sha1").update(`${key}:${size}`).digest("hex")}"`;
}

/** Konversi Buffer → ReadableStream (512KB per chunk) untuk file besar. */
function bufferToStream(buf: Buffer): ReadableStream<Uint8Array> {
  const CHUNK = 512 * 1024;
  let pos = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pos >= buf.length) {
        controller.close();
        return;
      }
      const end = Math.min(pos + CHUNK, buf.length);
      controller.enqueue(new Uint8Array(buf.subarray(pos, end)));
      pos = end;
    },
  });
}

interface ServeOptions {
  bytes: Buffer;
  mime: string;
  name: string;
  key: string;
  forceDownload?: boolean;
}

function serveFile(req: NextRequest, opts: ServeOptions): NextResponse {
  const { bytes, mime, name, key } = opts;
  const size = bytes.length;
  const etag = etagFor(key, size);

  // 304 Not Modified — browser sudah punya file yang sama.
  const inm = req.headers.get("if-none-match");
  if (inm && inm.split(",").map((s) => s.trim()).includes(etag)) {
    return new NextResponse(null, {
      status: 304,
      headers: {
        ETag: etag,
        "Cache-Control": "private, max-age=86400, immutable",
      },
    });
  }

  const disposition =
    opts.forceDownload || req.nextUrl.searchParams.get("download") === "1"
      ? "attachment"
      : "inline";

  // RFC 5987: filename* UTF-8 untuk nama non-ASCII + fallback ASCII.
  // (Sebelumnya encodeURIComponent bikin nama file jadi %20 dll di unduhan.)
  const ascii = asciiFilename(name);
  const dispositionValue =
    `${disposition}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;

  const baseHeaders: Record<string, string> = {
    "Content-Type": mime,
    "Content-Disposition": dispositionValue,
    ETag: etag,
    // Key file tidak pernah berubah isinya (upload baru = key/node baru)
    // → aman untuk cache immutable.
    "Cache-Control": "private, max-age=86400, immutable",
    "Accept-Ranges": "bytes",
    // Cegah eksekusi skrip jika nama file HTML/SVG — pratinjau tetap jalan
    // karena elemen <img>/<video>/<iframe> & fetch blob tidak eksekusi
    // skrip pada response dengan sandbox header ini... kecuali SVG <img>
    // yang aman secara native.
    "X-Content-Type-Options": "nosniff",
  };

  // Konten yang bisa berisi skrip (svg/html) → sandbox agar aman saat dibuka
  // langsung di tab, tanpa mengganggu pratinjau <img>/<iframe> dari app.
  if (mime === "image/svg+xml" || mime === "text/html") {
    baseHeaders["Content-Security-Policy"] = "sandbox";
  }

  // ── Range request (seek video/audio) ──
  const rangeHeader = req.headers.get("range");
  if (rangeHeader && !disposition.startsWith("attachment")) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
    if (match) {
      let start = match[1] ? parseInt(match[1], 10) : 0;
      let end = match[2] ? parseInt(match[2], 10) : size - 1;
      if (Number.isNaN(start)) start = 0;
      if (Number.isNaN(end) || end >= size) end = size - 1;
      if (start <= end && start < size) {
        const chunk = bytes.subarray(start, end + 1);
        return new NextResponse(new Uint8Array(chunk), {
          status: 206,
          headers: {
            ...baseHeaders,
            "Content-Range": `bytes ${start}-${end}/${size}`,
            "Content-Length": String(chunk.length),
          },
        });
      }
      // Range tidak satisfiable.
      return new NextResponse(null, {
        status: 416,
        headers: { "Content-Range": `bytes */${size}` },
      });
    }
  }

  // ── File besar: stream (lolos batas response serverless) ──
  if (size > 4 * 1024 * 1024) {
    return new NextResponse(bufferToStream(bytes), {
      status: 200,
      headers: baseHeaders,
    });
  }

  return new NextResponse(new Uint8Array(bytes), {
    status: 200,
    headers: { ...baseHeaders, "Content-Length": String(size) },
  });
}

/** Ambil bytes file dengan LRU cache proses + dedup in-flight (unduh
 *  MEGA/S3 cukup sekali walau beberapa request Range paralel datang
 *  bersamaan — semua pemanggil berbagi satu promise load). */
async function loadBytes(key: string): Promise<Buffer | null> {
  return fileCacheGetOrLoad(key, async () => {
    const data = await getFile(key);
    return data ? data.bytes : null;
  });
}

// ───────────────────────── GET / HEAD ─────────────────────────

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ key: string }> }
) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return new NextResponse("Unauthorized", { status: 401 });
  }
  const { key } = await params;
  const user = session.user as { id?: string; role?: string };

  // ── Pemeriksaan akses (logika bersama dgn /api/storage/[key]/link) ──
  const access = await checkStorageAccess(
    user?.id && user?.role ? { id: user.id, role: user.role } : null,
    key
  );
  if (!access.ok) {
    // File sementara kedaluwarsa → bersihkan malas (sama seperti dulu).
    if (access.status === 410) {
      try {
        await deleteFile(key);
      } catch {
        /* ignore blob delete errors */
      }
      try {
        await db.cloudFile.deleteMany({ where: { storageKey: key } });
      } catch {
        /* may already be deleted */
      }
    }
    return new NextResponse(access.body, { status: access.status });
  }

  // Metadata dasar utk header.
  const name =
    access.kind === "cloud"
      ? access.file.name
      : req.nextUrl.searchParams.get("name") ?? "file";
  const mime =
    access.kind === "cloud"
      ? access.file.mimetype || mimetypeFromName(name)
      : mimetypeFromName(name);
  const size = access.kind === "cloud" ? access.file.size : 0;
  const forceDownload = req.nextUrl.searchParams.get("download") === "1";
  const etag = etagFor(key, size);

  const baseHeaders: Record<string, string> = {
    "Content-Type": mime,
    "Content-Disposition": dispositionValue(name, forceDownload),
    ETag: etag,
    "Cache-Control": "private, max-age=86400, immutable",
    "Accept-Ranges": "bytes",
    "X-Content-Type-Options": "nosniff",
  };
  if (mime === "image/svg+xml" || mime === "text/html") {
    baseHeaders["Content-Security-Policy"] = "sandbox";
  }

  // 304 Not Modified — tidak perlu menyentuh storage sama sekali.
  const inm = req.headers.get("if-none-match");
  if (inm && size > 0 && inm.split(",").map((s) => s.trim()).includes(etag)) {
    return new NextResponse(null, {
      status: 304,
      headers: {
        ETag: etag,
        "Cache-Control": "private, max-age=86400, immutable",
      },
    });
  }

  const rangeHeader = req.headers.get("range");

  // ── JALUR CEPAT 1: S3 → stream langsung (Range = slice asli) ──
  // File kecil tanpa Range tetap lewat jalur buffer agar magic-byte
  // sniffing tetap jalan (ukuran < 4 MB murah dibuffer).
  const s3 = await s3AccountOf(key);
  if (s3) {
    const range = parseRangeHeader(rangeHeader, size);
    const wantStream =
      range !== null || // Range apa pun → slice murah dari S3
      (size === 0 || size >= 4 * 1024 * 1024); // besar → stream
    if (wantStream && !forceDownload) {
      const r = await s3Stream(s3.account, s3.objectKey, range ?? undefined);
      if (r) {
        if (range) {
          return new NextResponse(r.stream, {
            status: 206,
            headers: {
              ...baseHeaders,
              "Content-Range":
                r.contentRange ??
                `bytes ${range.start}-${range.end}/${size || r.length}`,
              "Content-Length": String(r.length),
            },
          });
        }
        return new NextResponse(r.stream, {
          status: 200,
          headers: {
            ...baseHeaders,
            ...(r.length ? { "Content-Length": String(r.length) } : {}),
          },
        });
      }
      // Stream gagal → jatuh ke jalur buffer di bawah.
    }
  }

  // ── JALUR CEPAT 2: MEGA tanpa Range & file besar → stream megajs ──
  // (Range MEGA tetap lewat buffer — unduhan paralel per-range dari MEGA
  // hanya membuang bandwidth; buffer + LRU menghandle seek video.)
  const mega = parseMegaKey(key);
  if (mega && !rangeHeader && !forceDownload && (size === 0 || size >= 4 * 1024 * 1024)) {
    const account = await db.cloudAccount.findUnique({
      where: { id: mega.accountId },
      select: { id: true, email: true, password: true, sessionData: true },
    });
    if (account) {
      const r = await megaDownloadStream(account, mega.nodeId);
      if (r) {
        return new NextResponse(r.stream, {
          status: 200,
          headers: {
            ...baseHeaders,
            ...(r.size ? { "Content-Length": String(r.size) } : {}),
          },
        });
      }
      // Stream gagal → jalur buffer (unduhan penuh + sniff) di bawah.
    }
  }

  // ── JALUR BUFFER (semua kasus lain; dengan LRU + magic-byte sniff) ──
  const bytes = await loadBytes(key);
  if (!bytes) return new NextResponse("Not found", { status: 404 });

  const effMime = effectiveMimetype(bytes, mime, name);
  return serveFile(req, {
    bytes,
    mime: effMime,
    name,
    key,
  });
}

/** Parse header Range → { start, end } (null bila absen/tak valid). */
function parseRangeHeader(
  rangeHeader: string | null,
  size: number
): { start: number; end: number } | null {
  if (!rangeHeader) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!match) return null;
  let start = match[1] ? parseInt(match[1], 10) : 0;
  let end = match[2] ? parseInt(match[2], 10) : Number.MAX_SAFE_INTEGER;
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  if (size > 0) {
    if (end >= size) end = size - 1;
  }
  if (start < 0 || start > end) return null;
  return { start, end };
}

function dispositionValue(name: string, forceDownload: boolean): string {
  const disposition = forceDownload ? "attachment" : "inline";
  const ascii = asciiFilename(name);
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

// HEAD — headers saja (tanpa body); dipakai client untuk cek tipe sebelum
// pratinjau. Bytes tetap di-load supaya ETag/mime akurat (dan masuk cache).
export async function HEAD(
  req: NextRequest,
  { params }: { params: Promise<{ key: string }> }
) {
  const res = await GET(req, { params });
  return new NextResponse(null, {
    status: res.status,
    headers: res.headers,
  });
}
