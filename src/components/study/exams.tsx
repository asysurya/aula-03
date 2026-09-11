"use client"

import * as React from "react"
import { differenceInCalendarDays, format, parseISO } from "date-fns"
import { id as idLocale } from "date-fns/locale"
import { CalendarDays, Clock, Pencil, Plus, Trash2 } from "lucide-react"
import { toast } from "sonner"

import { useLocalJSON } from "@/lib/study/store"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardAction,
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
/* Tipe & util                                                        */
/* ------------------------------------------------------------------ */

type Exam = {
  id: string
  name: string
  date: string // YYYY-MM-DD
  note?: string
  createdAt: string
}

type Day = "Sen" | "Sel" | "Rab" | "Kam" | "Jum" | "Sab" | "Min"

type Slot = {
  id: string
  day: Day
  start: string // HH:MM
  end: string // HH:MM
  subject: string
}

type Timetable = { slots: Slot[] }

const DAYS: Day[] = ["Sen", "Sel", "Rab", "Kam", "Jum", "Sab", "Min"]

function uid() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID()
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function useMounted() {
  const [mounted, setMounted] = React.useState(false)
  React.useEffect(() => setMounted(true), [])
  return mounted
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number)
  return (h || 0) * 60 + (m || 0)
}

function fmtDur(min: number): string {
  if (min <= 0) return "—"
  if (min < 60) return `${min} mnt`
  const h = Math.floor(min / 60)
  const m = min % 60
  return m === 0 ? `${h} jam` : `${h}j ${m}m`
}

/* ------------------------------------------------------------------ */
/* 1. Countdown Ujian                                                 */
/* ------------------------------------------------------------------ */

