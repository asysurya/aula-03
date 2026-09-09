# Panduan Deploy — Aula

**Aula** sekarang berjalan penuh dengan **MongoDB Atlas + MEGA Storage** (lihat bagian "MongoDB + MEGA Storage (Production)" di bawah untuk detail). Panduan ini memuat dua jalur deploy:

1. ** Jalur utama (direkomendasikan): Vercel + MongoDB Atlas + MEGA** — quick start di bawah.
2. ** Alternatif: Vercel + Supabase (Postgres)** — langkah lengkap di bagian setelah quick start.

---

## ⚡ Quick Start: Vercel + MongoDB Atlas + MEGA

Arsitektur saat ini: **Prisma MongoDB** (schema `prisma` provider = `mongodb`), file cloud tersimpan di **MEGA** (dikelola lewat Admin Panel → Data & Cloud), realtime via polling.

### 1. Siapkan MongoDB Atlas

1. Buat cluster gratis di [MongoDB Atlas](https://www.mongodb.com/atlas) (M0 free tier cukup untuk 1 kelas ±40 siswa).
2. **Database Access** → buat user database (catat username & password).
3. **Network Access** → tambah `0.0.0.0/0` (wajib untuk Vercel serverless) atau gunakan Vercel IP ranges.
4. Ambil connection string: `mongodb+srv://<user>:<pass>@<cluster>.mongodb.net/aula`.

### 2. Push schema ke Atlas

```bash
# di lokal, .env diarahkan ke Atlas:
DATABASE_URL="mongodb+srv://<user>:<pass>@<cluster>.mongodb.net/aula"
bunx prisma db push
```

> 💡 **Seed otomatis**: tidak perlu seed manual — saat app pertama kali dibuka, halaman login memanggil `/api/setup` dan database kosong akan di-seed otomatis (admin/guru/siswa default). Seed manual opsional: `bun run scripts/seed.ts`.

### 3. Deploy ke Vercel

1. Push repo ini ke GitHub, lalu **Vercel → Add New Project → Import** repo.
2. **Settings → Environment Variables** (Production + Preview):

   | Name | Value |
   |------|-------|
   | `DATABASE_URL` | `mongodb+srv://<user>:<pass>@<cluster>.mongodb.net/aula` |
   | `NEXTAUTH_SECRET` | hasil `openssl rand -base64 32` |
   | `NEXTAUTH_URL` | `https://nama-app.vercel.app` |

3. Deploy. Build command default (`next build`) sudah menjalankan `prisma generate` via `postinstall`.
4. Buka app → login `admin / admin123` → **WAJIB ganti password**.

### 4. Sambungkan MEGA (storage file cloud & lampiran)

1. Login sebagai **admin** → **Admin Panel → Data & Cloud → Cloud Storage Accounts**.
2. Tambah akun MEGA (email + password). Aula akan verifikasi koneksi dan menyimpan statusnya.
3. Setelah tersambung, semua upload (materi, lampiran chat, jawaban form FILE/GAMBAR) otomatis disimpan ke MEGA. Tanpa akun MEGA aktif, upload file akan ditolak (MEGA adalah storage wajib).

> Tips: MEGA membatasi percobaan login berulang (rate limit ±5–10 menit). Jika status akun "rate limited", tunggu sebentar lalu tekan **Sync** ulang di panel.

### Akun demo (seed)

| Username | Password | Role |
|----------|----------|------|
| `admin` | `admin123` | Admin |
| `guru` | `guru123` | Guru |
| `budi` / `siti` / `andi` | `siswa123` | Siswa |

---

## Alternatif: Vercel + Supabase (Postgres + Storage + Realtime opsional)

Panduan lengkap untuk men-deploy **Aula** ke Vercel dengan Supabase (Postgres + Storage + Realtime opsional).

Untuk Supabase, perlu swap 3 hal: database → Supabase Postgres, file storage → Supabase Storage, dan (opsional) realtime → Supabase Realtime.

---

## 0. Prasyarat

- Akun [Vercel](https://vercel.com) (gratis cukup)
- Akun [Supabase](https://supabase.com) (free tier cukup untuk 1 kelas ~40 siswa)
- Repo ini di-push ke GitHub/GitLab

---

## 1. Buat Project Supabase

1. Buka Supabase → **New Project**. Catat:
   - **Database password** (buat password kuat, simpan!)
   - **Region** (pilih terdekat, mis. Singapore)
2. Tunggu provisioning selesai.
3. Buka **Project Settings → Database → Connection string**. Salin **Connection string** (format `postgresql://postgres.[ref]:[password]@aws-0-[region].pooler.supabase.com:6543/postgres`). Ini adalah `DATABASE_URL` untuk Prisma.
   - Gunakan **Transaction mode** (port 6543) untuk serverless Vercel.
4. Buka **Project Settings → API**. Salin:
   - `Project URL` (mis. `https://xxxx.supabase.co`)
   - `anon public` key
   - `service_role` key (RAHASIA — hanya untuk server)

---

## 2. Buat Storage Bucket

1. Supabase Dashboard → **Storage** → **New bucket**.
2. Nama bucket: `aula-uploads`. Centang **Public bucket** = OFF (file hanya bisa diakses terauth).
   - Akses dikendalikan via API route, jadi bucket tetap private.
3. (Opsional) Atur **Policies** jika mau akses langsung. Untuk Aula, akses lewat API route sudah cukup — tidak perlu policy.

---

## 3. Konfigurasi Environment Variables di Vercel

Buat project di Vercel dari repo. Lalu di **Settings → Environment Variables**, tambahkan:

| Name | Value | Keterangan |
|------|-------|-----------|
| `DATABASE_URL` | `postgresql://postgres.[ref]:[pw]@aws-0-[region].pooler.supabase.com:6543/postgres` | Transaction mode (port 6543) untuk serverless |
| `DIRECT_URL` | `postgresql://postgres.[ref]:[pw]@aws-0-[region].pooler.supabase.com:5432/postgres` | Session mode (port 5432) untuk migrasi Prisma |
| `NEXTAUTH_SECRET` | (generate: `openssl rand -base64 32`) | WAJIB ganti dari nilai dev! |
| `NEXTAUTH_URL` | `https://nama-app.vercel.app` | URL produksi |
| `SUPABASE_URL` | `https://xxxx.supabase.co` | |
| `SUPABASE_ANON_KEY` | `eyJ...` | anon public key |
| `SUPABASE_SERVICE_ROLE_KEY` | `eyJ...` | service_role key (server only) |
| `SUPABASE_STORAGE_BUCKET` | `aula-uploads` | |

**Penting:** set environment variables untuk semua environment (Production + Preview + Development).

---

## 4. Migrasi Schema ke Supabase Postgres

Schema Prisma sudah Postgres-compatible (tidak pakai fitur SQLite-only). Yang perlu diubah:

### 4a. Ubah datasource di `prisma/schema.prisma`

```prisma
datasource db {
  provider  = "postgresql"          // ganti dari "sqlite"
  url       = env("DATABASE_URL")
  directUrl = env("DIRECT_URL")     // untuk migrasi
}
```

Jalankan migrasi lokal (sebelum push ke Vercel, supaya tabel terbentuk di Supabase):

```bash
# set DATABASE_URL dan DIRECT_URL ke Supabase di .env lokal dulu
bunx prisma migrate dev --name init
bunx prisma generate
bunx prisma db seed   # atau: bun run scripts/seed.ts
```

Atau pakai `prisma db push` (tanpa histori migrasi):
```bash
bunx prisma db push
bun run scripts/seed.ts
```

> Setelah ini, Supabase Postgres sudah punya semua tabel + admin user default.

### 4b. Tambahkan Prisma ke Vercel build

Di `package.json`, pastikan ada script:
```json
"postinstall": "prisma generate"
```
(Tambahkan jika belum ada — supaya Prisma Client ter-generate saat build Vercel.)

---

## 5. Swap Storage ke Supabase Storage

File `src/lib/storage.ts` saat ini pakai filesystem lokal (tidak persistent di Vercel). Swap ke Supabase Storage.

Install SDK:
```bash
bun add @supabase/supabase-js
```

Edit `src/lib/storage.ts` — ganti implementasi `saveFile` / `getFile` / `deleteFile` / `filePublicUrl`:

```ts
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } }
);

const BUCKET = process.env.SUPABASE_STORAGE_BUCKET || "aula-uploads";
export const MAX_FILE_SIZE = 50 * 1024 * 1024; // tetap 50MB

export async function saveFile(name: string, mimetype: string, bytes: Buffer) {
  if (bytes.length > MAX_FILE_SIZE) throw new Error("FILE_TOO_LARGE");
  const id = randomBytes(16).toString("hex");
  const ext = path.extname(name) || "";
  const key = `${id}${ext}`;
  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(key, bytes, { contentType: mimetype, upsert: false });
  if (error) throw new Error("Upload gagal: " + error.message);
  return { storageKey: key, size: bytes.length };
}

export async function getFile(storageKey: string) {
  const { data, error } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(storageKey, 3600); // URL bertanda 1 jam
  if (error || !data) return null;
  const res = await fetch(data.signedUrl);
  const bytes = Buffer.from(await res.arrayBuffer());
  return { bytes };
}

export async function deleteFile(storageKey: string) {
  await supabase.storage.from(BUCKET).remove([storageKey]);
}

export function filePublicUrl(storageKey: string) {
  // Tetap lewat API route kita (auth-gated). Lihat /api/storage/[key].
  return `/api/storage/${storageKey}`;
}
```

> Route `/api/storage/[key]` sudah ada dan auth-gated. Tinggal ganti isinya panggil `getFile()` yang baru.

---

## 6. (Opsional) Swap Realtime ke Supabase Realtime

Saat ini chat pakai **polling** (setiap 2.5 detik). Cukup untuk 1 kelas ~40 siswa. Kalau mau real-time sesungguhnya, gunakan Supabase Realtime:

1. Di `src/lib/supabase.ts` (client), buat client pakai anon key:
```ts
"use client";
import { createClient } from "@supabase/supabase-js";
export const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);
```
(Tambahkan `NEXT_PUBLIC_SUPABASE_URL` dan `NEXT_PUBLIC_SUPABASE_ANON_KEY` di Vercel env — pakai key anon yang sama, tapi prefix `NEXT_PUBLIC_`.)

2. Aktifkan Realtime untuk tabel `Message` di Supabase Dashboard → **Database → Replication** → enable untuk `Message`.

3. Di `src/components/chat/chat-view.tsx`, ganti polling `setInterval` dengan subscription:
```ts
useEffect(() => {
  const channel = supabase
    .channel(`messages-${conversation.id}`)
    .on("postgres_changes",
      { event: "INSERT", schema: "public", table: "Message", filter: `${scopeCol}=eq.${conversation.id}` },
      (payload) => setMessages((prev) => [...prev, payload.new])
    )
    .subscribe();
  return () => { supabase.removeChannel(channel); };
}, [conversation.id]);
```

> Polling tetap bisa dipakai sebagai fallback. Supabase Realtime lebih responsif tapi tambah kompleksitas. Untuk 1 kelas, polling sudah nyata cukup.

---

## 7. Deploy ke Vercel

1. Push semua perubahan ke repo (termasuk `prisma/schema.prisma` yang sudah `postgresql`).
2. Vercel → **Import Project** → pilih repo.
3. **Build & Output Settings**:
   - Framework Preset: **Next.js**
   - Build Command: default (`next build`)
   - Output dir: default
4. Pastikan semua Environment Variables (langkah 3) sudah diisi.
5. **Deploy**.

Setelah deploy sukses, buka URL Vercel. Login pakai `admin / admin123` (ganti password segera dari Profil!).

---

## 8. Post-Deploy Checklist

- [ ] Ganti password admin dari `admin123` (Profil → Keamanan → Ganti Password).
- [ ] Buat akun siswa dari Admin Panel → Pengguna → Tambah.
- [ ] Buat kelas baru / kelola anggota kelas default.
- [ ] Test upload file ke Cloud (pastikan Supabase Storage bekerja).
- [ ] Test kirim pesan di chat kelas.
- [ ] Cek Vercel Function Logs bila ada error 500 (biasanya env var salah).

---

## 9. Catatan & Limitasi

- **Auth**: username + password (admin buat akun). Reset password manual oleh admin. Tidak ada email/OAuth. Bisa ditambah NextAuth provider lain bila perlu.
- **Realtime**: polling 2.5s (default). Upgrade ke Supabase Realtime bila perlu (langkah 6).
- **File**: maks 50MB per file. File disimpan di Supabase Storage (private bucket, akses via signed URL lewat API route).
- **Limit unauth 500**: beberapa API route (cloud/admin) kembalikan 500 (bukan 401) saat request tanpa session. Tidak mempengaruhi UX (client selalu terauth). Bila ingin 401 bersih, bungkus route handler dengan try/catch returning `NextResponse.json({error:"Unauthorized"},{status:401})`.
- **Collaborative docs**: editor teks dengan autosave + polling 5s. Bukan real-time collaborative editing (OT/CRDT). Last-write menang dengan catatan "diperbarui".
- **Skala**: dirancang untuk 1 kelas ~40 siswa, multi-kelas didukung (admin kelola). Untuk skala lebih besar, naikkan tier Vercel/Supabase.

---

## 10. Quick Start (Ringkas)

```bash
# 1. Clone & install
git clone <repo> && cd aula && bun install

# 2. Setup .env (lihat langkah 3)
# 3. Ubah prisma/schema.prisma datasource ke postgresql
# 4. Migrate ke Supabase
bunx prisma db push
bun run scripts/seed.ts

# 5. (Vercel) Set env vars → Deploy
```

Selesai. Selamat menggunakan Aula! 🎓

---

## MongoDB + MEGA Storage (Production)

Selain Supabase Postgres di atas, Aula mendukung penyimpanan **MEGA** untuk file cloud dan monitoring koneksi **MongoDB** lewat panel admin “Data & Cloud”.

### 1. Pindahkan DB Aula ke MongoDB Atlas (opsional)

Schema Prisma portabel. Untuk pakai MongoDB sebagai DB utama Aula:

1. Buat cluster MongoDB Atlas (free tier cukup untuk 1 kelas ~40 siswa).
2. Salin connection string `mongodb+srv://<user>:<password>@<cluster>.mongodb.net/<db>?retryWrites=true&w=majority`.
3. Ubah `prisma/schema.prisma` datasource:
   ```prisma
   datasource db {
     provider = "mongodb"
     url      = env("DATABASE_URL")
   }
   ```
4. Set `DATABASE_URL` di Vercel env vars ke connection string Atlas.
5. Jalankan:
   ```bash
   bunx prisma generate
   bunx prisma db push
   bun run scripts/seed.ts   # admin/admin123 + kelas default
   ```

> Catatan: model Prisma di repo ini sudah Postgres-compatible. Untuk MongoDB, hapus `@relation` yang memakai `onDelete: Cascade` bila ada masalah (MongoDB perlu prisma mendukung cascade). `prisma db push` akan memberi tahu jika ada masalah.

### 2. Kelola koneksi MongoDB di panel admin (monitoring)

Bagian **Admin Panel → Data & Cloud → Database Connections** memungkinkan admin mendaftar koneksi MongoDB eksternal (mis. cluster analytics, cluster backup) untuk **monitoring status**.

- Setiap koneksi disimpan dengan `name`, `type` (mongodb), `uri` (sensitif, dimasking di UI).
- Tombol **Tes Koneksi** menjalankan `MongoClient.connect()` + ping, mengukur latensi, dan menyimpan `lastStatus`/`lastError`/`latencyMs`.
- Koneksi di panel ini **HANYA untuk monitoring**. DB aplikasi Aula sendiri diatur via env `DATABASE_URL`, bukan via panel ini.

### 3. Tambah akun MEGA untuk storage file cloud

Bagian **Admin Panel → Data & Cloud → Cloud Storage Accounts** memungkinkan admin mendaftar akun MEGA. Aplikasi otomatis:

- Memilih akun MEGA aktif (`active=true`, `lastStatus="connected"`) dengan **fileCount terkecil** (round-robin sederhana) untuk upload berikutnya.
- Jika tidak ada akun MEGA terhubung ATAU upload gagal → file otomatis disimpan di filesystem lokal (fallback aman).
- Saat file dihapus, storageKey dengan prefix `mega:<accountId>:<nodeId>` diparse, file dihapus dari MEGA, dan `fileCount` akun dikurangi.

Langkah setup:

1. Buat akun MEGA (gratis 20 GB di [mega.nz](https://mega.nz)).
2. Di panel admin → Data & Cloud → Cloud Storage Accounts → **Tambah**:
   - Nama (cth: `MEGA Pribadi`)
   - Provider: `mega`
   - Email + password akun MEGA
   - (Opsional) Master Key — biarkan kosong untuk login biasa
3. Setelah dibuat, klik **Tes Akun** untuk verifikasi login + baca kuota. Status berubah `connected` dan kuota terlihat di progress bar.
4. Upload file cloud berikutnya akan otomatis tersimpan di MEGA.

### 4. Catatan keamanan MEGA password

- Password MEGA disimpan di kolom `CloudAccount.password` pada database (MongoDB).
- **Production**: WAJIB enkripsi at-rest. Beberapa opsi:
  - App-level encryption: pakai `aes-256-gcm` dengan secret dari env `MEGA_ENC_KEY`. Dekripsi saat login.
  - Atau pakai KMS (AWS KMS, GCP KMS, Vercel Edge Config encrypted) untuk decrypt-on-demand.
- Patch `src/lib/mega-storage.ts` `openStorage()` untuk memanggil `decrypt(account.password)` sebelum diteruskan ke `megajs`.
- Jangan pernah return password di response API manapun. Route `GET /api/admin/cloud-accounts` sudah memakai `hasPassword: boolean` (tidak pernah mengirim password ke client).

### 5. Quick check: data flow setelah setup MEGA

```
User upload file (POST /api/cloud/files)
  → saveFile(name, mime, bytes)
    → pickMegaAccount() (active + connected, lowest fileCount)
    → jika ada: megaUpload → storageKey = "mega:<accountId>:<nodeId>"
    → increment fileCount
    → return { storageKey, size, cloudAccountId }
    → jika gagal: saveLocal() (fallback filesystem) + cloudAccountId=null
  → db.cloudFile.create({ storageKey, cloudAccountId })

User download (GET /api/storage/[key])
  → getFile(storageKey)
    → parseMegaKey → mega:acct:node → megaDownload()
    → atau: filesystem lokal
```

### 6. Troubleshooting

- **`MEGA_TIMEOUT`** di log → jaringan ke mega.nz lambat / terblokir firewall. Naikkan timeout di `src/lib/mega-storage.ts` jika perlu.
- **`lastError: "ENOTFOUND api.mega.co.nz"`** → DNS mega unreachable dari server. File otomatis fallback ke lokal.
- **Akun MEGA tidak bisa dihapus padahal sudah dihapus filenya** → cek `CloudAccount.fileCount`. Jika > 0, ada CloudFile masih punya `cloudAccountId` ke akun tersebut. Hapus file itu dulu (atau PATCH `cloudAccountId=null` di DB).
