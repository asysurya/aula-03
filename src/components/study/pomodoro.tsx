"use client";

// ============================================================================
// Pomodoro — timer belajar berselang (fokus -> istirahat -> fokus ...).
// Timer AKURAT walau tab di-background: sisa waktu dihitung dari stempel
// waktu berakhir (endTimeRef = Date.now() + durasi), interval hanya memeriksa.
// ============================================================================

import { useEffect, useRef, useState } from "react";
import { isToday } from "date-fns";
import { toast } from "sonner";
import {
  Play,
  Pause,
  RotateCcw,
  SkipForward,
  Volume2,
  VolumeX,
  Timer,
  Coffee,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import {
  getStudySessions,
  logStudySession,
  useLocalJSON,
} from "@/lib/study/store";

// ---------------------------------------------------------------------------
// Tipe & konstanta
// ---------------------------------------------------------------------------

type Phase = "focus" | "break" | "longBreak";
type PresetKey = "classic" | "long" | "short" | "custom";

interface PomodoroSettings {
  preset: PresetKey;
  focusMin: number;
  breakMin: number;
  longBreakMin: number;
}

/** Preset cepat: fokus / istirahat / istirahat panjang (menit). */
const PRESETS: Record<
  Exclude<PresetKey, "custom">,
  { label: string; focusMin: number; breakMin: number; longBreakMin: number }
> = {
  classic: { label: "Klasik 25/5", focusMin: 25, breakMin: 5, longBreakMin: 15 },
  long: { label: "Panjang 50/10", focusMin: 50, breakMin: 10, longBreakMin: 30 },
  short: { label: "Kilat 15/3", focusMin: 15, breakMin: 3, longBreakMin: 10 },
};

const DEFAULT_SETTINGS: PomodoroSettings = {
  preset: "classic",
  focusMin: 25,
  breakMin: 5,
  longBreakMin: 15,
};

/** Jumlah fokus sebelum istirahat panjang. */
const FOCUS_PER_LONG_BREAK = 4;

const PHASE_LABEL: Record<Phase, string> = {
  focus: "Fokus",
  break: "Istirahat",
  longBreak: "Istirahat Panjang",
};

// ---------------------------------------------------------------------------
// Helper murni
// ---------------------------------------------------------------------------

/** Durasi sebuah fase (ms) menurut pengaturan. */
function phaseDurationMs(
  phase: Phase,
  s: Pick<PomodoroSettings, "focusMin" | "breakMin" | "longBreakMin">
): number {
  const mins =
    phase === "focus" ? s.focusMin : phase === "break" ? s.breakMin : s.longBreakMin;
  return Math.max(1, Math.round(mins)) * 60_000;
}

/** Format sisa waktu menjadi MM:SS. */
function formatClock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Komponen utama
// ---------------------------------------------------------------------------

export function PomodoroPanel() {
  // Pengaturan dipersist di localStorage agar tidak hilang saat reload.
  const [settings, setSettings] = useLocalJSON<PomodoroSettings>(
    "aula-study:pomodoro-settings",
    DEFAULT_SETTINGS
  );

  const [phase, setPhase] = useState<Phase>("focus");
  const [running, setRunning] = useState(false);
  // Sisa waktu (ms) — sumber tampilan & titik lanjut saat mulai/jeda.
  // Diinisialisasi dari pengaturan tersimpan agar tidak ada "kedip" durasi salah.
  const [remainingMs, setRemainingMs] = useState(() =>
    phaseDurationMs("focus", settings)
  );
  const [completedFocus, setCompletedFocus] = useState(0);
  const [soundOn, setSoundOn] = useState(true);

  // Stempel waktu berakhir — kunci akurasi di background tab.
  const endTimeRef = useRef<number | null>(null);
  // Handler penyelesaian fase — selalu diperbarui agar closure terbaru.
  const completeRef = useRef<() => void>(() => {});
  // Judul dokumen asli untuk dipulihkan saat timer berhenti.
  const originalTitleRef = useRef("");

  // Sinkronkan tampilan sisa waktu saat pengaturan durasi berubah
  // (fase direset ke durasi barunya). Memakai pola "sesuaikan state saat
  // render" dari dokumentasi React (You Might Not Need an Effect) —
  // aman & bebas cascading render.
  const [prevDurations, setPrevDurations] = useState({
    f: settings.focusMin,
    b: settings.breakMin,
    l: settings.longBreakMin,
  });
  if (
    settings.focusMin !== prevDurations.f ||
    settings.breakMin !== prevDurations.b ||
    settings.longBreakMin !== prevDurations.l
  ) {
    setPrevDurations({
      f: settings.focusMin,
      b: settings.breakMin,
      l: settings.longBreakMin,
    });
    setRemainingMs(phaseDurationMs(phase, settings));
    setRunning(false);
  }

  // Reset stempel akhir saat durasi berubah (mutasi ref hanya di effect).
  useEffect(() => {
    endTimeRef.current = null;
  }, [settings.focusMin, settings.breakMin, settings.longBreakMin]);

  // Handler penyelesaian fase — ditulis ulang tiap render agar memakai
  // state terbaru (dipanggil dari interval, bukan render).
  // startPhase dideklarasikan lebih dulu (di bawah) sebagai function
  // declaration — hoisted — namun ditaruh di atas agar alur mudah dibaca.
  /** Pindah fase: set durasi, lalu jalankan otomatis bila autoStart. */
  function startPhase(next: Phase, autoStart: boolean) {
    const ms = phaseDurationMs(next, settings);
    setPhase(next);
    setRemainingMs(ms);
    endTimeRef.current = autoStart ? Date.now() + ms : null;
    setRunning(autoStart);
  }

  useEffect(() => {
    completeRef.current = () => {
      if (phase === "focus") {
        // Fokus selesai -> catat sesi belajar + notifikasi + suara.
        logStudySession({
          minutes: settings.focusMin,
          kind: "pomodoro",
          note: "Sesi pomodoro",
        });
        toast.success("Sesi fokus selesai — istirahat dulu!");
        playBeep(soundOn);
        const nextCount = completedFocus + 1;
        setCompletedFocus(nextCount);
        // Setiap 4 fokus -> istirahat panjang, selain itu istirahat pendek.
        const nextPhase: Phase =
          nextCount % FOCUS_PER_LONG_BREAK === 0 ? "longBreak" : "break";
        startPhase(nextPhase, true);
      } else {
        // Istirahat selesai -> kembali fokus.
        toast.info("Waktu istirahat selesai — ayo fokus lagi!");
        playBeep(soundOn);
        startPhase("focus", true);
      }
    };
  });

  // Interval pemeriksa (500ms) — hanya membandingkan dengan endTimeRef,
  // sehingga drift/penundaan tab background tidak memengaruhi akurasi.
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => {
      const end = endTimeRef.current;
      if (end == null) return;
      const remaining = end - Date.now();
      if (remaining <= 0) {
        completeRef.current();
      } else {
        setRemainingMs(remaining);
      }
    }, 500);
    return () => clearInterval(id);
  }, [running]);

  // Tampilkan sisa waktu di judul tab selama timer berjalan.
  useEffect(() => {
    if (typeof document === "undefined") return;
    if (running) {
      document.title = `${formatClock(remainingMs)} · ${PHASE_LABEL[phase]} — Pusat Belajar`;
    } else {
      document.title = originalTitleRef.current;
    }
  }, [running, remainingMs, phase]);

  // Simpan judul asli & pulihkan saat unmount.
  useEffect(() => {
    if (typeof document === "undefined") return;
    originalTitleRef.current = document.title;
    return () => {
      document.title = originalTitleRef.current;
    };
  }, []);

  // Statistik hari ini: jumlah sesi & menit fokus (kind pomodoro).
  // Init lazy (komponen hanya mount di client) + refresh via event.
  const [stats, setStats] = useState(() => {
    const todayPomodoros = getStudySessions().filter(
      (s) => s.kind === "pomodoro" && isToday(new Date(s.startedAt))
    );
    return {
      sessions: todayPomodoros.length,
      minutes: todayPomodoros.reduce((sum, s) => sum + s.minutes, 0),
    };
  });

  function refreshStats() {
    const todayPomodoros = getStudySessions().filter(
      (s) => s.kind === "pomodoro" && isToday(new Date(s.startedAt))
    );
    setStats({
      sessions: todayPomodoros.length,
      minutes: todayPomodoros.reduce((sum, s) => sum + s.minutes, 0),
    });
  }

  // Refresh statistik saat sesi berubah di tab ini (event kustom) dan di
  // tab lain (event "storage"). Statistik awal dihitung lazy di initializer.
  useEffect(() => {
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

  // Aksi tombol -----------------------------------------------------------

  function toggleRunning() {
    if (running) {
      // Jeda: simpan sisa waktu agar bisa dilanjutkan.
      setRemainingMs(Math.max(0, (endTimeRef.current ?? Date.now()) - Date.now()));
      endTimeRef.current = null;
      setRunning(false);
    } else {
      // Mulai / lanjut: hitung ulang stempel akhir dari sisa waktu.
      const ms = remainingMs > 0 ? remainingMs : phaseDurationMs(phase, settings);
      setRemainingMs(ms);
      endTimeRef.current = Date.now() + ms;
      setRunning(true);
    }
  }

  function resetTimer() {
    endTimeRef.current = null;
    setRunning(false);
    setRemainingMs(phaseDurationMs(phase, settings));
  }

  function skipPhase() {
    // Lewati fase saat ini. Fokus yang DILEWATI tidak dicatat sebagai sesi
    // dan tidak menambah hitungan menuju istirahat panjang.
    if (phase === "focus") {
      startPhase("break", running);
    } else {
      startPhase("focus", running);
    }
  }

  function applyPreset(key: Exclude<PresetKey, "custom">) {
    const p = PRESETS[key];
    setSettings({
      preset: key,
      focusMin: p.focusMin,
      breakMin: p.breakMin,
      longBreakMin: p.longBreakMin,
    });
  }

  /** Ubah satu durasi kustom (menit) via input. */
  function updateCustom(field: "focusMin" | "breakMin" | "longBreakMin", value: number) {
    const clamped = Math.min(180, Math.max(1, Math.round(value) || 1));
    setSettings({
      ...settings,
      preset: "custom",
      focusMin: field === "focusMin" ? clamped : settings.focusMin,
      breakMin: field === "breakMin" ? clamped : settings.breakMin,
      longBreakMin: field === "longBreakMin" ? clamped : settings.longBreakMin,
    });
  }

  // Turunan -----------------------------------------------------------------

  const totalMs = phaseDurationMs(phase, settings);
  const progressPct = Math.min(
    100,
    Math.max(0, ((totalMs - remainingMs) / totalMs) * 100)
  );
  const isFocus = phase === "focus";
  const cycleDots = FOCUS_PER_LONG_BREAK;
  const filledDots = completedFocus % cycleDots === 0 && completedFocus > 0
    ? cycleDots
    : completedFocus % cycleDots;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Timer className="h-4 w-4" /> Pomodoro
        </CardTitle>
        <CardDescription>
          Fokus penuh, istirahat singkat, ulangi. Setiap {FOCUS_PER_LONG_BREAK} sesi
          fokus kamu mendapat istirahat panjang.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* Pengaturan durasi */}
        <div className="flex flex-wrap items-center gap-2">
          {/* Chips preset cepat */}
          {(Object.keys(PRESETS) as Array<keyof typeof PRESETS>).map((key) => {
            const p = PRESETS[key];
            const active = settings.preset === key;
            return (
              <Button
                key={key}
                size="sm"
                variant={active ? "default" : "secondary"}
                className={cn("h-7 text-xs", active && "font-semibold")}
                onClick={() => applyPreset(key)}
              >
                {p.focusMin}/{p.breakMin}
              </Button>
            );
          })}

          <Select
            value={settings.preset}
            onValueChange={(v) => {
              if (v === "custom") {
                setSettings({ ...settings, preset: "custom" });
              } else {
                applyPreset(v as Exclude<PresetKey, "custom">);
              }
            }}
          >
            <SelectTrigger size="sm" className="h-7 text-xs w-auto">
              <SelectValue placeholder="Preset" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="classic">Klasik 25/5/15</SelectItem>
              <SelectItem value="long">Panjang 50/10/30</SelectItem>
              <SelectItem value="short">Kilat 15/3/10</SelectItem>
              <SelectItem value="custom">Kustom…</SelectItem>
            </SelectContent>
          </Select>

          <div className="ms-auto flex items-center gap-2">
            {stats.sessions > 0 && (
              <span className="text-xs text-muted-foreground">
                {stats.sessions} sesi · {stats.minutes} menit fokus hari ini
              </span>
            )}
            <Button
              size="sm"
              variant="ghost"
              className="h-7 w-7 p-0"
              onClick={() => setSoundOn((v) => !v)}
              title={soundOn ? "Suara aktif" : "Suara mati"}
              aria-label={soundOn ? "Aktifkan suara" : "Matikan suara"}
            >
              {soundOn ? (
                <Volume2 className="h-4 w-4" />
              ) : (
                <VolumeX className="h-4 w-4 text-muted-foreground" />
              )}
            </Button>
          </div>
        </div>

        {/* Input kustom (hanya saat preset kustom) */}
        {settings.preset === "custom" && (
          <div className="grid grid-cols-3 gap-2">
            {(
              [
                ["focusMin", "Fokus (menit)"],
                ["breakMin", "Istirahat (menit)"],
                ["longBreakMin", "Istirahat panjang (menit)"],
              ] as const
            ).map(([field, label]) => (
              <div key={field} className="space-y-1">
                <Label htmlFor={`pomo-${field}`} className="text-xs">
                  {label}
                </Label>
                <Input
                  id={`pomo-${field}`}
                  type="number"
                  min={1}
                  max={180}
                  inputMode="numeric"
                  className="h-8"
                  value={settings[field]}
                  onChange={(e) => updateCustom(field, Number(e.target.value))}
                />
              </div>
            ))}
          </div>
        )}

        {/* Timer besar */}
        <div className="flex flex-col items-center gap-3 py-2">
          <Badge
            variant={isFocus ? "default" : "secondary"}
            className={cn(
              "gap-1",
              !isFocus && "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
            )}
          >
            {isFocus ? <Timer className="h-3 w-3" /> : <Coffee className="h-3 w-3" />}
            {PHASE_LABEL[phase]}
          </Badge>

          <div
            className={cn(
              "font-mono text-5xl font-semibold tabular-nums select-none",
              isFocus ? "text-primary" : "text-emerald-500 dark:text-emerald-400"
            )}
          >
            {formatClock(remainingMs)}
          </div>

          <Progress
            value={progressPct}
            className={cn(
              "h-2",
              !isFocus &&
                "bg-emerald-500/15 [&_[data-slot=progress-indicator]]:bg-emerald-500"
            )}
          />

          {/* Titik siklus: 1 titik = 1 fokus selesai */}
          <div className="flex items-center gap-1.5" aria-label={`Siklus ${filledDots} dari ${cycleDots}`}>
            {Array.from({ length: cycleDots }).map((_, i) => (
              <span
                key={i}
                className={cn(
                  "h-1.5 w-4 rounded-full transition-colors",
                  i < filledDots ? "bg-primary" : "bg-muted"
                )}
              />
            ))}
            <span className="ms-2 text-xs text-muted-foreground">
              {completedFocus} fokus selesai
            </span>
          </div>

          {/* Kontrol */}
          <div className="flex items-center gap-2">
            <Button onClick={toggleRunning} className="min-w-28">
              {running ? (
                <>
                  <Pause className="h-4 w-4" /> Jeda
                </>
              ) : (
                <>
                  <Play className="h-4 w-4" /> Mulai
                </>
              )}
            </Button>
            <Button variant="outline" onClick={resetTimer}>
              <RotateCcw className="h-4 w-4" /> Reset
            </Button>
            <Button variant="outline" onClick={skipPhase}>
              <SkipForward className="h-4 w-4" /> Lewati
            </Button>
          </div>

          <p className="text-xs text-muted-foreground text-center">
            Timer dihitung dari stempel waktu, jadi tetap akurat walau kamu
            pindah tab. Sisa waktu juga tampil di judul tab.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Suara ringan via Web Audio API (oscillator beep singkat, dibungkus try/catch).
// ---------------------------------------------------------------------------

function playBeep(on: boolean) {
  if (!on) return;
  try {
    const Ctx =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = 880; // nada ringan dua nada kecil
    const now = ctx.currentTime;
    gain.gain.setValueAtTime(0.001, now);
    gain.gain.exponentialRampToValueAtTime(0.08, now + 0.05);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.5);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.5);
    // Tutup konteks agar tidak menumpuk.
    window.setTimeout(() => void ctx.close().catch(() => {}), 800);
  } catch {
    // Browser memblokir audio otomatis — abaikan.
  }
}
