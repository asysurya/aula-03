<div align="center">

# 🏫 Aula

**Forum diskusi kelas modern** — chat realtime, cloud storage MEGA, tugas & pengumpulan pekerjaan, dan **form tugas anti-nyontek**.

Dibangun dengan Next.js · Prisma · MongoDB · Tailwind CSS · shadcn/ui

</div>

---

## ✨ Fitur

### 💬 Chat & Diskusi
- **Chat kelas** — satu ruang diskusi utama per kelas, realtime via polling (2.5s)
- **Grup privat** — siswa bisa membuat grup (maks 2 grup, join maks 20) lewat kode undangan
- **Direct Message (DM)** — percakapan pribadi antar anggota
- **Lampiran file** — kirim file/gambar di chat (tersimpan ke MEGA)
- **Reaksi emoji** — react pesan dengan emoji cepat
- **Status online** — indikator online/offline + baris "sedang mengetik"

### ☁️ Cloud & Materi (MEGA)
- **Browser file** — folder bersama, upload file (materi, tugas)
- **Dokumen bersama** — editor teks kolaboratif dengan autosave
- **Tugas & pengumpulan** — guru membuat tugas, siswa mengumpulkan file jawaban
- **Storage MEGA** — semua file otomatis tersimpan ke akun MEGA (gratis 20 GB), dikelola dari Admin Panel
- **Fallback aman** — jika MEGA tidak tersedia, file disimpan lokal sementara

### 📝 Form Tugas Anti-nyontek ⭐
Guru dapat membuat tugas berbentuk **form** dengan proteksi anti-nyontek:

| Jenis soal | Keterangan |
|---|---|
| **PG** (Pilihan Ganda) | satu jawaban benar, dinilai otomatis |
| **Multi-PG** | beberapa jawaban benar, dinilai otomatis |
| **Esai / Jawaban singkat** | dinilai manual oleh guru |
| **Upload file / gambar** | jawaban berupa file, tersimpan ke MEGA |

Mekanisme anti-nyontek:
- 🔀 **Urutan soal & opsi diacak** per siswa (orderSeed)
- 🔒 **Satu soal per layar, tanpa tombol mundur** — tidak bisa melewati lalu kembali
- ⏱️ **Timer countdown** dengan auto-submit saat waktu habis
- 🚫 **1x kesempatan pengerjaan** per siswa
- 📋 **Paste diblokir & dicatat** sebagai pelanggaran
- 👀 **Deteksi pindah tab/aplikasi** (visibility change) tercatat
- 💾 **Autosave** jawaban tiap 5 detik
- 📊 **Log pelanggaran** dapat ditinjau guru di halaman review + penilaian manual

### 👥 Lainnya
- **Manajemen anggota** — daftar siswa/guru per kelas, profil, bio
- **Admin panel** — kelola user, kelas, koneksi database, akun cloud MEGA
- **Tema gelap Discord/Slack-style** dengan aksen emerald
- **Auth username + password** (bcrypt, session cookie)

---

## 🧰 Tech Stack

| Layer | Teknologi |
|---|---|
| Framework | Next.js 16 (App Router) + React 19 |
| Database | MongoDB (Atlas) via **Prisma ORM** |
| Storage File | **MEGA** (megajs) + fallback lokal |
| UI | Tailwind CSS 4 + shadcn/ui + Radix |
| State | Zustand + React Query |
| Auth | NextAuth (Credentials, bcryptjs) |
| Realtime | Polling adaptif |

---

## 🚀 Quick Start (Lokal)

```bash
# 1. Clone & install
git clone https://github.com/asysurya/aula-03.git
cd aula-03
bun install        # atau: npm install

# 2. Siapkan .env
cp .env.example .env
#    isi DATABASE_URL (MongoDB Atlas / lokal), NEXTAUTH_SECRET, NEXTAUTH_URL

# 3. Push schema ke database
bunx prisma db push

# 4. Jalankan
bun run dev        # atau: npm run dev
```

Buka `http://localhost:3000` — database kosong akan **di-seed otomatis** saat halaman login pertama kali dibuka (`/api/setup`).

### 🔑 Akun Demo (seed)

| Username | Password | Role |
|---|---|---|
| `admin` | `admin123` | Admin |
| `guru` | `guru123` | Guru |
| `budi` / `siti` / `andi` | `siswa123` | Siswa |

> ⚠️ **Segera ganti password default setelah login!**

---

## ☁️ Deploy ke Vercel

Panduan lengkap: **[DEPLOY.md](./DEPLOY.md)** (MongoDB Atlas + MEGA + Vercel, plus alternatif Supabase).

Ringkas:

1. Fork/clone repo ini ke GitHub, lalu **Vercel → Import Project**
2. Set Environment Variables: `DATABASE_URL`, `NEXTAUTH_SECRET` (NEXTAUTH_URL opsional — kalau tidak dipakai, **hapus saja, jangan kosongkan**)
3. Deploy → buka app → login `admin / admin123`
4. **Admin Panel → Data & Cloud → Cloud Storage Accounts** → tambahkan akun MEGA (email + password) → **Tes Akun**
5. Selesai — semua upload (materi, lampiran chat, jawaban form) otomatis tersimpan ke MEGA 🎉

---

## 🗂️ Struktur Proyek

```
prisma/schema.prisma        # Skema DB (User, Classroom, Message, CloudFile, Form, ...)
scripts/seed.ts             # Seed manual (opsional — auto-seed juga tersedia)
src/app/                    # Routes (App Router) + API routes
src/components/
  ├── auth/                 # Login & register
  ├── layout/               # App shell, sidebar, online bar
  ├── chat/                 # Chat view, bubble, input, grup
  ├── cloud/                # File browser, dokumen, tugas, form anti-nyontek
  ├── admin/                # Admin panel
  ├── members/ profile/     # Anggota & profil
  └── shared/               # Avatar, logo, empty state
src/hooks/                  # use-me, use-presence, use-dm-conversations
src/lib/                    # auth, db, storage, mega-storage, presence
```

---

## 🔐 Environment Variables

| Nama | Wajib | Keterangan |
|---|---|---|
| `DATABASE_URL` | ✅ | Connection string MongoDB |
| `NEXTAUTH_SECRET` | ✅ | Secret session (openssl rand -base64 32) |
| `NEXTAUTH_URL` | ⚪ | URL dasar aplikasi — **opsional di Vercel** (`trustHost` aktif); diisi bila pakai custom domain. ⚠️ JANGAN diset string kosong! |

---

## 📝 Catatan

- Dibuat untuk skala 1 kelas ±40 siswa (multi-kelas didukung).
- Kredensial MEGA dikelola lewat Admin Panel (tersimpan di database) — pastikan akses admin terjaga.
- Chat realtime menggunakan polling — cukup andal untuk skala kelas tanpa infra websocket.

---

<div align="center">

**Aula** — dibuat untuk belajar bersama. 🎓

</div>
