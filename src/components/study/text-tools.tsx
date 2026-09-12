"use client"

// ─────────────────────────────────────────────────────────────────────────────
// src/components/study/text-tools.tsx
//
// "Alat Materi" — 5 fitur otomatis dari teks materi, 100% client-side:
//   1. Rangkum     → kalimat terpilih (skor frekuensi kata)
//   2. Flashcard   → deck flip 3D (definisi / cloze / istilah)
//   3. Kuis        → isian + benar-salah, interaktif satu per satu
//   4. Peta Konsep → outline hierarkis yang bisa di-collapse
//   5. Bacakan     → Text-to-Speech (Web Speech API) + highlight kalimat
//
// Materi disimpan di localStorage ("aula-study:material", debounce 500ms)
// lewat store bersama agent paralel (loadJSON/saveJSON).
// Kontrak: `export function TextTools()` dipanggil study-hub.tsx.
// ─────────────────────────────────────────────────────────────────────────────

import * as React from "react"
import {
  Check,
  ChevronLeft,
  ChevronRight,
  ClipboardPaste,
  Copy,
  Eraser,
  Layers,
  ListChecks,
  ListTree,
  Loader2,
  Pause,
  Play,
  RotateCcw,
  Shuffle,
  Sparkles,
  Square,
  Volume2,
  Wand2,
  X,
} from "lucide-react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import { Slider } from "@/components/ui/slider"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { AutoTextarea } from "@/components/ui/auto-textarea"
import { loadJSON, saveJSON } from "@/lib/study/store"
import { useStudyMaterial } from "@/lib/study/use-study-material"
import { MaterialAiDialog } from "@/components/study/material-ai-dialog"
import { fetchAiSettings } from "@/components/ai/ai-settings-dialog"
import {
  buildOutline,
  extractKeywords,
  generateFlashcards,
  generateQuiz,
  splitSentences,
  summarizeSentences,
} from "@/lib/study/text-analysis"
import { cn } from "@/lib/utils"

// ── Kunci penyimpanan lokal ──
// (Materi kini SATU sumber bersama via useStudyMaterial — key
// "aula-study:material" — sinkron dengan tab Teman AI.)
const QUIZ_LAST_KEY = "aula-study:quiz-last"

// Tipe turunan dari fungsi analisis murni (tanpa duplikasi definisi).
type FlashcardType = { front: string; back: string }
type OutlineNodeType = ReturnType<typeof buildOutline>[number]
type QuizLastScore = { score: number; total: number; at: number }

/** Satu soal kuis — mendukung 3 bentuk:
 *  - "mc"   : pilihan ganda (AI) — options 4 pilihan + explanation
 *  - "fill" : isian offline → dikonversi jadi pilihan ganda lokal
 *  - "tf"   : benar / salah (+ explanation bila dari AI) */
interface QuizItem {
  type: "mc" | "fill" | "tf"
  question: string
  answer: string
  options?: string[]
  distractors?: string[]
  explanation?: string
}

/** Pesan warning bila materi belum cukup panjang untuk diproses. */
const TOO_SHORT_MESSAGE =
  "Materi terlalu pendek — tempel minimal beberapa paragraf (±200 karakter)."

// ── AI helpers (route /api/ai/study, task flashcards/quiz) ──

/** Panggil route study AI & kumpulkan seluruh jawaban streaming jadi string. */
async function callStudyAi(
  task: "flashcards" | "quiz",
  material: string
): Promise<string> {
  const res = await fetch("/api/ai/study", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message:
        task === "flashcards"
          ? "Buat flashcard dari MATERI di atas."
          : "Buat kuis latihan dari MATERI di atas.",
      task,
      material,
    }),
  })
  if (!res.ok) {
    let msg = `Gagal memanggil AI (HTTP ${res.status}).`
    try {
      const j = (await res.json()) as { error?: string }
      if (j.error) msg = j.error
    } catch {
      /* abaikan */
    }
    throw new Error(msg)
  }
  // NDJSON: kumpulkan chunk
  const reader = res.body?.getReader()
  if (!reader) throw new Error("Respons AI tidak bisa dibaca.")
  const decoder = new TextDecoder()
  let buf = ""
  let full = ""
  let errFromStream: string | null = null
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    const lines = buf.split("\n")
    buf = lines.pop() ?? ""
    for (const line of lines) {
      const t = line.trim()
      if (!t) continue
      try {
        const j = JSON.parse(t) as {
          type?: string
          text?: string
          message?: string
        }
        if (j.type === "chunk" && j.text) full += j.text
        else if (j.type === "error" && j.message) errFromStream = j.message
      } catch {
        /* baris rusak — abaikan */
      }
    }
  }
  if (errFromStream) throw new Error(errFromStream)
  if (!full.trim()) throw new Error("AI tidak mengirim jawaban.")
  return full
}