function CountdownCard() {
  const [exams, setExams] = useLocalJSON<Exam[]>("aula-study:exams", [])
  const [open, setOpen] = React.useState(false)
  const [editId, setEditId] = React.useState<string | null>(null)
  const [name, setName] = React.useState("")
  const [date, setDate] = React.useState("")
  const [note, setNote] = React.useState("")
  const mounted = useMounted()

  const sorted = React.useMemo(
    () => [...exams].sort((a, b) => a.date.localeCompare(b.date)),
    [exams]
  )

  function openAdd() {
    setEditId(null)
    setName("")
    setDate("")
    setNote("")
    setOpen(true)
  }

  function openEdit(e: Exam) {
    setEditId(e.id)
    setName(e.name)
    setDate(e.date)
    setNote(e.note ?? "")
    setOpen(true)
  }

  function save() {
    if (!name.trim()) {
      toast.error("Nama ujian tidak boleh kosong")
      return
    }
    if (!date) {
      toast.error("Pilih tanggal ujiannya")
      return
    }
    if (editId) {
      setExams((prev) =>
        prev.map((e) =>
          e.id === editId
            ? { ...e, name: name.trim(), date, note: note.trim() || undefined }
            : e
        )
      )
      toast.success("Jadwal ujian diperbarui")
    } else {
      setExams((prev) => [
        ...prev,
        {
          id: uid(),
          name: name.trim(),
          date,
          note: note.trim() || undefined,
          createdAt: new Date().toISOString(),
        },
      ])
      toast.success("Ujian ditambahkan ke countdown")
    }
    setOpen(false)
  }

  function remove(id: string) {
    setExams((prev) => prev.filter((e) => e.id !== id))
    toast.success("Ujian dihapus")
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <CalendarDays className="size-4" />
          Countdown Ujian
        </CardTitle>
        <CardDescription>
          Pantau berapa hari lagi ujianmu akan tiba.
        </CardDescription>
        <CardAction>
          <Button size="sm" onClick={openAdd}>
            <Plus className="size-4" />
            Ujian
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {sorted.length === 0 ? (
          <div className="text-muted-foreground flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed py-10 text-sm">
            <CalendarDays className="size-6 opacity-40" />
            <span>Belum ada ujian. Tambahkan tanggal ujian untuk mulai hitung mundur.</span>
          </div>
        ) : (
          sorted.map((e) => {
            const days = mounted
              ? differenceInCalendarDays(parseISO(e.date), new Date())
              : null
            const past = days !== null && days < 0

            // Persentase waktu berlalu: dari tanggal ditambahkan → tanggal ujian
            let pct = 0
            if (mounted) {
              const start = new Date(e.createdAt).getTime()
              const target = parseISO(e.date).getTime()
              const now = Date.now()
              if (target <= start) {
                pct = 100
              } else {
                pct = Math.min(
                  100,
                  Math.max(0, ((now - start) / (target - start)) * 100)
                )
              }
            }

            return (
              <div
                key={e.id}
                className={cn(
                  "rounded-lg border p-3 transition-opacity",
                  past && "opacity-60"
                )}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-semibold">{e.name}</p>
                    <p className="text-muted-foreground mt-0.5 text-xs capitalize">
                      {format(parseISO(e.date), "EEEE, d MMM yyyy", {
                        locale: idLocale,
                      })}
                    </p>
                    {e.note && (
                      <p className="text-muted-foreground mt-1 text-xs italic">
                        {e.note}
                      </p>
                    )}
                    <div className="mt-2.5 flex items-center gap-2">
                      <Progress value={pct} className="h-1.5 flex-1" />
                      <span className="text-muted-foreground w-24 text-right text-[10px] whitespace-nowrap tabular-nums">
                        {Math.round(pct)}% waktu berlalu
                      </span>
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1.5">
                    <div className="text-right">
                      {days === null ? (
                        <span className="text-muted-foreground text-2xl font-bold">
                          …
                        </span>
                      ) : days > 0 ? (
                        <>
                          <span className="text-2xl font-bold tabular-nums">
                            {days}
                          </span>
                          <span className="text-muted-foreground ml-1 text-xs">
                            hari lagi
                          </span>
                        </>
                      ) : days === 0 ? (
                        <span className="text-2xl font-bold text-destructive">
                          Hari ini!
                        </span>
                      ) : (
                        <span className="text-muted-foreground text-2xl font-bold">
                          Lewat
                        </span>
                      )}
                    </div>
                    {days !== null && days >= 0 && (
                      <>
                        {days <= 3 ? (
                          <Badge variant="destructive">Penting!</Badge>
                        ) : days <= 7 ? (
                          <Badge className="border-transparent bg-amber-500/15 text-amber-700 dark:text-amber-400">
                            Segera
                          </Badge>
                        ) : (
                          <Badge variant="secondary">{days} hari lagi</Badge>
                        )}
                      </>
                    )}
                    <div className="flex gap-0.5">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-7"
                        title="Ubah ujian"
                        onClick={() => openEdit(e)}
                      >
                        <Pencil className="size-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="text-destructive size-7 hover:text-destructive"
                        title="Hapus ujian"
                        onClick={() => remove(e.id)}
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
            )
          })
        )}
      </CardContent>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editId ? "Ubah Ujian" : "Ujian Baru"}</DialogTitle>
            <DialogDescription>
              Catat nama dan tanggal ujian agar kamu bisa menyiapkan diri.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="exam-name">Nama ujian</Label>
              <Input
                id="exam-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="mis. UTS Matematika"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="exam-date">Tanggal ujian</Label>
              <Input
                id="exam-date"
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="exam-note">Catatan (opsional)</Label>
              <Input
                id="exam-note"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="mis. Bab 1–5, bawa kalkulator"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Batal
            </Button>
            <Button onClick={save}>Simpan</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}

/* ------------------------------------------------------------------ */
/* 2. Jadwal Belajar Mingguan                                         */
/* ------------------------------------------------------------------ */

