"use client"

import * as React from "react"
import { Calculator, GraduationCap, ListChecks, Percent, Plus, Trash2 } from "lucide-react"
import { toast } from "sonner"

import { cn } from "@/lib/utils"
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
import { Label } from "@/components/ui/label"
import { Progress } from "@/components/ui/progress"

/* ------------------------------------------------------------------ */
/* Util bersama                                                        */
/* ------------------------------------------------------------------ */

type Predikat = { grade: string; label: string; className: string }

function predikatOf(v: number): Predikat {
  if (v >= 90)
    return {
      grade: "A",
      label: "Sangat Baik",
      className:
        "border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
    }
  if (v >= 80)
    return {
      grade: "B",
      label: "Baik",
      className: "border-transparent bg-sky-500/15 text-sky-700 dark:text-sky-400",
    }
  if (v >= 70)
    return {
      grade: "C",
      label: "Cukup",
      className:
        "border-transparent bg-amber-500/15 text-amber-700 dark:text-amber-400",
    }
  if (v >= 60)
    return {
      grade: "D",
      label: "Kurang",
      className:
        "border-transparent bg-orange-500/15 text-orange-700 dark:text-orange-400",
    }
  return {
    grade: "E",
    label: "Perlu Belajar Lagi",
    className: "border-transparent bg-destructive/15 text-destructive",
  }
}

function gcd(a: number, b: number): number {
  a = Math.abs(a)
  b = Math.abs(b)
  while (b) {
    ;[a, b] = [b, a % b]
  }
  return a || 1
}

function simplify(n: number, d: number): [number, number] {
  if (d === 0) return [n, d]
  const g = gcd(n, d)
  return [n / g, d / g]
}

/** Ubah string desimal ("0.75", "75", "-1.5") menjadi pecahan sederhana [p, q]. */
function decimalToFraction(s: string): [number, number] | null {
  const m = /^(-?)(\d*)(?:\.(\d*))?$/.exec(s.trim())
  if (!m) return null
  if (!m[2] && !m[3]) return null
  const sign = m[1] ? -1 : 1
  const int = m[2] || "0"
  const frac = m[3] ?? ""
  if (frac.length > 9) return null
  const num = Number(int + frac) * sign
  const den = 10 ** frac.length
  if (!Number.isFinite(num)) return null
  return simplify(num, den)
}

function fmtNum(n: number): string {
  if (!Number.isFinite(n)) return "—"
  return String(parseFloat(n.toFixed(6)))
}

/* ------------------------------------------------------------------ */
/* 1. Kalkulator — parser sendiri (tokenize + shunting-yard + RPN)     */
/* DILARANG memakai eval/Function.                                     */
/* ------------------------------------------------------------------ */

type Token =
  | { t: "num"; v: number }
  | { t: "op"; op: string } // + - * / % ^ u-
  | { t: "lp" }
  | { t: "rp" }

const PREC: Record<string, number> = {
  "+": 1,
  "-": 1,
  "*": 2,
  "/": 2,
  "%": 2,
  "^": 3,
  "u-": 3,
}
const RIGHT_ASSOC = new Set(["^", "u-"])

function tokenize(src: string): Token[] | null {
  const out: Token[] = []
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (c === " ") {
      i++
      continue
    }
    if ((c >= "0" && c <= "9") || c === ".") {
      let num = ""
      while (
        i < src.length &&
        ((src[i] >= "0" && src[i] <= "9") || src[i] === ".")
      ) {
        num += src[i]
        i++
      }
      // terima "5." & ".5" saat mengetik; tolak "1.2.3"
      if (!/^(\d+(\.\d*)?|\.\d+)$/.test(num)) return null
      out.push({ t: "num", v: parseFloat(num) })
      continue
    }
    if (c === "(") {
      out.push({ t: "lp" })
      i++
      continue
    }
    if (c === ")") {
      out.push({ t: "rp" })
      i++
      continue
    }
    if (c === "+" || c === "*" || c === "/" || c === "%" || c === "^" || c === "×" || c === "÷") {
      const op = c === "×" ? "*" : c === "÷" ? "/" : c
      out.push({ t: "op", op })
      i++
      continue
    }
    if (c === "-" || c === "−") {
      const prev = out[out.length - 1]
      const unary = !prev || prev.t === "op" || prev.t === "lp"
      out.push({ t: "op", op: unary ? "u-" : "-" })
      i++
      continue
    }
    return null
  }
  return out.length ? out : null
}

