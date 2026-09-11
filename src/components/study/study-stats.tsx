"use client"

import * as React from "react"
import { format, subDays } from "date-fns"
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts"
import {
  Download,
  Flame,
  ListChecks,
  Plus,
  Timer,
  TrendingUp,
  Upload,
} from "lucide-react"
import { toast } from "sonner"

import {
  computeStreak,
  getStudySessions,
  loadJSON,
  logStudySession,
  saveJSON,
  todayStudyMinutes,
  useLocalJSON,
  type StudySession,
} from "@/lib/study/store"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Progress } from "@/components/ui/progress"

/* ------------------------------------------------------------------ */
/* Util                                                                */
/* ------------------------------------------------------------------ */

function uid() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID()
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function ChartTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean
  payload?: Array<{ value?: number | string }>
  label?: string | number
}) {
  if (!active || !payload || payload.length === 0) return null
  const v = Number(payload[0]?.value ?? 0)
  return (
    <div className="bg-popover text-popover-foreground rounded-md border px-3 py-1.5 text-xs shadow-md">
      <span className="text-muted-foreground">{label}</span>
      {" · "}
      <span className="font-semibold tabular-nums">{v} menit belajar</span>
    </div>
  )
}

function StatCard({
  title,
  value,
  sub,
  icon,
  progress,
}: {
  title: string
  value: string
  sub: string
  icon: React.ReactNode
  progress?: number
}) {
  return (
    <Card className="gap-2 py-4">
      <CardContent className="flex h-full flex-col gap-1 px-4">
        <div className="text-muted-foreground flex items-center gap-1.5 text-xs font-medium">
          {icon}
          {title}
        </div>
        <p className="text-2xl font-bold tabular-nums">{value}</p>
        {typeof progress === "number" ? (
          <div className="mt-auto flex flex-col gap-1 pt-1">
            <Progress value={Math.min(100, Math.max(0, progress))} className="h-1.5" />
            <p className="text-muted-foreground text-[10px]">{sub}</p>
          </div>
        ) : (
          <p className="text-muted-foreground mt-auto pt-1 text-[10px]">{sub}</p>
        )}
      </CardContent>
    </Card>
  )
}

/* ------------------------------------------------------------------ */
/* Komponen utama                                                     */
/* ------------------------------------------------------------------ */

