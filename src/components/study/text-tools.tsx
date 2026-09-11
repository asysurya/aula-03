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
  Pause,
  Play,
  RotateCcw,
  Shuffle,
  Sparkles,
  Square,
  Volume2,
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
import { Input } from "@/components/ui/input"
import { Progress } from "@/components/ui/progress"
import { Slider } from "@/components/ui/slider"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { loadJSON, saveJSON } from "@/lib/study/store"
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
const MATERIAL_KEY = "aula-study:material"
const QUIZ_LAST_KEY = "aula-study:quiz-last"

// Tipe turunan dari fungsi analisis murni (tanpa duplikasi definisi).
type FlashcardType = ReturnType<typeof generateFlashcards>[number]
type QuizItemType = ReturnType<typeof generateQuiz>[number]
type OutlineNodeType = ReturnType<typeof buildOutline>[number]
type QuizLastScore = { score: number; total: number; at: number }

/** Pesan warning bila materi belum cukup panjang untuk diproses. */
const TOO_SHORT_MESSAGE =
  "Materi terlalu pendek — tempel minimal beberapa paragraf (±200 karakter)."

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
  // ── Materi bersama (dipakai semua tab) ──
  const [material, setMaterial] = React.useState("")
  const [loaded, setLoaded] = React.useState(false) // sudah load dari localStorage?
  const [tab, setTab] = React.useState("rangkum")

  // ── Rangkum ──
  const [summaryCount, setSummaryCount] = React.useState(5)
  const [summary, setSummary] = React.useState<string[] | null>(null)
  const [summaryKeywords, setSummaryKeywords] = React.useState<
    { word: string; count: number }[]
  >([])

  // ── Flashcard ──
  const [deck, setDeck] = React.useState<FlashcardType[] | null>(null)
  const [cardIndex, setCardIndex] = React.useState(0)
  const [flipped, setFlipped] = React.useState(false)

  // ── Kuis ──
  const [quiz, setQuiz] = React.useState<QuizItemType[] | null>(null)
  const [quizIndex, setQuizIndex] = React.useState(0)
  const [quizInput, setQuizInput] = React.useState("")
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
    setMaterial(loadJSON<string>(MATERIAL_KEY, ""))
    setQuizLast(loadJSON<QuizLastScore | null>(QUIZ_LAST_KEY, null))
    setLoaded(true)
  }, [])

  // ── Autosave materi, debounce 500ms ──
  React.useEffect(() => {
    if (!loaded) return
    const timer = setTimeout(() => saveJSON(MATERIAL_KEY, material), 500)
    return () => clearTimeout(timer)
  }, [material, loaded])

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
      setMaterial((prev) => (prev.trim() ? `${prev}\n\n${text}` : text))
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
  const buildDeck = () => {
    if (!requireEnoughMaterial()) return
    setDeck(generateFlashcards(material))
    setCardIndex(0)
    setFlipped(false)
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
  const buildQuiz = () => {
    if (!requireEnoughMaterial()) return
    setQuiz(generateQuiz(material))
    setQuizIndex(0)
    setQuizInput("")
    setQuizResult(null)
    setQuizScore(0)
    setQuizWrong(0)
    setQuizFinished(false)
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

  const checkFillAnswer = () => {
    if (!quiz || quizResult !== null) return
    const item = quiz[quizIndex]
    if (!item || item.type !== "fill") return
    // Hanya jawaban asli yang diterima (lowercase + trim), distraktor tidak.
    const correct =
      quizInput.trim().toLowerCase() === item.answer.trim().toLowerCase()
    setQuizResult(correct)
    if (correct) setQuizScore((s) => s + 1)
    else setQuizWrong((w) => w + 1)
  }

  const answerTrueFalse = (choice: "Benar" | "Salah") => {
    if (!quiz || quizResult !== null) return
    const item = quiz[quizIndex]
    if (!item || item.type !== "tf") return
    const correct = choice === item.answer
    setQuizResult(correct)
    if (correct) setQuizScore((s) => s + 1)
    else setQuizWrong((w) => w + 1)
  }

  const nextQuiz = () => {
    if (!quiz) return
    if (quizIndex + 1 < quiz.length) {
      setQuizIndex((i) => i + 1)
      setQuizInput("")
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
          Tempel materi pelajaran sekali — rangkuman, flashcard, kuis, peta
          konsep, dan pembaca suara dibuat otomatis di perangkat Anda.
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        {/* ── 1. Textarea materi bersama ── */}
        <div className="flex flex-col gap-2">
          <Textarea
            value={material}
            onChange={(e) => setMaterial(e.target.value)}
            placeholder="Tempel atau tulis materi di sini… (minimal ±200 karakter agar fitur aktif)"
            className="min-h-36 resize-y text-sm leading-relaxed"
          />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">
              {stats.words} kata · {stats.sentences} kalimat ·{" "}
              {stats.chars} karakter · tersimpan otomatis
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={pasteFromClipboard}
                type="button"
              >
                <ClipboardPaste />
                Tempel dari clipboard
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
              <p className="text-sm text-muted-foreground">
                Kartu dibuat otomatis dari definisi, kata kunci tersamar, dan
                istilah penting.
              </p>
              <Button onClick={buildDeck} type="button" className="shrink-0">
                <Layers />
                Buat Flashcard
              </Button>
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
                  Soal isian & benar-salah dari isi materi.
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
              </div>
              <Button onClick={buildQuiz} type="button" className="shrink-0">
                <ListChecks />
                Buat Kuis
              </Button>
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
                    {currentQuizItem?.type === "fill"
                      ? "Isian"
                      : "Benar / Salah"}
                  </Badge>
                  <p className="text-sm leading-relaxed font-medium">
                    {currentQuizItem?.question}
                  </p>

                  {currentQuizItem?.type === "fill" ? (
                    <form
                      className="flex flex-col gap-2 sm:flex-row"
                      onSubmit={(e) => {
                        e.preventDefault()
                        checkFillAnswer()
                      }}
                    >
                      <Input
                        value={quizInput}
                        onChange={(e) => setQuizInput(e.target.value)}
                        disabled={quizResult !== null}
                        placeholder="Tulis jawabanmu…"
                        className="flex-1"
                        autoComplete="off"
                      />
                      <Button
                        type="submit"
                        size="sm"
                        disabled={quizResult !== null || !quizInput.trim()}
                      >
                        Periksa
                      </Button>
                    </form>
                  ) : (
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
                  )}

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