function toRPN(tokens: Token[]): Array<number | string> | null {
  const out: Array<number | string> = []
  const ops: string[] = []
  for (const tk of tokens) {
    if (tk.t === "num") {
      out.push(tk.v)
      continue
    }
    if (tk.t === "op") {
      while (ops.length) {
        const top = ops[ops.length - 1]
        if (top === "(") break
        if (
          PREC[top] > PREC[tk.op] ||
          (PREC[top] === PREC[tk.op] && !RIGHT_ASSOC.has(tk.op))
        ) {
          out.push(ops.pop() as string)
        } else {
          break
        }
      }
      ops.push(tk.op)
      continue
    }
    if (tk.t === "lp") {
      ops.push("(")
      continue
    }
    // t === "rp"
    while (ops.length && ops[ops.length - 1] !== "(") {
      out.push(ops.pop() as string)
    }
    if (!ops.length) return null // kurung tidak seimbang
    ops.pop()
  }
  while (ops.length) {
    const op = ops.pop() as string
    if (op === "(") return null // kurung tidak seimbang
    out.push(op)
  }
  return out
}

function evalRPN(rpn: Array<number | string>): number | null {
  const st: number[] = []
  for (const it of rpn) {
    if (typeof it === "number") {
      st.push(it)
      continue
    }
    if (it === "u-") {
      const a = st.pop()
      if (a === undefined) return null
      st.push(-a)
      continue
    }
    const b = st.pop()
    const a = st.pop()
    if (a === undefined || b === undefined) return null
    switch (it) {
      case "+":
        st.push(a + b)
        break
      case "-":
        st.push(a - b)
        break
      case "*":
        st.push(a * b)
        break
      case "/":
        st.push(a / b)
        break
      case "%":
        st.push(a % b)
        break
      case "^":
        st.push(Math.pow(a, b))
        break
      default:
        return null
    }
  }
  if (st.length !== 1 || !Number.isFinite(st[0])) return null
  return st[0]
}

function round10(v: number): number {
  return Math.round(v * 1e10) / 1e10
}

function evaluateExpression(src: string): number | null {
  const tokens = tokenize(src)
  if (!tokens) return null
  const rpn = toRPN(tokens)
  if (!rpn) return null
  const v = evalRPN(rpn)
  if (v === null) return null
  return round10(v)
}

const KEYS = [
  "C", "⌫", "(", ")", "^",
  "7", "8", "9", "÷", "×",
  "4", "5", "6", "−", "%",
  "1", "2", "3", "+",
  "0", ".", "=",
]