export function StudyStats() {
  const [goal, setGoal] = useLocalJSON<number>("aula-study:daily-goal", 60)

  const [sessions, setSessions] = React.useState<StudySession[]>([])
  const [todayMin, setTodayMin] = React.useState(0)
  const [streak, setStreak] = React.useState(0)

  const [manualOpen, setManualOpen] = React.useState(false)
  const [manualMinutes, setManualMinutes] = React.useState("30")
  const [manualNote, setManualNote] = React.useState("")

  const [pendingData, setPendingData] = React.useState<Record<
    string,
    string
  > | null>(null)
  const fileRef = React.useRef<HTMLInputElement>(null)

  /* ---- muat ulang statistik (event live + poll ringan + saat fokus) ---- */
  const refresh = React.useCallback(() => {
    setSessions(getStudySessions())
    setTodayMin(todayStudyMinutes())
    setStreak(computeStreak())
  }, [])

  React.useEffect(() => {
    refresh()
    const iv = window.setInterval(refresh, 15000)
    const onUpdate = () => refresh()
    const onStorage = (e: StorageEvent) => {
      if (e.key === null || e.key.startsWith("aula-study:")) refresh()
    }
    window.addEventListener("focus", onUpdate)
    window.addEventListener("aula-study:updated", onUpdate)
    window.addEventListener("storage", onStorage)
    return () => {
      window.clearInterval(iv)
      window.removeEventListener("focus", onUpdate)
      window.removeEventListener("aula-study:updated", onUpdate)
      window.removeEventListener("storage", onStorage)
    }
  }, [refresh])

  /* ---- selebrasi target: sekali per hari ---- */
  React.useEffect(() => {
    if (todayMin <= 0 || goal <= 0 || todayMin < goal) return
    const key = `aula-study:goal-celebrated:${format(new Date(), "yyyy-MM-dd")}`
    if (!loadJSON<boolean>(key, false)) {
      saveJSON(key, true)
      toast.success("🎉 Target harian tercapai! Kerja bagus, pertahankan!")
    }
  }, [todayMin, goal])

  const totalMin = sessions.reduce((a, s) => a + s.minutes, 0)
  const goalPct = goal > 0 ? Math.min(100, (todayMin / goal) * 100) : 0
  const reached = goal > 0 && todayMin >= goal

  /* ---- data grafik 14 hari ---- */
  const chartData = React.useMemo(() => {
    const byDay = new Map<string, number>()
    for (const s of sessions) {
      const key = format(new Date(s.startedAt), "yyyy-MM-dd")
      byDay.set(key, (byDay.get(key) ?? 0) + s.minutes)
    }
    const data: { label: string; menit: number }[] = []
    for (let i = 13; i >= 0; i--) {
      const d = subDays(new Date(), i)
      const key = format(d, "yyyy-MM-dd")
      data.push({ label: format(d, "dd/MM"), menit: byDay.get(key) ?? 0 })
    }
    return data
  }, [sessions])

  /* ---- sesi manual ---- */
  function saveManual() {
    const m = Math.round(Number(manualMinutes))
    if (!Number.isFinite(m) || m < 1 || m > 1440) {
      toast.error("Isi durasi antara 1–1440 menit")
      return
    }
    logStudySession({
      id: uid(),
      startedAt: new Date().toISOString(),
      minutes: m,
      kind: "manual",
      note: manualNote.trim() || undefined,
    })
    setManualOpen(false)
    setManualNote("")
    toast.success(`Sesi belajar ${m} menit dicatat`)
    refresh()
  }

  /* ---- ekspor / impor ---- */
  function exportData() {
    try {
      const data: Record<string, string> = {}
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i)
        if (k && k.startsWith("aula-study:")) {
          data[k] = localStorage.getItem(k) ?? ""
        }
      }
      const blob = new Blob(
        [JSON.stringify({ exportedAt: new Date().toISOString(), data }, null, 2)],
        { type: "application/json" }
      )
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = "aula-belajar-backup.json"
      document.body.appendChild(a)
      a.click()
      a.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 1000)
      toast.success("Cadangan data belajar berhasil diunduh")
    } catch {
      toast.error("Gagal mengekspor data")
    }
  }

  async function onPickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = "" // biar file yang sama bisa dipilih ulang
    if (!file) return
    try {
      const text = await file.text()
      const parsed = JSON.parse(text) as {
        exportedAt?: string
        data?: Record<string, unknown>
      }
      if (
        !parsed ||
        typeof parsed !== "object" ||
        !parsed.data ||
        typeof parsed.data !== "object"
      ) {
        toast.error("File cadangan tidak valid")
        return
      }
      const entries = Object.entries(parsed.data).filter(([k]) =>
        k.startsWith("aula-study:")
      )
      if (entries.length === 0) {
        toast.error("Tidak ada data aula-study di file ini")
        return
      }
      setPendingData(
        Object.fromEntries(
          entries.map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)])
        )
      )
    } catch {
      toast.error("Gagal membaca file")
    }
  }

  function applyRestore() {
    if (!pendingData) return
    for (const [k, v] of Object.entries(pendingData)) {
      window.localStorage.setItem(k, v)
    }
    setPendingData(null)
    toast.success("Data dipulihkan")
    window.setTimeout(() => window.location.reload(), 800)
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Kartu statistik */}
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <StatCard
          title="Menit hari ini"
          value={String(todayMin)}
          sub={`dari ${goal} menit target`}
          icon={<Timer className="size-3.5" />}
          progress={goalPct}
        />
        <StatCard
          title="Streak"
          value={`${streak} hari`}
          sub="belajar berturut-turut"
          icon={<Flame className="size-3.5 text-orange-500" />}
        />
        <StatCard
          title="Total sesi"
          value={String(sessions.length)}
          sub="semua waktu"
          icon={<ListChecks className="size-3.5" />}
        />
        <StatCard
          title="Total menit"
          value={String(totalMin)}
          sub={totalMin >= 60 ? `≈ ${(totalMin / 60).toFixed(1)} jam belajar` : "kumpulkan terus!"}
          icon={<TrendingUp className="size-3.5" />}
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        {/* Grafik */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Aktivitas 14 Hari Terakhir</CardTitle>
            <CardDescription>Total menit belajar per hari</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="h-[220px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={chartData}
                  margin={{ top: 4, right: 4, left: -24, bottom: 0 }}
                >
                  <CartesianGrid
                    strokeDasharray="3 3"
                    vertical={false}
                    stroke="var(--border)"
                    opacity={0.6}
                  />
                  <XAxis
                    dataKey="label"
                    tickLine={false}
                    axisLine={false}
                    tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
                    interval={0}
                    angle={-45}
                    textAnchor="end"
                    height={34}
                  />
                  <YAxis
                    tickLine={false}
                    axisLine={false}
                    tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
                    allowDecimals={false}
                  />
                  <Tooltip
                    content={<ChartTooltip />}
                    cursor={{ fill: "var(--accent)", opacity: 0.5 }}
                  />
                  <Bar
                    dataKey="menit"
                    fill="var(--primary)"
                    radius={[4, 4, 0, 0]}
                    maxBarSize={26}
                  />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>

        {/* Target harian */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Target Harian</CardTitle>
            <CardDescription>
              Seberapa lama kamu ingin belajar setiap hari?
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="flex flex-wrap items-end gap-3">
              <div className="flex w-32 flex-col gap-1.5">
                <Label htmlFor="daily-goal" className="text-xs">
                  Target (menit/hari)
                </Label>
                <Input
                  id="daily-goal"
                  type="number"
                  min={1}
                  max={1440}
                  value={goal}
                  onChange={(e) => {
                    const v = Number(e.target.value)
                    setGoal(
                      Number.isFinite(v) && v >= 1
                        ? Math.min(1440, Math.round(v))
                        : 1
                    )
                  }}
                />
              </div>
              <div className="flex min-w-48 flex-1 flex-col gap-1.5">
                <div className="flex justify-between text-xs">
                  <span className="text-muted-foreground">Progres hari ini</span>
                  <span className="font-medium tabular-nums">
                    {todayMin}/{goal} menit
                  </span>
                </div>
                <Progress value={goalPct} className="h-2" />
                {reached ? (
                  <p className="text-xs font-medium text-emerald-600 dark:text-emerald-400">
                    🎉 Target tercapai hari ini — hebat!
                  </p>
                ) : (
                  <p className="text-muted-foreground text-xs">
                    Sisa {Math.max(0, goal - todayMin)} menit lagi. Semangat!
                  </p>
                )}
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={() => setManualOpen(true)}>
                <Plus className="size-4" />
                Tambah sesi manual
              </Button>
              <Button variant="outline" onClick={exportData}>
                <Download className="size-4" />
                Unduh JSON
              </Button>
              <Button
                variant="outline"
                onClick={() => fileRef.current?.click()}
              >
                <Upload className="size-4" />
                Pulihkan
              </Button>
              <input
                ref={fileRef}
                type="file"
                accept=".json,application/json"
                className="hidden"
                onChange={onPickFile}
              />
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Dialog sesi manual */}
      <Dialog open={manualOpen} onOpenChange={setManualOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Tambah Sesi Manual</DialogTitle>
            <DialogDescription>
              Catat waktu belajar yang lupa kamu timer.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="manual-minutes">Durasi (menit)</Label>
              <Input
                id="manual-minutes"
                type="number"
                min={1}
                max={1440}
                value={manualMinutes}
                onChange={(e) => setManualMinutes(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="manual-note">Catatan (opsional)</Label>
              <Input
                id="manual-note"
                placeholder="mis. Belajar bab pecahan"
                value={manualNote}
                onChange={(e) => setManualNote(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && saveManual()}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setManualOpen(false)}>
              Batal
            </Button>
            <Button onClick={saveManual}>Simpan</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Konfirmasi pulihkan */}
      <AlertDialog
        open={pendingData !== null}
        onOpenChange={(o) => !o && setPendingData(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Pulihkan data belajar?</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingData ? Object.keys(pendingData).length : 0} kunci data
              akan ditimpa dengan isi file cadangan. Halaman akan dimuat ulang
              setelah dipulihkan.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Batal</AlertDialogCancel>
            <AlertDialogAction onClick={applyRestore}>
              Ya, pulihkan
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