function TimetableCard() {
  const [table, setTable] = useLocalJSON<Timetable>("aula-study:timetable", {
    slots: [],
  })
  const [day, setDay] = React.useState<Day>("Sen")
  const [start, setStart] = React.useState("16:00")
  const [end, setEnd] = React.useState("17:00")
  const [subject, setSubject] = React.useState("")

  const daySlots = React.useMemo(
    () =>
      table.slots
        .filter((s) => s.day === day)
        .sort((a, b) => a.start.localeCompare(b.start)),
    [table.slots, day]
  )

  const summary = DAYS.map((d) => {
    const slots = table.slots.filter((s) => s.day === d)
    const total = slots.reduce(
      (acc, s) => acc + Math.max(0, toMinutes(s.end) - toMinutes(s.start)),
      0
    )
    return { day: d, count: slots.length, total }
  })

  const weekTotal = summary.reduce((a, s) => a + s.total, 0)

  function addSlot() {
    if (!subject.trim()) {
      toast.error("Isi mata pelajarannya dulu")
      return
    }
    if (!start || !end) {
      toast.error("Isi jam mulai dan jam selesai")
      return
    }
    if (end <= start) {
      toast.error("Jam selesai harus setelah jam mulai")
      return
    }
    setTable((prev) => ({
      slots: [
        ...prev.slots,
        { id: uid(), day, start, end, subject: subject.trim() },
      ],
    }))
    setSubject("")
    toast.success(`Jadwal ${day} ditambahkan`)
  }

  function removeSlot(id: string) {
    setTable((prev) => ({ slots: prev.slots.filter((s) => s.id !== id) }))
    toast.success("Jadwal dihapus")
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Clock className="size-4" />
          Jadwal Belajar Mingguan
        </CardTitle>
        <CardDescription>
          Susun rutinitas belajarmu — total {table.slots.length} slot,{" "}
          {fmtDur(weekTotal)} per pekan.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {/* Chip pilih hari */}
        <div className="flex flex-wrap gap-1.5">
          {DAYS.map((d) => (
            <Button
              key={d}
              size="sm"
              variant={d === day ? "default" : "outline"}
              className="h-8 px-3"
              onClick={() => setDay(d)}
            >
              {d}
            </Button>
          ))}
        </div>

        {/* Slot hari terpilih */}
        {daySlots.length === 0 ? (
          <div className="text-muted-foreground rounded-lg border border-dashed py-6 text-center text-sm">
            Belum ada jadwal pada hari {day}. Tambahkan lewat formulir di bawah.
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {daySlots.map((s) => (
              <div key={s.id} className="flex items-center gap-3 rounded-lg border p-3">
                <div className="flex items-center gap-1.5 text-sm font-medium tabular-nums">
                  <Clock className="text-muted-foreground size-3.5" />
                  {s.start}–{s.end}
                </div>
                <p className="min-w-0 flex-1 truncate text-sm">{s.subject}</p>
                <span className="text-muted-foreground text-xs tabular-nums">
                  {toMinutes(s.end) - toMinutes(s.start)} mnt
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  className="text-destructive size-7 hover:text-destructive"
                  title="Hapus jadwal"
                  onClick={() => removeSlot(s.id)}
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
            ))}
          </div>
        )}

        {/* Form tambah */}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-[1fr_1fr_2fr_auto]">
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs">Mulai</Label>
            <Input
              type="time"
              value={start}
              onChange={(e) => setStart(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs">Selesai</Label>
            <Input
              type="time"
              value={end}
              onChange={(e) => setEnd(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs">Mata pelajaran</Label>
            <Input
              placeholder="mis. Matematika"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addSlot()}
            />
          </div>
          <div className="flex items-end">
            <Button className="w-full" onClick={addSlot}>
              <Plus className="size-4" />
              Tambah
            </Button>
          </div>
        </div>

        {/* Ringkasan 7 hari */}
        <div>
          <p className="text-muted-foreground mb-1.5 text-xs font-medium">
            Ringkasan pekan
          </p>
          <div className="grid grid-cols-4 gap-1.5 sm:grid-cols-7">
            {summary.map((s) => (
              <button
                key={s.day}
                type="button"
                onClick={() => setDay(s.day)}
                className={cn(
                  "rounded-lg border p-2 text-center transition-colors hover:bg-accent",
                  s.day === day && "border-primary/50 bg-primary/5"
                )}
              >
                <p className="text-xs font-semibold">{s.day}</p>
                <p className="text-muted-foreground mt-0.5 text-[10px]">
                  {s.count} slot
                </p>
                <p className="text-[10px] font-medium">{fmtDur(s.total)}</p>
              </button>
            ))}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

/* ------------------------------------------------------------------ */
/* Komponen utama                                                     */
/* ------------------------------------------------------------------ */

export function ExamsPanel() {
  return (
    <div className="flex flex-col gap-4">
      <CountdownCard />
      <TimetableCard />
    </div>
  )
}