function CalculatorTool() {
  const [expr, setExpr] = React.useState("")
  const [history, setHistory] = React.useState<
    { expr: string; result: string }[]
  >([])
  const justEq = React.useRef(false)

  const preview = React.useMemo(() => {
    if (!expr.trim()) return null
    const r = evaluateExpression(expr)
    return r === null ? "invalid" : String(r)
  }, [expr])

  function press(k: string) {
    if (k === "C") {
      setExpr("")
      justEq.current = false
      return
    }
    if (k === "⌫") {
      setExpr((s) => s.slice(0, -1))
      justEq.current = false
      return
    }
    if (k === "=") {
      if (justEq.current) return // hasil barusan dievaluasi
      const r = evaluateExpression(expr)
      if (r === null) {
        toast.error("Ekspresi tidak valid")
        return
      }
      const formatted = String(r)
      setHistory((h) =>
        [{ expr, result: formatted }, ...h.filter((x) => x.expr !== expr)].slice(0, 5)
      )
      setExpr(formatted)
      justEq.current = true
      return
    }
    if (justEq.current && /^[0-9.]$/.test(k)) {
      // mulai ekspresi baru setelah "=" bila mengetik angka
      setExpr(k)
      justEq.current = false
      return
    }
    justEq.current = false
    setExpr((s) => s + k)
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Calculator className="size-4" />
          Kalkulator
        </CardTitle>
        <CardDescription>
          Mendukung + − × ÷ modulo (%) pangkat (^) dan tanda kurung.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="bg-muted/40 rounded-lg border p-3">
          <p className="min-h-7 text-right font-mono text-lg font-semibold break-all">
            {expr || "0"}
          </p>
          <p
            className={cn(
              "min-h-5 text-right",
              preview === "invalid"
                ? "text-destructive/80 text-xs"
                : "text-muted-foreground text-sm"
            )}
          >
            {preview === "invalid"
              ? "Ekspresi tidak valid"
              : preview !== null
                ? `= ${preview}`
                : ""}
          </p>
        </div>

        <div className="grid grid-cols-5 gap-1.5">
          {KEYS.map((k) => (
            <Button
              key={k}
              variant={k === "=" ? "default" : "outline"}
              className={cn(
                "h-11 text-base font-medium",
                k === "0" && "col-span-2",
                k === "+" && "col-span-2",
                k === "=" && "col-span-2",
                k === "C" && "text-destructive hover:text-destructive"
              )}
              onClick={() => press(k)}
            >
              {k}
            </Button>
          ))}
        </div>

        {history.length > 0 && (
          <div className="flex flex-col gap-1">
            <p className="text-muted-foreground text-xs font-medium">
              Riwayat (klik untuk pakai ulang)
            </p>
            {history.map((h, i) => (
              <Button
                key={`${h.expr}-${i}`}
                variant="ghost"
                className="h-8 justify-between px-2 font-mono text-xs"
                onClick={() => {
                  setExpr(h.result)
                  justEq.current = true
                }}
              >
                <span className="truncate">{h.expr}</span>
                <span className="font-semibold">= {h.result}</span>
              </Button>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

/* ------------------------------------------------------------------ */
/* 2. Hitung Nilai — rata-rata tertimbang                              */
/* ------------------------------------------------------------------ */

function GradeCalculator() {
  const [rows, setRows] = React.useState<{ score: string; weight: string }[]>([
    { score: "", weight: "1" },
    { score: "", weight: "1" },
  ])

  const parsed = React.useMemo(() => {
    const valid: { s: number; w: number }[] = []
    let hasInvalid = false
    for (const r of rows) {
      const filled = r.score.trim() !== "" || r.weight.trim() !== ""
      if (!filled) continue
      const s = Number(r.score)
      const w = Number(r.weight)
      if (
        r.score.trim() === "" ||
        !Number.isFinite(s) ||
        !Number.isFinite(w) ||
        s < 0 ||
        s > 100 ||
        w < 0
      ) {
        hasInvalid = true
        continue
      }
      valid.push({ s, w })
    }
    return { valid, hasInvalid }
  }, [rows])

  const wSum = parsed.valid.reduce((a, r) => a + r.w, 0)
  const avg =
    parsed.valid.length > 0 && wSum > 0
      ? parsed.valid.reduce((a, r) => a + r.s * r.w, 0) / wSum
      : null
  const p = avg !== null ? predikatOf(avg) : null

  function update(i: number, field: "score" | "weight", v: string) {
    setRows((prev) =>
      prev.map((r, idx) => (idx === i ? { ...r, [field]: v } : r))
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <GraduationCap className="size-4" />
          Hitung Nilai
        </CardTitle>
        <CardDescription>
          Rata-rata tertimbang dari nilai + bobot setiap komponen.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-col gap-2">
          {rows.map((row, i) => (
            <div key={i} className="flex items-center gap-2">
              <Input
                type="number"
                min={0}
                max={100}
                step="0.01"
                placeholder="Nilai (0–100)"
                value={row.score}
                onChange={(e) => update(i, "score", e.target.value)}
                className="flex-1"
              />
              <span className="text-muted-foreground text-xs whitespace-nowrap">
                × bobot
              </span>
              <Input
                type="number"
                min={0}
                step="0.5"
                placeholder="1"
                value={row.weight}
                onChange={(e) => update(i, "weight", e.target.value)}
                className="w-20"
              />
              <Button
                variant="ghost"
                size="icon"
                className="text-destructive size-8 shrink-0 hover:text-destructive"
                disabled={rows.length <= 1}
                title="Hapus baris"
                onClick={() =>
                  setRows((prev) => prev.filter((_, idx) => idx !== i))
                }
              >
                <Trash2 className="size-4" />
              </Button>
            </div>
          ))}
        </div>
        <Button
          variant="outline"
          size="sm"
          className="w-fit"
          onClick={() =>
            setRows((prev) => [...prev, { score: "", weight: "1" }])
          }
        >
          <Plus className="size-4" />
          Tambah baris
        </Button>

        {avg !== null && p ? (
          <div className="bg-muted/40 flex flex-col gap-2 rounded-lg border p-3">
            <div className="flex items-end justify-between gap-2">
              <div>
                <p className="text-muted-foreground text-xs">
                  Rata-rata tertimbang
                </p>
                <p className="text-3xl font-bold tabular-nums">{fmtNum(avg)}</p>
              </div>
              <Badge className={p.className}>
                {p.grade} · {p.label}
              </Badge>
            </div>
            <Progress value={Math.min(100, Math.max(0, avg))} className="h-2" />
            {parsed.hasInvalid && (
              <p className="text-xs text-amber-600 dark:text-amber-400">
                Beberapa baris diabaikan karena tidak valid (nilai 0–100, bobot
                ≥ 0).
              </p>
            )}
          </div>
        ) : (
          <p className="text-muted-foreground rounded-lg border border-dashed p-3 text-center text-xs">
            Isi minimal satu baris nilai untuk melihat rata-rata.
          </p>
        )}
      </CardContent>
    </Card>
  )
}

/* ------------------------------------------------------------------ */
/* 3. Konverter Persen                                                 */
/* ------------------------------------------------------------------ */

function PercentConverter() {
  const [persen, setPersen] = React.useState("75")
  const [a, setA] = React.useState("3")
  const [b, setB] = React.useState("4")
  const [desimal, setDesimal] = React.useState("0.75")

  const fracValid =
    a.trim() !== "" &&
    b.trim() !== "" &&
    Number.isFinite(Number(a)) &&
    Number.isFinite(Number(b)) &&
    Number(b) !== 0

  function onPersen(v: string) {
    setPersen(v)
    const p = Number(v)
    if (v.trim() === "" || !Number.isFinite(p)) return
    const f = decimalToFraction(v)
    if (f) {
      const [n, d] = f
      // p = n/d persen → rasio = n / (d × 100)
      const [ra, rb] = simplify(n, d * 100)
      setA(String(ra))
      setB(String(rb))
    }
    setDesimal(fmtNum(p / 100))
  }

  function onDesimal(v: string) {
    setDesimal(v)
    const f = decimalToFraction(v)
    if (!f) return
    const [n, d] = f
    if (d === 0) return
    setA(String(n))
    setB(String(d))
    setPersen(fmtNum((n / d) * 100))
  }

  function onFrac(which: "a" | "b", v: string) {
    if (which === "a") setA(v)
    else setB(v)
    const aStr = which === "a" ? v : a
    const bStr = which === "b" ? v : b
    const an = Number(aStr)
    const bn = Number(bStr)
    if (
      aStr.trim() === "" ||
      bStr.trim() === "" ||
      !Number.isFinite(an) ||
      !Number.isFinite(bn) ||
      bn === 0
    ) {
      return
    }
    setDesimal(fmtNum(an / bn))
    setPersen(fmtNum((an / bn) * 100))
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Percent className="size-4" />
          Konverter Persen
        </CardTitle>
        <CardDescription>
          Ubah-ubah antara persen, pecahan, dan desimal.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="grid grid-cols-2 items-end gap-3 sm:grid-cols-[1fr_auto_1fr]">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="cv-persen" className="text-xs">
              Persen
            </Label>
            <div className="relative">
              <Input
                id="cv-persen"
                inputMode="decimal"
                value={persen}
                onChange={(e) => onPersen(e.target.value)}
                className="pr-7"
              />
              <span className="text-muted-foreground absolute top-1/2 right-2.5 -translate-y-1/2 text-xs">
                %
              </span>
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs">Pecahan</Label>
            <div className="flex items-center gap-1.5">
              <Input
                inputMode="numeric"
                value={a}
                onChange={(e) => onFrac("a", e.target.value)}
                className="w-16 text-center"
                aria-label="Pembilang pecahan"
              />
              <span className="text-muted-foreground font-medium">/</span>
              <Input
                inputMode="numeric"
                value={b}
                onChange={(e) => onFrac("b", e.target.value)}
                className="w-16 text-center"
                aria-label="Penyebut pecahan"
              />
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="cv-desimal" className="text-xs">
              Desimal
            </Label>
            <Input
              id="cv-desimal"
              inputMode="decimal"
              value={desimal}
              onChange={(e) => onDesimal(e.target.value)}
            />
          </div>
        </div>

        <div className="bg-muted/40 rounded-lg border p-3 text-center text-sm">
          {fracValid ? (
            <>
              <p className="font-semibold">
                {a}/{b} dari 100 = {fmtNum((Number(a) / Number(b)) * 100)}
              </p>
              <p className="text-muted-foreground mt-1 text-xs">
                {persen || "?"}% = {desimal || "?"} = {a}/{b}
              </p>
            </>
          ) : (
            <p className="text-muted-foreground text-xs">
              Penyebut pecahan tidak boleh nol.
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

/* ------------------------------------------------------------------ */
/* 4. Skor Pilihan Ganda                                               */
/* ------------------------------------------------------------------ */

function McqScore() {
  const [benar, setBenar] = React.useState("")
  const [salah, setSalah] = React.useState("")
  const [total, setTotal] = React.useState("")

  const numOr = (x: string) => (/^\d+$/.test(x.trim()) ? parseInt(x, 10) : null)
  const b = numOr(benar)
  const s = numOr(salah)
  const t = numOr(total)
  const allSet = b !== null && s !== null && t !== null
  const anyInvalid = [benar, salah, total].some(
    (x) => x.trim() !== "" && !/^\d+$/.test(x.trim())
  )
  const sumExceed = allSet && t > 0 && b + s > t
  const ready = allSet && t > 0 && !sumExceed && !anyInvalid
  const nilai = ready && t !== null && b !== null ? (b / t) * 100 : null
  const p = nilai !== null ? predikatOf(nilai) : null

  const error = anyInvalid
    ? "Isi dengan angka bulat ≥ 0"
    : allSet && t === 0
      ? "Total soal harus lebih dari 0"
      : sumExceed
        ? "Benar + salah tidak boleh melebihi total soal"
        : null

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ListChecks className="size-4" />
          Skor Pilihan Ganda
        </CardTitle>
        <CardDescription>
          Hitung nilai ujian pilihan gandamu secara instan.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="grid grid-cols-3 gap-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="mcq-right" className="text-xs">
              Benar
            </Label>
            <Input
              id="mcq-right"
              type="number"
              min={0}
              placeholder="mis. 20"
              value={benar}
              onChange={(e) => setBenar(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="mcq-wrong" className="text-xs">
              Salah
            </Label>
            <Input
              id="mcq-wrong"
              type="number"
              min={0}
              placeholder="mis. 5"
              value={salah}
              onChange={(e) => setSalah(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="mcq-total" className="text-xs">
              Total soal
            </Label>
            <Input
              id="mcq-total"
              type="number"
              min={1}
              placeholder="mis. 25"
              value={total}
              onChange={(e) => setTotal(e.target.value)}
            />
          </div>
        </div>

        {error && (
          <p className="text-xs font-medium text-destructive">⚠ {error}</p>
        )}

        {nilai !== null && p && b !== null && s !== null && t !== null ? (
          <div className="bg-muted/40 flex flex-col gap-2 rounded-lg border p-3">
            <div className="flex items-end justify-between gap-2">
              <div>
                <p className="text-muted-foreground text-xs">Nilai</p>
                <p className="text-3xl font-bold tabular-nums">
                  {fmtNum(nilai)}
                </p>
              </div>
              <Badge className={p.className}>
                {p.grade} · {p.label}
              </Badge>
            </div>
            <Progress value={Math.min(100, Math.max(0, nilai))} className="h-2" />
            <p className="text-muted-foreground text-xs">
              Benar {b} · Salah {s} · Kosong {t - b - s} · Total {t} soal
            </p>
          </div>
        ) : (
          !error && (
            <p className="text-muted-foreground rounded-lg border border-dashed p-3 text-center text-xs">
              Isi jumlah soal untuk melihat nilainya.
            </p>
          )
        )}
      </CardContent>
    </Card>
  )
}

/* ------------------------------------------------------------------ */
/* Komponen utama                                                     */
/* ------------------------------------------------------------------ */

export function QuickTools() {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <CalculatorTool />
      <GradeCalculator />
      <PercentConverter />
      <McqScore />
    </div>
  )
}