/** Ambil array JSON dari teks AI yang mungkin berisi fence/kalimat pengantar. */
function extractJsonArray(text: string): unknown[] | null {
  const stripped = text.replace(/```(?:json)?/gi, "")
  const start = stripped.indexOf("[")
  const end = stripped.lastIndexOf("]")
  if (start === -1 || end <= start) return null
  try {
    const parsed = JSON.parse(stripped.slice(start, end + 1))
    return Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** Validasi & normalisasi hasil flashcard AI. */
function parseAiFlashcards(
  raw: unknown[]
): { front: string; back: string }[] | null {
  const out: { front: string; back: string }[] = []
  for (const r of raw) {
    if (!r || typeof r !== "object") continue
    const front = String((r as Record<string, unknown>).front ?? "").trim()
    const back = String((r as Record<string, unknown>).back ?? "").trim()
    if (front && back) out.push({ front, back })
  }
  return out.length >= 3 ? out : null
}

/** Validasi & normalisasi hasil kuis AI → bentuk pilihan ganda / tf. */
function parseAiQuiz(raw: unknown[]): QuizItem[] | null {
  const out: QuizItem[] = []
  for (const r of raw) {
    if (!r || typeof r !== "object") continue
    const o = r as Record<string, unknown>
    const question = String(o.question ?? "").trim()
    const answer = String(o.answer ?? "").trim()
    if (!question || !answer) continue
    const explanation =
      typeof o.explanation === "string" && o.explanation.trim()
        ? o.explanation.trim()
        : undefined
    if (answer === "Benar" || answer === "Salah") {
      out.push({ type: "tf", question, answer, explanation })
      continue
    }
    const options = Array.isArray(o.options)
      ? o.options.map((x) => String(x).trim()).filter(Boolean)
      : []
    // Jawaban harus persis salah satu opsi (AI kadang melenceng sedikit
    // — coba cocokkan case-insensitive).
    const match =
      options.find((x) => x === answer) ??
      options.find((x) => x.toLowerCase() === answer.toLowerCase())
    if (options.length >= 2 && match) {
      out.push({ type: "mc", question, answer: match, options, explanation })
    }
  }
  return out.length >= 3 ? out : null
}

/** Acak urutan (Fisher-Yates) — dipakai untuk opsi jawaban offline. */
function shuffled<T>(arr: T[]): T[] {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

/** Kuis offline → opsi pilihan ganda (jawaban + distraktor lokal). */
function offlineQuizToOptions(items: QuizItem[]): QuizItem[] {
  return items.map((q) => {
    if (q.type === "tf") return { ...q, options: ["Benar", "Salah"] }
    const distractors = (q.distractors ?? []).filter(
      (d) => d.toLowerCase() !== q.answer.toLowerCase()
    )
    return {
      ...q,
      options: shuffled([q.answer, ...distractors.slice(0, 3)]),
    }
  })
}

/** Kartu placeholder sebelum pengguna menekan tombol generate. */
function TabHint({ text }: { text: string }) {
  return (
    <div className="flex min-h-28 flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed p-4 text-center">
      <p className="text-sm text-muted-foreground">{text}</p>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Komponen utama
// ─────────────────────────────────────────────────────────────────────────────
export function TextTools() {
  // ── Materi bersama (dipakai semua tab + Teman AI — SATU sumber) ──
  const { material, setMaterial } = useStudyMaterial()
  const [tab, setTab] = React.useState("rangkum")

  // ── AI tersedia? (untuk tombol "Buat dengan AI") ──
  const [aiActive, setAiActive] = React.useState(false)
  const [genOpen, setGenOpen] = React.useState(false)

  React.useEffect(() => {
    void fetchAiSettings().then((d) => setAiActive(!!d?.active))
  }, [])

  // ── Rangkum ──
  const [summaryCount, setSummaryCount] = React.useState(5)
  const [summary, setSummary] = React.useState<string[] | null>(null)
  const [summaryKeywords, setSummaryKeywords] = React.useState<
    { word: string; count: number }[]
  >([])

  // ── Flashcard ──
  const [deck, setDeck] = React.useState<FlashcardType[] | null>(null)
  const [deckSource, setDeckSource] = React.useState<"ai" | "offline" | null>(
    null
  )
  const [deckLoading, setDeckLoading] = React.useState(false)
  const [cardIndex, setCardIndex] = React.useState(0)
  const [flipped, setFlipped] = React.useState(false)

  // ── Kuis ──
  const [quiz, setQuiz] = React.useState<QuizItem[] | null>(null)
  const [quizSource, setQuizSource] = React.useState<"ai" | "offline" | null>(
    null
  )
  const [quizLoading, setQuizLoading] = React.useState(false)
  const [quizIndex, setQuizIndex] = React.useState(0)
  const [quizResult, setQuizResult] = React.useState<boolean | null>(null)
  const [quizScore, setQuizScore] = React.useState(0)
  const [quizWrong, setQuizWrong] = React.useState(0)
  const [quizFinished, setQuizFinished] = React.useState(false)
  const [quizLast, setQuizLast] = React.useState<QuizLastScore | null>(null)

  // ── Peta Konsep ──
  const [outline, setOutline] = React.useState<OutlineNodeType[] | null>(null)
  const [collapsedNodes, setCollapsedNodes] = React.useState<Set<string>>(
    new Set()
  )

  // ── TTS (Bacakan) ──
  const [ttsSupported, setTtsSupported] = React.useState(false)
  const [voices, setVoices] = React.useState<SpeechSynthesisVoice[]>([])
  const [voiceURI, setVoiceURI] = React.useState("")
  const [rate, setRate] = React.useState(1)
  const [speaking, setSpeaking] = React.useState(false)
  const [paused, setPaused] = React.useState(false)
  const [activeSentence, setActiveSentence] = React.useState(-1)
  const activeUtterRef = React
    .useRef<SpeechSynthesisUtterance | null>(null)
  // Snapshot kalimat yang sedang dibacakan (posisi offset stabil meski
  // materi diedit saat playback).
  const spokenRef = React.useRef<{
    start: number
    offsets: number[]
  }>({ start: 0, offsets: [] })

  // ── Load data tersimpan (hanya di client, aman untuk SSR) ──
  React.useEffect(() => {
    setQuizLast(loadJSON<QuizLastScore | null>(QUIZ_LAST_KEY, null))
  }, [])

  // ── Statistik materi ──
  const stats = React.useMemo(() => {
    const trimmed = material.trim()
    return {
      words: trimmed ? trimmed.split(/\s+/).length : 0,
      sentences: splitSentences(material).length,
      chars: material.length,
    }
  }, [material])

  /** true bila materi belum cukup (dipakai tombol generate). */
  const materialTooShort =
    material.trim().length < 200 || stats.sentences < 3

  const requireEnoughMaterial = () => {
    if (materialTooShort) {
      toast.warning(TOO_SHORT_MESSAGE)
      return false
    }
    return true
  }

  // ── Aksi textarea ──
  const pasteFromClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText()
      if (!text.trim()) {
        toast.warning("Clipboard kosong — salin teks materi terlebih dulu.")
        return
      }
      setMaterial(material.trim() ? `${material}\n\n${text}` : text)
      toast.success("Materi ditempel dari clipboard.")
    } catch {
      toast.error(
        "Tidak bisa membaca clipboard — tempel manual dengan Ctrl/Cmd + V."
      )
    }
  }

  const clearMaterial = () => {
    setMaterial("")
    // Reset semua hasil generate agar tidak menampilkan data basi.
    setSummary(null)
    setSummaryKeywords([])
    setDeck(null)
    setQuiz(null)
    setOutline(null)
    stopSpeaking()
    toast.success("Materi dibersihkan.")
  }

  // ── TTS: cek dukungan + daftar voice (prioritas id-ID → id → default) ──
  React.useEffect(() => {
    const supported =
      typeof window !== "undefined" && "speechSynthesis" in window
    setTtsSupported(supported)
    // Bersihkan sintesis saat komponen dilepas.
    return () => {
      if (supported) window.speechSynthesis.cancel()
    }
  }, [])

  React.useEffect(() => {
    if (!ttsSupported) return
    const synth = window.speechSynthesis
    const loadVoices = () => setVoices(synth.getVoices())
    loadVoices() // beberapa browser sudah siap langsung
    synth.addEventListener("voiceschanged", loadVoices)
    return () => synth.removeEventListener("voiceschanged", loadVoices)
  }, [ttsSupported])

  React.useEffect(() => {
    if (voiceURI || voices.length === 0) return
    // Prioritas: lang "id-ID", lalu "id", fallback voice pertama.
    const preferred =
      voices.find((v) => v.lang.toLowerCase().startsWith("id-id")) ??
      voices.find((v) => v.lang.toLowerCase().startsWith("id")) ??
      voices[0]
    setVoiceURI(preferred?.voiceURI ?? "")
  }, [voices, voiceURI])

  /** Kalimat materi untuk tab Bacakan. */
  const ttsSentences = React.useMemo(
    () => splitSentences(material),
    [material]
  )

  const stopSpeaking = React.useCallback(() => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return
    window.speechSynthesis.cancel()
    activeUtterRef.current = null
    setSpeaking(false)
    setPaused(false)
    setActiveSentence(-1)
  }, [])

  /** Peta charIndex (event onboundary) → index kalimat via binary search. */
  const sentenceIndexFromChar = (charIndex: number) => {
    const offsets = spokenRef.current.offsets
    let lo = 0
    let hi = offsets.length - 1
    let result = 0
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (offsets[mid] <= charIndex) {
        result = mid
        lo = mid + 1
      } else {
        hi = mid - 1
      }
    }
    return result
  }

  /** Mulai memutar dari kalimat ke-`start` (default 0). */
  const speakFrom = (start: number) => {
    if (!ttsSupported) return
    const list = ttsSentences
    if (list.length === 0) return
    const slice = list.slice(start)
    const offsets: number[] = []
    let pos = 0
    for (const s of slice) {
      offsets.push(pos)
      pos += s.length + 1 // dipisah satu spasi saat digabung
    }
    spokenRef.current = { start, offsets }

    const synth = window.speechSynthesis
    synth.cancel() // hentikan playback lama
    if (synth.paused) synth.resume() // jaga-jaga bug Chrome yang "macet" pause

    const utter = new SpeechSynthesisUtterance(slice.join(" "))
    const voice = voices.find((v) => v.voiceURI === voiceURI)
    if (voice) {
      utter.voice = voice
      utter.lang = voice.lang
    } else {
      utter.lang = "id-ID"
    }
    utter.rate = rate
    utter.onboundary = (e) => {
      // onboundary memberi charIndex awal kata → petakan ke index kalimat.
      const idx = sentenceIndexFromChar(e.charIndex)
      setActiveSentence(start + idx)
    }
    utter.onend = () => {
      if (activeUtterRef.current !== utter) return // playback lama yang dibatalkan
      setSpeaking(false)
      setPaused(false)
      setActiveSentence(-1)
    }
    utter.onerror = () => {
      if (activeUtterRef.current !== utter) return
      setSpeaking(false)
      setPaused(false)
      setActiveSentence(-1)
    }
    activeUtterRef.current = utter
    synth.speak(utter)
    setSpeaking(true)
    setPaused(false)
    setActiveSentence(start)
  }

  /** Tombol utama: Putar ↔ Jeda ↔ Lanjut. */
  const toggleSpeak = () => {
    if (!ttsSupported) return
    if (!speaking) {
      if (ttsSentences.length === 0) {
        toast.warning(TOO_SHORT_MESSAGE)
        return
      }
      speakFrom(0)
      return
    }
    if (paused) {
      window.speechSynthesis.resume()
      setPaused(false)
    } else {
      window.speechSynthesis.pause()
      setPaused(true)
    }
  }

  /** Ganti tab → hentikan pembacaan (cancel). */
  const handleTabChange = (value: string) => {
    stopSpeaking()
    setTab(value)
  }

  // ── RANGKUM ──
  const buildSummary = () => {
    if (!requireEnoughMaterial()) return
    setSummary(summarizeSentences(material, summaryCount))
    setSummaryKeywords(extractKeywords(material, 10))
  }

  const copySummary = async () => {
    if (!summary || summary.length === 0) return
    const text = summary.map((s, i) => `${i + 1}. ${s}`).join("\n")
    try {
      await navigator.clipboard.writeText(text)
      toast.success("Rangkuman disalin ke clipboard.")
    } catch {
      toast.error("Gagal menyalin — coba salin manual.")
    }
  }

  // ── FLASHCARD ──
  const resetDeck = (cards: FlashcardType[], source: "ai" | "offline") => {
    setDeck(cards)
    setDeckSource(source)
    setCardIndex(0)
    setFlipped(false)
  }

  const buildDeckOffline = () => {
    resetDeck(generateFlashcards(material), "offline")
  }

  const buildDeck = async () => {
    if (!requireEnoughMaterial()) return
    // Tanpa AI → langsung pembuat offline.
    if (!aiActive) {
      buildDeckOffline()
      return
    }
    setDeckLoading(true)
    try {
      const raw = await callStudyAi("flashcards", material)
      const parsed = parseAiFlashcards(extractJsonArray(raw) ?? [])
      if (!parsed) throw new Error("Format jawaban AI tidak dikenali.")
      resetDeck(parsed, "ai")
      toast.success(`${parsed.length} kartu dibuat oleh AI dari materimu.`)
    } catch (e) {
      toast.warning(
        `AI gagal (${e instanceof Error ? e.message : "tidak diketahui"}) — memakai pembuat offline.`,
        { duration: 6000 }
      )
      buildDeckOffline()
    } finally {
      setDeckLoading(false)
    }
  }

  const shuffleDeck = () => {
    if (!deck || deck.length === 0) return
    const next = [...deck]
    for (let i = next.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[next[i], next[j]] = [next[j], next[i]]
    }
    setDeck(next)
    setCardIndex(0)
    setFlipped(false)
  }

  const goToCard = (index: number) => {
    if (!deck) return
    setCardIndex(Math.max(0, Math.min(index, deck.length - 1)))
    setFlipped(false)
  }

  // ── KUIS ──
  const resetQuiz = (items: QuizItem[], source: "ai" | "offline") => {
    setQuiz(items)
    setQuizSource(source)
    setQuizIndex(0)
    setQuizResult(null)
    setQuizScore(0)
    setQuizWrong(0)
    setQuizFinished(false)
  }

  const buildQuizOffline = () => {
    resetQuiz(offlineQuizToOptions(generateQuiz(material)), "offline")
  }

  const buildQuiz = async () => {
    if (!requireEnoughMaterial()) return
    if (!aiActive) {
      buildQuizOffline()
      return
    }
    setQuizLoading(true)
    try {
      const raw = await callStudyAi("quiz", material)
      const parsed = parseAiQuiz(extractJsonArray(raw) ?? [])
      if (!parsed) throw new Error("Format jawaban AI tidak dikenali.")
      resetQuiz(parsed, "ai")
      toast.success(`${parsed.length} soal disusun oleh AI dari materimu.`)
    } catch (e) {
      toast.warning(
        `AI gagal (${e instanceof Error ? e.message : "tidak diketahui"}) — memakai pembuat offline.`,
        { duration: 6000 }
      )
      buildQuizOffline()
    } finally {
      setQuizLoading(false)
    }
  }

  const finishQuiz = () => {
    if (!quiz) return
    setQuizFinished(true)
    // Simpan skor terakhir ke localStorage.
    const last: QuizLastScore = {
      score: quizScore,
      total: quiz.length,
      at: Date.now(),
    }
    setQuizLast(last)
    saveJSON(QUIZ_LAST_KEY, last)
  }

  const answerChoice = (choice: string) => {
    if (!quiz || quizResult !== null) return
    const item = quiz[quizIndex]
    if (!item) return
    const correct = choice === item.answer
    setQuizResult(correct)
    if (correct) setQuizScore((s) => s + 1)
    else setQuizWrong((w) => w + 1)
  }

  const answerTrueFalse = (choice: "Benar" | "Salah") => {
    answerChoice(choice)
  }

  const nextQuiz = () => {
    if (!quiz) return
    if (quizIndex + 1 < quiz.length) {
      setQuizIndex((i) => i + 1)
      setQuizResult(null)
    } else {
      finishQuiz()
    }
  }

  // ── PETA KONSEP ──
  const buildMap = () => {
    if (!requireEnoughMaterial()) return
    setOutline(buildOutline(material))
    setCollapsedNodes(new Set())
  }

  const toggleOutlineNode = (key: string) => {
    setCollapsedNodes((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const currentCard = deck && deck.length > 0 ? deck[cardIndex] : null
  const currentQuizItem = quiz && quiz.length > 0 ? quiz[quizIndex] : null

  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          <Sparkles className="size-5 text-primary" />
          Alat Materi
        </CardTitle>
        <CardDescription>
          Satu materi untuk semua — kolom di bawah tersinkron dengan tab Teman
          AI (dan sebaliknya). Rangkuman, flashcard, kuis, peta konsep, dan
          pembaca suara dibuat otomatis di perangkat Anda.
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        {/* ── 1. Textarea materi bersama ── */}
        <div className="flex flex-col gap-2">
          <AutoTextarea
            value={material}
            onChange={(e) => setMaterial(e.target.value)}
            placeholder="Tempel atau tulis materi di sini… atau minta AI membuatnya — tersinkron dengan tab Teman AI (minimal ±200 karakter agar fitur aktif)"
            className="min-h-36 text-sm leading-relaxed" maxHeight={Math.round(window.innerHeight * 0.4)}
          />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">
              {stats.words} kata · {stats.sentences} kalimat ·{" "}
              {stats.chars} karakter · tersimpan otomatis ·{" "}
              <span className="font-medium text-foreground">sync dengan Teman AI</span>
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="default"
                size="sm"
                onClick={() => setGenOpen(true)}
                disabled={!aiActive}
                title={aiActive ? "Minta AI membuat materi" : "Belum ada AI terpasang — atur di tab Teman AI"}
                type="button"
              >
                <Wand2 />
                Buat dengan AI
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={pasteFromClipboard}
                type="button"
              >
                <ClipboardPaste />
                Tempel
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={clearMaterial}
                disabled={!material}
                type="button"
              >
                <Eraser />
                Bersihkan
              </Button>
            </div>
          </div>
        </div>

        {/* ── 2. Tabs fitur ── */}
        <Tabs value={tab} onValueChange={handleTabChange}>
          <TabsList className="w-full overflow-x-auto sm:w-fit">
            <TabsTrigger value="rangkum">Rangkum</TabsTrigger>
            <TabsTrigger value="flashcard">Flashcard</TabsTrigger>
            <TabsTrigger value="kuis">Kuis</TabsTrigger>
            <TabsTrigger value="peta">Peta Konsep</TabsTrigger>
            <TabsTrigger value="bacakan">Bacakan</TabsTrigger>
          </TabsList>

          {/* ── TAB: RANGKUM ── */}
          <TabsContent value="rangkum" className="flex flex-col gap-4">
            <div className="flex flex-col gap-3 rounded-lg border p-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex w-full items-center gap-3 sm:max-w-md">
                <span className="w-24 shrink-0 text-sm font-medium">
                  Kalimat: {summaryCount}
                </span>
                <Slider
                  min={3}
                  max={10}
                  step={1}
                  value={[summaryCount]}
                  onValueChange={(v) => setSummaryCount(v[0] ?? 5)}
                />
              </div>
              <Button onClick={buildSummary} type="button">
                <Sparkles />
                Buat Rangkuman
              </Button>
            </div>

            {summary === null ? (
              <TabHint text="Tekan “Buat Rangkuman” untuk meringkas materi menjadi poin-poin utama." />
            ) : summary.length === 0 ? (
              <TabHint text="Tidak ada kalimat yang bisa dirangkum dari materi ini." />
            ) : (
              <div className="flex flex-col gap-4">
                <ol className="flex flex-col gap-2.5">
                  {summary.map((sentence, i) => (
                    <li key={i} className="flex gap-2.5">
                      <Badge
                        variant="secondary"
                        className="mt-0.5 h-5 min-w-5 justify-center rounded-full px-1.5 tabular-nums"
                      >
                        {i + 1}
                      </Badge>
                      <span className="text-sm leading-relaxed">
                        {sentence}
                      </span>
                    </li>
                  ))}
                </ol>

                {summaryKeywords.length > 0 && (
                  <div className="flex flex-col gap-2">
                    <p className="text-xs font-medium text-muted-foreground">
                      Kata kunci utama
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {summaryKeywords.map((k) => (
                        <Badge key={k.word} variant="outline">
                          {k.word}
                          <span className="text-muted-foreground">
                            ×{k.count}
                          </span>
                        </Badge>
                      ))}
                    </div>
                  </div>
                )}

                <div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={copySummary}
                    type="button"
                  >
                    <Copy />
                    Salin rangkuman
                  </Button>
                </div>
              </div>
            )}
          </TabsContent>

          {/* ── TAB: FLASHCARD ── */}
          <TabsContent value="flashcard" className="flex flex-col gap-4">
            <div className="flex flex-col gap-3 rounded-lg border p-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex flex-col gap-0.5">
                <p className="text-sm text-muted-foreground">
                  {aiActive
                    ? "AI menyusun kartu bermakna dari materi (fallback offline bila gagal)."
                    : "Kartu dibuat otomatis di perangkat dari definisi & istilah penting."}
                </p>
                {deck && deckSource ? (
                  <p className="text-xs text-muted-foreground">
                    Deck aktif:{" "}
                    <span className="font-medium text-foreground">
                      {deck.length} kartu
                    </span>{" "}
                    · dibuat{" "}
                    {deckSource === "ai" ? "oleh AI" : "offline di perangkat"}
                  </p>
                ) : null}
              </div>
              <div className="flex shrink-0 gap-2">
                {aiActive ? (
                  <Button variant="outline" onClick={buildDeckOffline} type="button">
                    <Layers />
                    Offline
                  </Button>
                ) : null}
                <Button
                  onClick={() => void buildDeck()}
                  disabled={deckLoading}
                  type="button"
                >
                  {deckLoading ? (
                    <Loader2 className="animate-spin" />
                  ) : (
                    <Sparkles />
                  )}
                  {deckLoading
                    ? "AI menyusun…"
                    : aiActive
                      ? "Buat dengan AI"
                      : "Buat Flashcard"}
                </Button>
              </div>
            </div>

            {deck === null ? (
              <TabHint text="Tekan “Buat Flashcard” untuk menyusun deck dari materi." />
            ) : deck.length === 0 ? (
              <TabHint text="Materi belum cukup untuk dibuatkan flashcard." />
            ) : (
              <div className="flex flex-col gap-4">
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span className="tabular-nums">
                    Kartu {cardIndex + 1}/{deck.length}
                  </span>
                  <span className="hidden sm:inline">
                    Klik kartu untuk membalik
                  </span>
                </div>
                <Progress value={((cardIndex + 1) / deck.length) * 100} />

                {/* Kartu flip 3D sederhana */}
                <div
                  className="h-56 w-full cursor-pointer select-none [perspective:1200px] sm:h-64"
                  onClick={() => setFlipped((f) => !f)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault()
                      setFlipped((f) => !f)
                    }
                  }}
                  aria-label="Kartu flashcard — klik untuk membalik"
                >
                  <div
                    className={cn(
                      "relative h-full w-full transition-transform duration-500 [transform-style:preserve-3d]",
                      flipped && "[transform:rotateY(180deg)]"
                    )}
                  >
                    {/* Sisi depan: pertanyaan / istilah */}
                    <div className="absolute inset-0 flex flex-col gap-2 overflow-y-auto rounded-xl border bg-card p-5 shadow-sm [backface-visibility:hidden]">
                      <span className="text-[10px] font-semibold tracking-widest text-muted-foreground uppercase">
                        Pertanyaan
                      </span>
                      <div className="flex flex-1 items-center justify-center text-center">
                        <p className="text-base font-medium leading-relaxed sm:text-lg">
                          {currentCard?.front}
                        </p>
                      </div>
                    </div>
                    {/* Sisi belakang: jawaban */}
                    <div className="absolute inset-0 flex flex-col gap-2 overflow-y-auto rounded-xl border border-primary/40 bg-primary/5 p-5 shadow-sm [backface-visibility:hidden] [transform:rotateY(180deg)]">
                      <span className="text-[10px] font-semibold tracking-widest text-primary uppercase">
                        Jawaban
                      </span>
                      <div className="flex flex-1 items-center justify-center text-center">
                        <p className="text-sm leading-relaxed sm:text-base">
                          {currentCard?.back}
                        </p>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => goToCard(cardIndex - 1)}
                    disabled={cardIndex === 0}
                    type="button"
                  >
                    <ChevronLeft />
                    Sebelumnya
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={shuffleDeck}
                    type="button"
                  >
                    <Shuffle />
                    Acak
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => goToCard(cardIndex + 1)}
                    disabled={cardIndex === deck.length - 1}
                    type="button"
                  >
                    Berikutnya
                    <ChevronRight />
                  </Button>
                </div>
              </div>
            )}
          </TabsContent>

          {/* ── TAB: KUIS ── */}
          <TabsContent value="kuis" className="flex flex-col gap-4">
            <div className="flex flex-col gap-3 rounded-lg border p-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex flex-col gap-0.5">
                <p className="text-sm text-muted-foreground">
                  {aiActive
                    ? "AI menyusun soal pilihan ganda + pembahasan dari materi."
                    : "Soal pilihan ganda & benar-salah disusun di perangkat."}
                </p>
                {/* Ringkasan skor terakhir (persist aula-study:quiz-last) */}
                {quizLast && (
                  <p className="text-xs text-muted-foreground">
                    Skor terakhir:{" "}
                    <span className="font-medium text-foreground">
                      {quizLast.score}/{quizLast.total}
                    </span>{" "}
                    (
                    {Math.round((quizLast.score / quizLast.total) * 100)}%) ·{" "}
                    {new Date(quizLast.at).toLocaleString("id-ID", {
                      day: "numeric",
                      month: "short",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </p>
                )}
                {quiz && quizSource ? (
                  <p className="text-xs text-muted-foreground">
                    Kuis aktif:{" "}
                    <span className="font-medium text-foreground">
                      {quiz.length} soal
                    </span>{" "}
                    · disusun{" "}
                    {quizSource === "ai" ? "oleh AI" : "offline di perangkat"}
                  </p>
                ) : null}
              </div>
              <div className="flex shrink-0 gap-2">
                {aiActive ? (
                  <Button variant="outline" onClick={buildQuizOffline} type="button">
                    <ListChecks />
                    Offline
                  </Button>
                ) : null}
                <Button
                  onClick={() => void buildQuiz()}
                  disabled={quizLoading}
                  type="button"
                >
                  {quizLoading ? (
                    <Loader2 className="animate-spin" />
                  ) : (
                    <Sparkles />
                  )}
                  {quizLoading
                    ? "AI menyusun…"
                    : aiActive
                      ? "Buat dengan AI"
                      : "Buat Kuis"}
                </Button>
              </div>
            </div>

            {quiz === null ? (
              <TabHint text="Tekan “Buat Kuis” untuk berlatih dari materi." />
            ) : quiz.length === 0 ? (
              <TabHint text="Materi belum cukup untuk dibuatkan kuis." />
            ) : quizFinished ? (
              /* ── Layar hasil akhir ── */
              <div className="flex flex-col items-center gap-3 rounded-lg border p-6 text-center">
                <p className="text-4xl font-bold tabular-nums">
                  {quizScore}/{quiz.length}
                </p>
                <p className="text-sm text-muted-foreground">
                  Benar {quizScore} · Salah {quizWrong}
                </p>
                <p className="text-sm font-medium">
                  {quizScore === quiz.length
                    ? "Sempurna! Kamu menguasai materi ini. 🎉"
                    : quizScore / quiz.length >= 0.7
                      ? "Bagus! Sedikit lagi sempurna."
                      : "Terus berlatih — coba baca ulang rangkumannya."}
                </p>
                <Button onClick={buildQuiz} type="button" className="mt-1">
                  <RotateCcw />
                  Ulangi
                </Button>
              </div>
            ) : (
              <div className="flex flex-col gap-4">
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span className="tabular-nums">
                    Soal {quizIndex + 1} dari {quiz.length}
                  </span>
                  <span className="tabular-nums">
                    Benar {quizScore} · Salah {quizWrong}
                  </span>
                </div>
                <Progress
                  value={((quizIndex + 1) / quiz.length) * 100}
                />

                <div className="flex flex-col gap-4 rounded-lg border p-4">
                  <Badge variant="secondary" className="w-fit">
                    {currentQuizItem?.type === "tf"
                      ? "Benar / Salah"
                      : currentQuizItem?.type === "fill"
                        ? "Isian — pilih jawaban"
                        : "Pilihan Ganda"}
                  </Badge>
                  <p className="text-sm leading-relaxed font-medium">
                    {currentQuizItem?.question}
                  </p>

                  {/* Opsi jawaban — mc & fill sama-sama tombol pilihan
                      (fill offline dikonversi jadi pilihan lokal), tf
                      tombol Benar/Salah. */}
                  <div className="flex flex-col gap-2">
                    {(currentQuizItem?.type === "mc" ||
                      currentQuizItem?.type === "fill") &&
                      currentQuizItem.options?.map((opt) => {
                        const isPicked = quizResult !== null
                        const isRight = opt === currentQuizItem.answer
                        return (
                          <Button
                            key={opt}
                            variant="outline"
                            className="h-auto justify-start whitespace-normal py-2.5 text-left"
                            onClick={() => answerChoice(opt)}
                            disabled={isPicked}
                            type="button"
                          >
                            <span
                              className={cn(
                                "mr-1 inline-flex size-5 shrink-0 items-center justify-center rounded-full border text-[10px] font-semibold",
                                isPicked && isRight
                                  ? "border-emerald-500 bg-emerald-500 text-white"
                                  : "text-muted-foreground"
                              )}
                            >
                              {isPicked && isRight ? (
                                <Check className="size-3" />
                              ) : null}
                            </span>
                            {opt}
                          </Button>
                        )
                      })}
                    {currentQuizItem?.type === "tf" ? (
                      <div className="flex flex-wrap gap-2">
                        <Button
                          variant="outline"
                          onClick={() => answerTrueFalse("Benar")}
                          disabled={quizResult !== null}
                          type="button"
                        >
                          Benar
                        </Button>
                        <Button
                          variant="outline"
                          onClick={() => answerTrueFalse("Salah")}
                          disabled={quizResult !== null}
                          type="button"
                        >
                          Salah
                        </Button>
                      </div>
                    ) : null}
                  </div>

                  {/* Feedback setelah menjawab */}
                  {quizResult !== null && currentQuizItem && (
                    <div
                      className={cn(
                        "flex flex-col gap-2 rounded-md border px-3 py-2.5 text-sm",
                        quizResult
                          ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-700 dark:border-emerald-500/40 dark:bg-emerald-500/15 dark:text-emerald-300"
                          : "border-destructive/50 bg-destructive/10 text-destructive dark:border-destructive/40 dark:bg-destructive/15"
                      )}
                    >
                      <p className="flex items-center gap-1.5 font-medium">
                        {quizResult ? (
                          <>
                            <Check className="size-4" /> Benar!
                          </>
                        ) : (
                          <>
                            <X className="size-4" /> Kurang tepat.
                          </>
                        )}
                      </p>
                      {!quizResult && (
                        <p>
                          Jawaban benar:{" "}
                          <span className="font-semibold">
                            {currentQuizItem.answer}
                          </span>
                        </p>
                      )}
                      {currentQuizItem.explanation ? (
                        <p className="leading-relaxed">
                          <span className="font-medium">Pembahasan:</span>{" "}
                          {currentQuizItem.explanation}
                        </p>
                      ) : null}
                      <Button
                        size="sm"
                        variant="outline"
                        className="w-fit"
                        onClick={nextQuiz}
                        type="button"
                      >
                        {quizIndex + 1 < quiz.length
                          ? "Lanjut"
                          : "Lihat Hasil"}
                        <ChevronRight />
                      </Button>
                    </div>
                  )}
                </div>
              </div>
            )}
          </TabsContent>

          {/* ── TAB: PETA KONSEP ── */}
          <TabsContent value="peta" className="flex flex-col gap-4">
            <div className="flex flex-col gap-3 rounded-lg border p-3 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-sm text-muted-foreground">
                Struktur materi menjadi hierarki yang bisa dilipat per bagian.
              </p>
              <Button onClick={buildMap} type="button" className="shrink-0">
                <ListTree />
                Buat Peta
              </Button>
            </div>

            {outline === null ? (
              <TabHint text="Tekan “Buat Peta” untuk menyusun peta konsep dari materi." />
            ) : outline.length === 0 ? (
              <TabHint text="Materi belum cukup untuk dibuatkan peta konsep." />
            ) : (
              <div className="rounded-lg border p-4">
                <ul className="flex flex-col gap-1">
                  {outline.map((node, i) => (
                    <OutlineItem
                      key={`${i}`}
                      node={node}
                      pathKey={`${i}`}
                      depth={0}
                      collapsed={collapsedNodes}
                      onToggle={toggleOutlineNode}
                    />
                  ))}
                </ul>
              </div>
            )}
          </TabsContent>

          {/* ── TAB: BACAKAN (TTS) ── */}
          <TabsContent value="bacakan" className="flex flex-col gap-4">
            {!ttsSupported ? (
              <TabHint text="Browser ini tidak mendukung pembacaan suara." />
            ) : (
              <>
                <div className="flex flex-col gap-4 rounded-lg border p-3">
                  {/* Pilihan voice — prioritas bahasa Indonesia */}
                  <div className="flex flex-col gap-1.5">
                    <label
                      htmlFor="tts-voice"
                      className="text-xs font-medium text-muted-foreground"
                    >
                      Suara pembaca
                    </label>
                    <select
                      id="tts-voice"
                      value={voiceURI}
                      onChange={(e) => {
                        stopSpeaking()
                        setVoiceURI(e.target.value)
                      }}
                      className="h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] dark:bg-input/30"
                    >
                      {voices.length === 0 ? (
                        <option value="">Memuat daftar suara…</option>
                      ) : (
                        voices.map((v) => (
                          <option key={v.voiceURI} value={v.voiceURI}>
                            {v.name} ({v.lang})
                          </option>
                        ))
                      )}
                    </select>
                  </div>

                  {/* Kecepatan 0.5–2 */}
                  <div className="flex flex-col gap-1.5">
                    <div className="flex items-center justify-between">
                      <label className="text-xs font-medium text-muted-foreground">
                        Kecepatan
                      </label>
                      <span className="text-xs tabular-nums text-muted-foreground">
                        {rate.toFixed(1)}×
                      </span>
                    </div>
                    <Slider
                      min={0.5}
                      max={2}
                      step={0.1}
                      value={[rate]}
                      onValueChange={(v) => setRate(v[0] ?? 1)}
                    />
                    <p className="text-[11px] text-muted-foreground">
                      Perubahan kecepatan berlaku saat mulai memutar ulang.
                    </p>
                  </div>

                  {/* Kontrol Play / Jeda / Stop */}
                  <div className="flex flex-wrap gap-2">
                    <Button onClick={toggleSpeak} type="button">
                      {speaking && !paused ? (
                        <>
                          <Pause />
                          Jeda
                        </>
                      ) : paused ? (
                        <>
                          <Play />
                          Lanjut
                        </>
                      ) : (
                        <>
                          <Volume2 />
                          Putar
                        </>
                      )}
                    </Button>
                    <Button
                      variant="destructive"
                      onClick={stopSpeaking}
                      disabled={!speaking}
                      type="button"
                    >
                      <Square />
                      Stop
                    </Button>
                  </div>
                </div>

                {/* Daftar kalimat + highlight kalimat aktif */}
                <div className="flex max-h-72 flex-col gap-1 overflow-y-auto rounded-lg border p-2">
                  {ttsSentences.length === 0 ? (
                    <p className="p-2 text-sm text-muted-foreground">
                      Materi masih kosong.
                    </p>
                  ) : (
                    ttsSentences.map((sentence, i) => (
                      <button
                        key={i}
                        type="button"
                        onClick={() => speakFrom(i)}
                        className={cn(
                          "rounded-md px-2 py-1.5 text-left text-sm leading-relaxed transition-colors",
                          i === activeSentence
                            ? "bg-primary/15 text-foreground"
                            : "text-muted-foreground hover:bg-muted"
                        )}
                        title="Klik untuk membaca mulai kalimat ini"
                      >
                        {sentence}
                      </button>
                    ))
                  )}
                </div>
              </>
            )}
          </TabsContent>
        </Tabs>
      </CardContent>

      {/* Buat materi dengan AI — hasilnya langsung masuk kolom materi
          (tersinkron ke tab Teman AI). */}
      <MaterialAiDialog
        open={genOpen}
        onOpenChange={setGenOpen}
        hasExisting={material.trim().length > 0}
        currentMaterial={material}
        setMaterial={setMaterial}
        disabled={!aiActive}
      />
    </Card>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Item peta konsep (rekursif) — tombol collapse + indentasi bertingkat
// ─────────────────────────────────────────────────────────────────────────────
function OutlineItem({
  node,
  pathKey,
  depth,
  collapsed,
  onToggle,
}: {
  node: OutlineNodeType
  pathKey: string
  depth: number
  collapsed: Set<string>
  onToggle: (key: string) => void
}) {
  const hasChildren = node.children && node.children.length > 0
  const isOpen = !collapsed.has(pathKey)

  return (
    <li>
      <div className="flex items-start gap-1.5 py-0.5">
        {hasChildren ? (
          <button
            type="button"
            onClick={() => onToggle(pathKey)}
            className="mt-0.5 rounded p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            aria-label={isOpen ? "Lipat bagian ini" : "Buka bagian ini"}
          >
            <ChevronRight
              className={cn(
                "size-4 shrink-0 transition-transform",
                isOpen && "rotate-90"
              )}
            />
          </button>
        ) : (
          <span className="mt-[7px] size-1.5 shrink-0 rounded-full bg-border" />
        )}
        <span
          className={cn(
            "text-sm leading-relaxed",
            depth === 0 ? "font-semibold" : "text-muted-foreground"
          )}
        >
          {node.text}
        </span>
      </div>

      {hasChildren && isOpen && (
        <ul className="mt-1 ml-4 space-y-1 border-l pl-2.5">
          {node.children.map((child, i) => (
            <OutlineItem
              key={`${pathKey}/${i}`}
              node={child}
              pathKey={`${pathKey}/${i}`}
              depth={depth + 1}
              collapsed={collapsed}
              onToggle={onToggle}
            />
          ))}
        </ul>
      )}
    </li>
  )
}
