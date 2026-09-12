"use client";

// ============================================================================
// Pusat Belajar (Study Hub) — shell utama berisi:
// 1. Header: sapaan, tanggal, streak, menit hari ini, Mode Fokus (fullscreen),
//    dan toggle Pengingat Jeda (aturan 20-20-20).
// 2. Kutipan motivasi harian (deterministik per hari, bisa diganti acak).
// 3. Tabs berisi seluruh fitur pembantu belajar (semuanya client-side).
// Data tersimpan di localStorage via store bersama "aula-study:*".
//
// CATATAN SCROLL: <main> di app-shell sengaja overflow-hidden (tiap view
// mengatur scroll sendiri). Root komponen ini karenanya memakai wrapper
// `h-full overflow-y-auto` (pola yang sama dengan ProfileView) agar konten
// yang lebih tinggi dari viewport bisa digulir. `overscroll-contain`
// mencegah scroll chaining/pull-to-refresh saat gulir mencapai ujung.
// Mode Fokus (fullscreen API) tetap bekerja karena layout kolom flex
// h-screen tidak berubah saat elemen dokumen masuk fullscreen.
// ============================================================================

import { useEffect, useState } from "react";
import { format, getDayOfYear } from "date-fns";
import { id as localeId } from "date-fns/locale";
import { toast } from "sonner";
import {
  Flame,
  Clock,
  Maximize2,
  Minimize2,
  Bell,
  BellOff,
  Sparkles,
  RefreshCw,
} from "lucide-react";
import type { MeResponse } from "@/hooks/use-me";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { computeStreak, todayStudyMinutes } from "@/lib/study/store";

// Komponen fitur (dibuat oleh agent lain — kontrak import tetap).
import { PomodoroPanel } from "./pomodoro";
import { StudyBuddy } from "./study-buddy";
import { TextTools } from "./text-tools";
import { AiBuilder } from "./ai-builder";
import { Organizers } from "./organizers";
import { ExamsPanel } from "./exams";
import { StudyStats } from "./study-stats";
import { QuickTools } from "./quick-tools";

// ---------------------------------------------------------------------------
// Kutipan motivasi belajar (≥40) — singkat, inspiratif, tanpa atribusi.
// Dipilih deterministik berdasarkan hari-tahun agar tiap hari berbeda.
// ---------------------------------------------------------------------------

const QUOTES: string[] = [
  "Belajar hari ini cerahkan esok hari.",
  "Sedikit demi sedikit, lama-lama menjadi mahir.",
  "Satu jam fokus lebih berharga daripada sehari yang terpecah-pecah.",
  "Kesalahan adalah bukti kamu sedang mencoba.",
  "Mulai dari yang kecil, mulai dari sekarang.",
  "Otak seperti otot: makin dilatih, makin kuat.",
  "Belajar bukan soal cepat, tapi konsisten.",
  "Yang sulit hari ini akan terasa ringan besok.",
  "Pemahaman datang kepada yang sabar.",
  "Lima halaman sehari adalah satu buku dalam setahun.",
  "Belajar rutin satu jam mengalahkan belajar semalam sebelum ujian.",
  "Fokus adalah keterampilan, bukan bakat — latihlah setiap hari.",
  "Cukup lebih baik dari kemarin, tak perlu sempurna hari ini.",
  "Lelah karena belajar lebih baik daripada menyesal karena menunda.",
  "Setiap pakar pernah menjadi pemula yang tidak menyerah.",
  "Catat, ulangi, pahami — itulah kunci ingatan.",
  "Pertanyaan yang berani adalah pintu pemahaman.",
  "Arah lebih penting daripada kecepatan.",
  "Rehat itu bagian dari belajar, bukan lawannya.",
  "Kerjakan yang sulit duluan saat pikiran masih segar.",
  "Bandingkan dirimu dengan dirimu kemarin, bukan dengan orang lain.",
  "Ilmu yang dibagikan akan semakin tertanam dalam dirimu.",
  "Membaca cepat tidak berguna bila tidak ada yang tersimpan.",
  "Satu bab hari ini, satu langkah lebih dekat ke tujuan.",
  "Konsistensi kecil mengalahkan semangat besar yang cepat padam.",
  "Mengulang adalah kawan terbaik ingatan.",
  "Bersyukur bisa belajar adalah bahan bakar semangat.",
  "Catatan yang rapi adalah pikiran yang tenang.",
  "Kalau bosan, ganti cara — jangan langsung berhenti.",
  "Pahami dulu 'kenapa', baru hafalkan 'apa'.",
  "Beristirahat lima menit boleh, asal kembali tepat waktu.",
  "Rencana belajar hari ini adalah hadiah untuk dirimu esok.",
  "Hafalan tanpa pemahaman mudah hilang; pahami dulu, hafalkan kemudian.",
  "Keberhasilan belajar diukur dari rasa ingin tahu yang bertambah.",
  "Jangan menunggu semangat datang; semangat hadir setelah kamu mulai.",
  "Setiap kata baru yang kamu pelajari adalah jendela dunia baru.",
  "Disiplin adalah cinta pada cita-citamu dalam tindakan.",
  "Lebih baik jujur belum paham hari ini daripada pura-pura paham selamanya.",
  "Ajukan pertanyaan, kejar jawaban, nikmati prosesnya.",
  "Sulit itu tanda sedang menanjak, bukan tanda untuk berhenti.",
  "Belajar itu maraton — jaga napasmu, jangan buru-buru.",
  "Satu sesi fokus hari ini adalah investasi terbaik untuk dirimu.",
];

