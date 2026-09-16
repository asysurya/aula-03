// ── Snapshot area kerja untuk REKAM PENGERJAAN TUGAS ──────────────────
// Mengambil DOM area kerja siswa (FormPlayer saat playing) dan mengubahnya
// jadi string HTML yang aman untuk disimpan & diputar ulang di sisi guru:
//   1. Elemen bertanda data-rec-skip dibuang (indikator rekaman, dsb.)
//   2. Nilai input/textarea/select DISERIALISASI ke atribut (clone DOM
//      tidak membawa nilai yang sedang diketik)
//   3. Node berbahaya dibuang: script/iframe/object/embed/link/meta/form
//   4. Atribut on* dibuang; href/src "javascript:" dinetralkan
//   5. Tema (dark/light) + waktu tangkap disimpan sebagai atribut root
// Frame diputar guru dalam <iframe sandbox> + stylesheet aplikasi —
// tampilan menyerupai layar siswa saat frame diambil.

const DANGEROUS_TAGS = "script,iframe,object,embed,link,meta,form,base";

/** Sanitasi satu elemen clone: buang atribut on* & javascript: URL. */
function stripAttrs(el: Element) {
  for (const attr of [...el.attributes]) {
    const name = attr.name.toLowerCase();
    if (name.startsWith("on")) {
      el.removeAttribute(attr.name);
    } else if (
      (name === "href" || name === "src" || name === "xlink:href") &&
      attr.value.trim().toLowerCase().replace(/\s+/g, "").startsWith("javascript:")
    ) {
      el.removeAttribute(attr.name);
    }
  }
}

/**
 * Tangkap snapshot HTML area kerja. Mengembalikan fragment HTML (tanpa
 * <html>/<head>) atau null bila gagal/root kosong. Aman dipanggil dari
 * browser saja (butuh document).
 */
export function captureWorkSnapshot(root: HTMLElement | null): string | null {
  if (!root || typeof window === "undefined" || !document) return null;
  try {
    const clone = root.cloneNode(true) as HTMLElement;

    // 1. Buang elemen yang tak perlu direkam.
    clone.querySelectorAll("[data-rec-skip]").forEach((n) => n.remove());

    // 2. Buang node berbahaya.
    clone.querySelectorAll(DANGEROUS_TAGS).forEach((n) => n.remove());

    // 3. Serialisasi nilai kontrol: pasangkan elemen asli ↔ clone
    //    (querySelectorAll mengembalikan urutan sama karena strukturnya
    //    identik hasil cloneNode).
    const src = root.querySelectorAll("input,textarea,select");
    const dst = clone.querySelectorAll("input,textarea,select");
    src.forEach((s, i) => {
      const d = dst[i];
      if (!d) return;
      if (s instanceof HTMLTextAreaElement) {
        d.textContent = s.value;
      } else if (s instanceof HTMLSelectElement) {
        const opts = d.querySelectorAll("option");
        for (let oi = 0; oi < opts.length; oi++) {
          const real = s.options[oi];
          if (real?.selected) opts[oi].setAttribute("selected", "");
          else opts[oi].removeAttribute("selected");
        }
      } else if (s instanceof HTMLInputElement) {
        d.setAttribute("value", s.value);
        if (s.type === "checkbox" || s.type === "radio") {
          if (s.checked) d.setAttribute("checked", "");
          else d.removeAttribute("checked");
        }
      }
    });

    // 4. Sanitasi seluruh atribut (termasuk root clone).
    stripAttrs(clone);
    clone.querySelectorAll("*").forEach(stripAttrs);

    // 5. Metadata: tema saat tangkap + waktu — dipakai viewer untuk
    //    mereproduksi tampilan (class "dark" pada <html> iframe).
    clone.removeAttribute("id");
    clone.setAttribute("data-rec-theme", document.documentElement.className || "");
    clone.setAttribute("data-rec-at", new Date().toISOString());

    return clone.outerHTML;
  } catch {
    return null;
  }
}

/** Ambil tema dari fragment rekaman ("dark" bila siswa merekam saat dark mode). */
export function recordingThemeIsDark(fragment: string): boolean {
  const m = fragment.match(/data-rec-theme="([^"]*)"/);
  return !!m && m[1].includes("dark");
}

/**
 * Bangun dokumen lengkap untuk merender satu fragment rekaman di iframe.
 * Fragment memakai kelas Tailwind aplikasi → stylesheet aktif disertakan,
 * <base> mengarah ke origin aplikasi supaya URL relatif (gambar soal,
 * avatar) tetap resolve saat diputar ulang.
 */
export function buildRecordingDoc(fragment: string): string {
  const dark = recordingThemeIsDark(fragment);
  const links = typeof document !== "undefined"
    ? [...document.querySelectorAll('link[rel="stylesheet"]')]
        .map((l) => l.getAttribute("href") || "")
        .filter(Boolean)
        .map((h) => `<link rel="stylesheet" href="${h}">`)
        .join("")
    : "";
  const base =
    typeof window !== "undefined" ? window.location.origin + "/" : "/";
  return `<!doctype html><html class="${dark ? "dark" : ""}"><head><meta charset="utf-8"><base href="${base}">${links}<style>html,body{margin:0;padding:0;overflow:auto}body{-webkit-font-smoothing:antialiased}</style></head><body class="bg-background text-foreground"><div style="padding:12px;min-height:100vh">${fragment}</div></body></html>`;
}
