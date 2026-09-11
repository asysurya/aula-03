"use client"

import * as React from "react"
import { format, parseISO } from "date-fns"
import { id as idLocale } from "date-fns/locale"
import {
  ArrowRight,
  BookMarked,
  BookX,
  Brain,
  CheckCircle2,
  Eye,
  ListChecks,
  NotebookPen,
  Pencil,
  Pin,
  Plus,
  Search,
  Trash2,
} from "lucide-react"
import { toast } from "sonner"

import { useLocalJSON } from "@/lib/study/store"
import { cn } from "@/lib/utils"
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
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"

/* ------------------------------------------------------------------ */
/* Tipe & util bersama                                                */
/* ------------------------------------------------------------------ */

type Note = {
  id: string
  title: string
  body: string
  pinned: boolean
  updatedAt: string
}

type Priority = "tinggi" | "sedang" | "rendah"

type Todo = {
  id: string
  text: string
  done: boolean
  priority: Priority
  due?: string
}

type GlossaryItem = {
  id: string
  term: string
  definition: string
}

type ErrorItem = {
  id: string
  question: string
  myAnswer: string
  correctAnswer: string
  source?: string
  createdAt: string
  mastered: boolean
}

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

function EmptyHint({
  icon: Icon,
  text,
}: {
  icon: React.ComponentType<{ className?: string }>
  text: string
}) {
  return (
    <div className="text-muted-foreground flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed py-10 text-sm">
      <Icon className="size-6 opacity-40" />
      <span className="text-center">{text}</span>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* 1. Catatan                                                         */
/* ------------------------------------------------------------------ */

function NotesTab({
  notes,
  setNotes,
}: {
  notes: Note[]
  setNotes: React.Dispatch<React.SetStateAction<Note[]>>
}) {
  const [query, setQuery] = React.useState("")
  const [open, setOpen] = React.useState(false)
  const [editId, setEditId] = React.useState<string | null>(null)
  const [title, setTitle] = React.useState("")
  const [body, setBody] = React.useState("")
  const [confirmId, setConfirmId] = React.useState<string | null>(null)

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase()
    return notes
      .filter(
        (n) =>
          !q ||
          n.title.toLowerCase().includes(q) ||
          n.body.toLowerCase().includes(q)
      )
      .sort(
        (a, b) =>
          Number(b.pinned) - Number(a.pinned) ||
          new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
      )
  }, [notes, query])

  function openAdd() {
    setEditId(null)
    setTitle("")
    setBody("")
    setOpen(true)
  }

  function openEdit(n: Note) {
    setEditId(n.id)
    setTitle(n.title)
    setBody(n.body)
    setOpen(true)
  }

  function save() {
    if (!title.trim()) {
      toast.error("Judul catatan tidak boleh kosong")
      return
    }
    if (editId) {
      setNotes((prev) =>
        prev.map((n) =>
          n.id === editId
            ? {
                ...n,
                title: title.trim(),
                body,
                updatedAt: new Date().toISOString(),
              }
            : n
        )
      )
      toast.success("Catatan diperbarui")
    } else {
      setNotes((prev) => [
        {
          id: uid(),
          title: title.trim(),
          body,
          pinned: false,
          updatedAt: new Date().toISOString(),
        },
        ...prev,
      ])
      toast.success("Catatan ditambahkan")
    }
    setOpen(false)
  }

  function togglePin(id: string) {
    setNotes((prev) =>
      prev.map((n) => (n.id === id ? { ...n, pinned: !n.pinned } : n))
    )
  }

  const confirmNote = notes.find((n) => n.id === confirmId)

  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search className="text-muted-foreground absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Cari judul atau isi catatan…"
            className="pl-8"
          />
        </div>
        <Button onClick={openAdd}>
          <Plus className="size-4" />
          Catatan
        </Button>
      </div>

      {filtered.length === 0 ? (
        <EmptyHint
          icon={NotebookPen}
          text={
            notes.length === 0
              ? "Belum ada catatan. Klik “Catatan” untuk membuat catatan pertamamu."
              : "Tidak ada catatan yang cocok dengan pencarian."
          }
        />
      ) : (
        <div className="flex flex-col gap-2">
          {filtered.map((n) => (
            <div
              key={n.id}
              className={cn(
                "rounded-lg border p-3",
                n.pinned && "border-primary/40 bg-primary/5"
              )}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold">{n.title}</p>
                  <p className="text-muted-foreground mt-0.5 text-xs">
                    Diubah{" "}
                    {format(parseISO(n.updatedAt), "d MMM yyyy HH:mm", {
                      locale: idLocale,
                    })}
                  </p>
                </div>
                <div className="flex shrink-0 gap-0.5">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7"
                    title={n.pinned ? "Lepas sematan" : "Sematkan catatan"}
                    onClick={() => togglePin(n.id)}
                  >
                    <Pin
                      className={cn(
                        "size-3.5",
                        n.pinned && "fill-primary text-primary"
                      )}
                    />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7"
                    title="Ubah catatan"
                    onClick={() => openEdit(n)}
                  >
                    <Pencil className="size-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="text-destructive size-7 hover:text-destructive"
                    title="Hapus catatan"
                    onClick={() => setConfirmId(n.id)}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              </div>
              {n.body && (
                <p className="mt-2 line-clamp-6 whitespace-pre-wrap text-sm">
                  {n.body}
                </p>
              )}
            </div>
          ))}
        </div>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {editId ? "Ubah Catatan" : "Catatan Baru"}
            </DialogTitle>
            <DialogDescription>
              Catatan tersimpan otomatis di perangkatmu.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="note-title">Judul</Label>
              <Input
                id="note-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="mis. Rumus luas bangun datar"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="note-body">Isi catatan</Label>
              <Textarea
                id="note-body"
                value={body}
                onChange={(e) => setBody(e.target.value)}
                placeholder="Tulis catatanmu di sini…"
                rows={6}
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

      <AlertDialog
        open={confirmId !== null}
        onOpenChange={(o) => !o && setConfirmId(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Hapus catatan ini?</AlertDialogTitle>
            <AlertDialogDescription>
              Catatan “{confirmNote?.title}” akan dihapus permanen dari
              perangkatmu.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Batal</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={() => {
                if (confirmId) {
                  setNotes((prev) => prev.filter((n) => n.id !== confirmId))
                  toast.success("Catatan dihapus")
                }
                setConfirmId(null)
              }}
            >
              Hapus
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* 2. To-do Belajar                                                   */
/* ------------------------------------------------------------------ */

const TODO_FILTERS = [
  { value: "semua", label: "Semua" },
  { value: "belum", label: "Belum" },
  { value: "selesai", label: "Selesai" },
] as const

const PRIO_RANK: Record<Priority, number> = {
  tinggi: 0,
  sedang: 1,
  rendah: 2,
}

function PriorityBadge({ priority }: { priority: Priority }) {
  if (priority === "tinggi") {
    return <Badge variant="destructive">Tinggi</Badge>
  }
  if (priority === "sedang") {
    return (
      <Badge className="border-transparent bg-amber-500/15 text-amber-700 dark:text-amber-400">
        Sedang
      </Badge>
    )
  }
  return <Badge variant="secondary">Rendah</Badge>
}

function TodosTab({
  todos,
  setTodos,
}: {
  todos: Todo[]
  setTodos: React.Dispatch<React.SetStateAction<Todo[]>>
}) {
  const [text, setText] = React.useState("")
  const [priority, setPriority] = React.useState<Priority>("sedang")
  const [due, setDue] = React.useState("")
  const [filter, setFilter] =
    React.useState<(typeof TODO_FILTERS)[number]["value"]>("semua")
  const mounted = useMounted()
  const today = mounted ? format(new Date(), "yyyy-MM-dd") : ""

  const doneCount = todos.filter((t) => t.done).length

  const visible = React.useMemo(() => {
    return todos
      .filter((t) =>
        filter === "semua" ? true : filter === "belum" ? !t.done : t.done
      )
      .sort(
        (a, b) =>
          Number(a.done) - Number(b.done) ||
          PRIO_RANK[a.priority] - PRIO_RANK[b.priority]
      )
  }, [todos, filter])

  function add() {
    if (!text.trim()) {
      toast.error("Tulis dulu tugasnya")
      return
    }
    setTodos((prev) => [
      ...prev,
      {
        id: uid(),
        text: text.trim(),
        done: false,
        priority,
        due: due || undefined,
      },
    ])
    setText("")
    setDue("")
    toast.success("Tugas ditambahkan")
  }

  function toggle(id: string) {
    setTodos((prev) =>
      prev.map((t) => (t.id === id ? { ...t, done: !t.done } : t))
    )
  }

  function remove(id: string) {
    setTodos((prev) => prev.filter((t) => t.id !== id))
    toast.success("Tugas dihapus")
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Tambah cepat */}
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input
          className="flex-1"
          placeholder="Tugas baru, mis. Latihan soal hal. 12"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
        />
        <div className="flex gap-2">
          <Select value={priority} onValueChange={(v) => setPriority(v as Priority)}>
            <SelectTrigger className="w-[105px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="tinggi">Tinggi</SelectItem>
              <SelectItem value="sedang">Sedang</SelectItem>
              <SelectItem value="rendah">Rendah</SelectItem>
            </SelectContent>
          </Select>
          <Input
            type="date"
            value={due}
            onChange={(e) => setDue(e.target.value)}
            className="w-[150px]"
            title="Tenggat (opsional)"
          />
          <Button onClick={add}>
            <Plus className="size-4" />
            Tambah
          </Button>
        </div>
      </div>

      {/* Filter + progres */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="bg-muted flex gap-1 rounded-lg p-1">
          {TODO_FILTERS.map((f) => (
            <Button
              key={f.value}
              size="sm"
              variant={filter === f.value ? "secondary" : "ghost"}
              className="h-7 px-2.5 text-xs"
              onClick={() => setFilter(f.value)}
            >
              {f.label}
            </Button>
          ))}
        </div>
        <span className="text-muted-foreground text-xs font-medium tabular-nums">
          {doneCount}/{todos.length} selesai
        </span>
      </div>
      <Progress
        value={todos.length ? (doneCount / todos.length) * 100 : 0}
        className="h-1.5"
      />

      {/* Daftar */}
      {visible.length === 0 ? (
        <EmptyHint
          icon={ListChecks}
          text={
            todos.length === 0
              ? "Belum ada tugas. Tambahkan tugas belajarmu di atas."
              : "Tidak ada tugas pada filter ini."
          }
        />
      ) : (
        <div className="flex flex-col gap-2">
          {visible.map((t) => {
            const late = Boolean(t.due && !t.done && today && t.due < today)
            return (
              <div key={t.id} className="flex items-start gap-2.5 rounded-lg border p-3">
                <Checkbox
                  checked={t.done}
                  onCheckedChange={() => toggle(t.id)}
                  className="mt-0.5"
                />
                <div className="min-w-0 flex-1">
                  <p
                    className={cn(
                      "text-sm",
                      t.done && "text-muted-foreground line-through"
                    )}
                  >
                    {t.text}
                  </p>
                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                    <PriorityBadge priority={t.priority} />
                    {t.due && (
                      <span
                        className={cn(
                          "text-muted-foreground text-xs",
                          late && "font-semibold text-destructive"
                        )}
                      >
                        Tenggat{" "}
                        {format(parseISO(t.due), "d MMM", { locale: idLocale })}
                      </span>
                    )}
                    {late && <Badge variant="destructive">Terlambat</Badge>}
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="text-destructive size-7 hover:text-destructive"
                  title="Hapus tugas"
                  onClick={() => remove(t.id)}
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* 3. Kamus Istilah                                                   */
/* ------------------------------------------------------------------ */

function GlossaryTab({
  items,
  setItems,
}: {
  items: GlossaryItem[]
  setItems: React.Dispatch<React.SetStateAction<GlossaryItem[]>>
}) {
  const [query, setQuery] = React.useState("")
  const [open, setOpen] = React.useState(false)
  const [editId, setEditId] = React.useState<string | null>(null)
  const [term, setTerm] = React.useState("")
  const [definition, setDefinition] = React.useState("")

  // Mode Uji Ingatan
  const [quizOn, setQuizOn] = React.useState(false)
  const [currentId, setCurrentId] = React.useState<string | null>(null)
  const [revealed, setRevealed] = React.useState(false)
  const [learned, setLearned] = React.useState(0)

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase()
    return items.filter(
      (g) =>
        !q ||
        g.term.toLowerCase().includes(q) ||
        g.definition.toLowerCase().includes(q)
    )
  }, [items, query])

  const current = items.find((g) => g.id === currentId) ?? null

  function pickRandom() {
    if (items.length === 0) return
    let next = Math.floor(Math.random() * items.length)
    if (items.length > 1 && items[next].id === currentId) {
      next = (next + 1) % items.length
    }
    setCurrentId(items[next].id)
    setRevealed(false)
  }

  function startQuiz() {
    setQuizOn(true)
    setLearned(0)
    setRevealed(false)
    pickRandom()
  }

  function openAdd() {
    setEditId(null)
    setTerm("")
    setDefinition("")
    setOpen(true)
  }

  function openEdit(g: GlossaryItem) {
    setEditId(g.id)
    setTerm(g.term)
    setDefinition(g.definition)
    setOpen(true)
  }

  function save() {
    if (!term.trim() || !definition.trim()) {
      toast.error("Istilah dan artinya wajib diisi")
      return
    }
    if (editId) {
      setItems((prev) =>
        prev.map((g) =>
          g.id === editId
            ? { ...g, term: term.trim(), definition: definition.trim() }
            : g
        )
      )
      toast.success("Istilah diperbarui")
    } else {
      setItems((prev) => [
        ...prev,
        { id: uid(), term: term.trim(), definition: definition.trim() },
      ])
      toast.success("Istilah ditambahkan ke kamus")
    }
    setOpen(false)
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search className="text-muted-foreground absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Cari istilah…"
            className="pl-8"
          />
        </div>
        <Button
          variant="outline"
          disabled={items.length === 0}
          title={
            items.length === 0
              ? "Tambahkan istilah dulu untuk bisa berlatih"
              : "Latih ingatanmu dengan kartu acak"
          }
          onClick={startQuiz}
        >
          <Brain className="size-4" />
          Uji Ingatan
        </Button>
        <Button onClick={openAdd}>
          <Plus className="size-4" />
          Istilah
        </Button>
      </div>

      {quizOn && (
        <Card className="gap-3 border-primary/30 py-4">
          <CardContent className="flex flex-col items-center gap-3 text-center">
            <Badge variant="secondary">Mode Uji Ingatan</Badge>
            {current ? (
              <>
                <p className="text-primary text-xl font-bold">{current.term}</p>
                {revealed ? (
                  <p className="text-foreground min-h-10 text-sm">
                    {current.definition}
                  </p>
                ) : (
                  <p className="text-muted-foreground/70 min-h-10 text-sm italic">
                    Coba ingat artinya dulu…
                  </p>
                )}
                <div className="flex flex-wrap justify-center gap-2">
                  {revealed ? (
                    <Button
                      onClick={() => {
                        setLearned((l) => l + 1)
                        pickRandom()
                      }}
                    >
                      Kartu berikutnya
                      <ArrowRight className="size-4" />
                    </Button>
                  ) : (
                    <Button onClick={() => setRevealed(true)}>
                      <Eye className="size-4" />
                      Tampilkan arti
                    </Button>
                  )}
                  <Button
                    variant="outline"
                    onClick={() => {
                      setQuizOn(false)
                      setCurrentId(null)
                      setRevealed(false)
                    }}
                  >
                    Keluar
                  </Button>
                </div>
                <p className="text-muted-foreground text-xs">
                  Dipelajari sesi ini: {learned}
                </p>
              </>
            ) : (
              <p className="text-muted-foreground text-sm">
                Belum ada istilah untuk dilatih.
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {filtered.length === 0 ? (
        <EmptyHint
          icon={BookMarked}
          text={
            items.length === 0
              ? "Kamus masih kosong. Tambahkan istilah pelajaran yang sering kamu lupakan."
              : "Tidak ada istilah yang cocok dengan pencarian."
          }
        />
      ) : (
        <div className="flex flex-col gap-2">
          {filtered.map((g) => (
            <div key={g.id} className="rounded-lg border p-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm font-semibold">{g.term}</p>
                  <p className="text-muted-foreground mt-1 text-sm">
                    {g.definition}
                  </p>
                </div>
                <div className="flex shrink-0 gap-0.5">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7"
                    title="Ubah istilah"
                    onClick={() => openEdit(g)}
                  >
                    <Pencil className="size-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="text-destructive size-7 hover:text-destructive"
                    title="Hapus istilah"
                    onClick={() => {
                      setItems((prev) => prev.filter((x) => x.id !== g.id))
                      toast.success("Istilah dihapus")
                    }}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editId ? "Ubah Istilah" : "Istilah Baru"}</DialogTitle>
            <DialogDescription>
              Simpan arti istilah agar mudah kamu lihat kembali.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="gloss-term">Istilah</Label>
              <Input
                id="gloss-term"
                value={term}
                onChange={(e) => setTerm(e.target.value)}
                placeholder="mis. Fotosintesis"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="gloss-def">Arti / definisi</Label>
              <Textarea
                id="gloss-def"
                value={definition}
                onChange={(e) => setDefinition(e.target.value)}
                placeholder="mis. Proses tumbuhan membuat makanan dengan bantuan cahaya matahari"
                rows={3}
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
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* 4. Buku Kesalahan                                                  */
/* ------------------------------------------------------------------ */

function ErrorBookTab({
  items,
  setItems,
}: {
  items: ErrorItem[]
  setItems: React.Dispatch<React.SetStateAction<ErrorItem[]>>
}) {
  const [onlyUnmastered, setOnlyUnmastered] = React.useState(true)
  const [open, setOpen] = React.useState(false)
  const [question, setQuestion] = React.useState("")
  const [myAnswer, setMyAnswer] = React.useState("")
  const [correctAnswer, setCorrectAnswer] = React.useState("")
  const [source, setSource] = React.useState("")

  const unmastered = items.filter((i) => !i.mastered).length

  const visible = onlyUnmastered
    ? items.filter((i) => !i.mastered)
    : items

  function openAdd() {
    setQuestion("")
    setMyAnswer("")
    setCorrectAnswer("")
    setSource("")
    setOpen(true)
  }

  function save() {
    if (!question.trim() || !correctAnswer.trim()) {
      toast.error("Isi soal dan jawaban benarnya")
      return
    }
    setItems((prev) => [
      {
        id: uid(),
        question: question.trim(),
        myAnswer: myAnswer.trim(),
        correctAnswer: correctAnswer.trim(),
        source: source.trim() || undefined,
        createdAt: new Date().toISOString(),
        mastered: false,
      },
      ...prev,
    ])
    toast.success("Soal salah dicatat — jangan lupa di-review!")
    setOpen(false)
  }

  function toggleMastered(id: string) {
    setItems((prev) =>
      prev.map((i) => (i.id === id ? { ...i, mastered: !i.mastered } : i))
    )
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="bg-muted flex gap-1 rounded-lg p-1">
          <Button
            size="sm"
            variant={onlyUnmastered ? "secondary" : "ghost"}
            className="h-7 px-2.5 text-xs"
            onClick={() => setOnlyUnmastered(true)}
          >
            Belum dikuasai ({unmastered})
          </Button>
          <Button
            size="sm"
            variant={!onlyUnmastered ? "secondary" : "ghost"}
            className="h-7 px-2.5 text-xs"
            onClick={() => setOnlyUnmastered(false)}
          >
            Semua ({items.length})
          </Button>
        </div>
        <Button onClick={openAdd}>
          <Plus className="size-4" />
          Soal salah
        </Button>
      </div>

      {visible.length === 0 ? (
        <EmptyHint
          icon={BookX}
          text={
            items.length === 0
              ? "Belum ada soal salah. Catat soal yang salah dulu, lalu review sampai dikuasai."
              : "Mantap! Semua soal di sini sudah dikuasai."
          }
        />
      ) : (
        <div className="flex flex-col gap-2">
          {visible.map((it) => (
            <div
              key={it.id}
              className={cn(
                "rounded-lg border p-3 transition-opacity",
                it.mastered && "opacity-60"
              )}
            >
              <div className="flex items-start justify-between gap-2">
                <p
                  className={cn(
                    "min-w-0 flex-1 text-sm font-semibold",
                    it.mastered && "line-through"
                  )}
                >
                  {it.question}
                </p>
                <div className="flex shrink-0 gap-0.5">
                  <Button
                    variant={it.mastered ? "outline" : "secondary"}
                    size="sm"
                    className="h-7 text-xs"
                    onClick={() => toggleMastered(it.id)}
                  >
                    <CheckCircle2 className="size-3.5" />
                    {it.mastered ? "Belum dikuasai" : "Sudah dikuasai"}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="text-destructive size-7 hover:text-destructive"
                    title="Hapus dari buku salah"
                    onClick={() => {
                      setItems((prev) => prev.filter((x) => x.id !== it.id))
                      toast.success("Catatan soal dihapus")
                    }}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              </div>
              <div className="mt-2 space-y-1 text-sm">
                <p>
                  <span className="text-muted-foreground">Jawabanku: </span>
                  <span className="font-medium text-destructive">
                    {it.myAnswer || "—"}
                  </span>
                </p>
                <p>
                  <span className="text-muted-foreground">Jawaban benar: </span>
                  <span className="font-medium text-emerald-600 dark:text-emerald-400">
                    {it.correctAnswer}
                  </span>
                </p>
              </div>
              <div className="text-muted-foreground mt-2 flex items-center gap-2 text-xs">
                {it.source && <Badge variant="outline">{it.source}</Badge>}
                <span>
                  Ditambahkan{" "}
                  {format(parseISO(it.createdAt), "d MMM yyyy", {
                    locale: idLocale,
                  })}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Catat Soal yang Salah</DialogTitle>
            <DialogDescription>
              Simpan soal yang keliru agar bisa di-review sampai dikuasai.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="err-q">Soal / pertanyaan</Label>
              <Textarea
                id="err-q"
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                placeholder="mis. Hasil dari 12 + 5 × 2 adalah…"
                rows={2}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="err-my">Jawabanku (yang salah)</Label>
              <Input
                id="err-my"
                value={myAnswer}
                onChange={(e) => setMyAnswer(e.target.value)}
                placeholder="mis. 34"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="err-right">Jawaban benar</Label>
              <Input
                id="err-right"
                value={correctAnswer}
                onChange={(e) => setCorrectAnswer(e.target.value)}
                placeholder="mis. 22"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="err-src">Sumber (opsional)</Label>
              <Input
                id="err-src"
                value={source}
                onChange={(e) => setSource(e.target.value)}
                placeholder='mis. "Kuis Matematika"'
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
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Komponen utama                                                     */
/* ------------------------------------------------------------------ */

export function Organizers() {
  // State dipusatkan di sini agar Badge jumlah pada tab selalu sinkron.
  const [notes, setNotes] = useLocalJSON<Note[]>("aula-study:notes", [])
  const [todos, setTodos] = useLocalJSON<Todo[]>("aula-study:todos", [])
  const [glossary, setGlossary] = useLocalJSON<GlossaryItem[]>(
    "aula-study:glossary",
    []
  )
  const [errors, setErrors] = useLocalJSON<ErrorItem[]>(
    "aula-study:errorbook",
    []
  )

  return (
    <Tabs defaultValue="catatan" className="w-full">
      <TabsList className="h-auto w-full flex-wrap justify-start sm:w-fit">
        <TabsTrigger value="catatan">
          <NotebookPen className="size-4" />
          Catatan
          <Badge variant="secondary" className="ml-0.5 h-5 px-1.5">
            {notes.length}
          </Badge>
        </TabsTrigger>
        <TabsTrigger value="todo">
          <ListChecks className="size-4" />
          To-do
          <Badge variant="secondary" className="ml-0.5 h-5 px-1.5">
            {todos.filter((t) => !t.done).length}
          </Badge>
        </TabsTrigger>
        <TabsTrigger value="kamus">
          <BookMarked className="size-4" />
          Kamus
          <Badge variant="secondary" className="ml-0.5 h-5 px-1.5">
            {glossary.length}
          </Badge>
        </TabsTrigger>
        <TabsTrigger value="salah">
          <BookX className="size-4" />
          Buku Salah
          <Badge variant="secondary" className="ml-0.5 h-5 px-1.5">
            {errors.filter((e) => !e.mastered).length}
          </Badge>
        </TabsTrigger>
      </TabsList>
      <TabsContent value="catatan" className="mt-3">
        <NotesTab notes={notes} setNotes={setNotes} />
      </TabsContent>
      <TabsContent value="todo" className="mt-3">
        <TodosTab todos={todos} setTodos={setTodos} />
      </TabsContent>
      <TabsContent value="kamus" className="mt-3">
        <GlossaryTab items={glossary} setItems={setGlossary} />
      </TabsContent>
      <TabsContent value="salah" className="mt-3">
        <ErrorBookTab items={errors} setItems={setErrors} />
      </TabsContent>
    </Tabs>
  )
}