// ---------------------------------------------------------------------------
// Komponen utama
// ---------------------------------------------------------------------------

export function StudyHub({ me }: { me: MeResponse }) {
  // Statistik header (streak & menit hari ini) — di-refresh tiap ada sesi baru.
  // Init lazy: komponen ini hanya dirender setelah interaksi client (section
  // "study"), jadi localStorage pasti tersedia dan tidak ada hydration shift.
  const [stats, setStats] = useState(() => ({
    streak: computeStreak(),
    minutes: todayStudyMinutes(),
  }));
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [breakReminder, setBreakReminder] = useState(false);
  // Index kutipan: deterministik per hari-tahun, bisa diganti acak manual.
  const [quoteIndex, setQuoteIndex] = useState(
    () => (getDayOfYear(new Date()) - 1) % QUOTES.length
  );

  // Muat ulang statistik header.
  function refreshStats() {
    setStats({ streak: computeStreak(), minutes: todayStudyMinutes() });
  }

  useEffect(() => {
    // Dengarkan perubahan sesi: event kustom (tab ini) + "storage" (tab lain).
    // (Statistik awal sudah dihitung lazy di useState initializer.)
    const onUpdate = () => refreshStats();
    const onStorage = (e: StorageEvent) => {
      if (e.key === null || e.key.startsWith("aula-study:")) refreshStats();
    };
    window.addEventListener("aula-study:updated", onUpdate);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener("aula-study:updated", onUpdate);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  // Pengingat jeda (aturan 20-20-20): tiap 20 menit, hanya saat tab terlihat.
  useEffect(() => {
    if (!breakReminder) return;
    const id = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState === "visible") {
        toast.info("Istirahat 20 detik — alihkan pandangan 6 meter (aturan 20-20-20)");
      }
    }, 20 * 60 * 1000);
    // Bersihkan interval saat toggle dimatikan / komponen unmount.
    return () => clearInterval(id);
  }, [breakReminder]);

  // Pantau status fullscreen agar tombol mencerminkan kondisi sebenarnya
  // (misalnya pengguna keluar fullscreen lewat tombol browser sendiri).
  useEffect(() => {
    const onFs = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  // Mode Fokus: layar penuh untuk meminimalkan gangguan.
  function toggleFullscreen() {
    try {
      if (document.fullscreenElement) {
        void document.exitFullscreen();
      } else {
        void document.documentElement.requestFullscreen();
      }
    } catch {
      // Browser bisa menolak fullscreen — abaikan dengan aman.
    }
  }

  // Ganti kutipan secara acak (pastikan berbeda dari yang tampil).
  function shuffleQuote() {
    setQuoteIndex((prev) => {
      if (QUOTES.length <= 1) return prev;
      let next = prev;
      while (next === prev) {
        next = Math.floor(Math.random() * QUOTES.length);
      }
      return next;
    });
  }

  const dateStr = format(new Date(), "EEEE, d MMMM yyyy", { locale: localeId });
  const name = me.user?.name ?? "Sobat Belajar";

  return (
    <div className="h-full overflow-y-auto overscroll-contain">
      <div className="max-w-5xl mx-auto p-4 space-y-4">
        {/* ============ HEADER ============ */}
        <Card>
          <CardContent className="p-4 sm:p-6">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0 space-y-1">
                <h1 className="text-xl sm:text-2xl font-semibold truncate">
                  Halo, {name}
                </h1>
                <p className="text-sm text-muted-foreground capitalize">{dateStr}</p>
                <div className="flex flex-wrap items-center gap-2 pt-2">
                  <Badge variant="secondary" className="gap-1.5">
                    <Flame className="h-3.5 w-3.5 text-orange-500" />
                    {stats.streak} hari
                  </Badge>
                  <Badge variant="secondary" className="gap-1.5">
                    <Clock className="h-3.5 w-3.5 text-sky-500" />
                    {stats.minutes} menit hari ini
                  </Badge>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2 shrink-0">
                <Button
                  variant={breakReminder ? "default" : "outline"}
                  size="sm"
                  onClick={() => setBreakReminder((v) => !v)}
                  title="Pengingat istirahat mata tiap 20 menit (aturan 20-20-20)"
                >
                  {breakReminder ? (
                    <Bell className="h-4 w-4" />
                  ) : (
                    <BellOff className="h-4 w-4" />
                  )}
                  Pengingat Jeda
                </Button>
                <Button
                  variant={isFullscreen ? "default" : "outline"}
                  size="sm"
                  onClick={toggleFullscreen}
                  title="Sembunyikan gangguan dengan layar penuh"
                >
                  {isFullscreen ? (
                    <Minimize2 className="h-4 w-4" />
                  ) : (
                    <Maximize2 className="h-4 w-4" />
                  )}
                  Mode Fokus
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* ============ KUTIPAN MOTIVASI ============ */}
        <Card>
          <CardContent className="p-4 flex items-start gap-3">
            <div className="mt-0.5 shrink-0 text-amber-500">
              <Sparkles className="h-4 w-4" />
            </div>
            <p className="text-sm italic flex-1 leading-relaxed">
              &ldquo;{QUOTES[quoteIndex]}&rdquo;
            </p>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 shrink-0"
              onClick={shuffleQuote}
              title="Ganti kutipan (acak)"
              aria-label="Ganti kutipan"
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </Button>
          </CardContent>
        </Card>

        {/* ============ TABS FITUR ============ */}
        <Tabs defaultValue="pomodoro" className="gap-4">
          {/* TabsList dapat digulir horizontal di layar kecil */}
          <div className="overflow-x-auto pb-1">
            <TabsList className="h-auto w-max min-w-full justify-start">
              <TabsTrigger value="pomodoro" className="px-3 py-1.5">
                Pomodoro
              </TabsTrigger>
              <TabsTrigger value="buddy" className="px-3 py-1.5">
                Teman AI
              </TabsTrigger>
              <TabsTrigger value="builder" className="px-3 py-1.5">
                AI Builder
              </TabsTrigger>
              <TabsTrigger value="text-tools" className="px-3 py-1.5">
                Alat Materi
              </TabsTrigger>
              <TabsTrigger value="planners" className="px-3 py-1.5">
                Rencana
              </TabsTrigger>
              <TabsTrigger value="exams" className="px-3 py-1.5">
                Ujian &amp; Jadwal
              </TabsTrigger>
              <TabsTrigger value="stats" className="px-3 py-1.5">
                Statistik
              </TabsTrigger>
              <TabsTrigger value="quick" className="px-3 py-1.5">
                Alat Cepat
              </TabsTrigger>
            </TabsList>
          </div>

          <TabsContent value="pomodoro">
            <PomodoroPanel />
          </TabsContent>
          <TabsContent value="buddy">
            <StudyBuddy />
          </TabsContent>
          <TabsContent value="builder">
            <AiBuilder />
          </TabsContent>
          <TabsContent value="text-tools">
            <TextTools />
          </TabsContent>
          <TabsContent value="planners">
            <Organizers />
          </TabsContent>
          <TabsContent value="exams">
            <ExamsPanel />
          </TabsContent>
          <TabsContent value="stats">
            <StudyStats />
          </TabsContent>
          <TabsContent value="quick">
            <QuickTools />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
