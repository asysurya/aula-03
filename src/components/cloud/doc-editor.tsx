"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { formatDistanceToNow } from "date-fns";
import { id as localeId } from "date-fns/locale";
import { toast } from "sonner";
import { ArrowLeft, Check, Loader2, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useUIStore } from "@/stores/ui-store";

interface DocData {
  id: string;
  title: string;
  content: string;
  folderId: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

function fmtRelative(iso: string) {
  try {
    return formatDistanceToNow(new Date(iso), {
      addSuffix: true,
      locale: localeId,
    });
  } catch {
    return iso;
  }
}

export function DocEditor({ docId }: { docId: string }) {
  const openCloudFolder = useUIStore((s) => s.openCloudFolder);
  const cloudFolderId = useUIStore((s) => s.cloudFolderId);
  const cloudClassroomId = useUIStore((s) => s.cloudClassroomId);

  const [doc, setDoc] = useState<DocData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);
  const [remoteUpdated, setRemoteUpdated] = useState(false);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastRemoteContentRef = useRef<string>("");
  /** Versi (updatedAt) terbaru yang pernah kita terima/tulis — penjaga
   *  anti race: poll yang berangkat SEBELUM autosave bisa pulang SETELAHNYA
   *  membawa konten lama; tanpa penjaga ini konten lama menimpa hasil
   *  simpanan & dianggap "bersih" → suntingan hilang diam-diam. */
  const lastKnownUpdatedAtRef = useRef<string | null>(null);
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;

  const fetchDoc = useCallback(async () => {
    try {
      const res = await fetch(`/api/cloud/docs/${docId}`, { cache: "no-store" });
      if (!res.ok) throw new Error("Gagal memuat dokumen");
      const json = (await res.json()) as { doc: DocData };
      const d = json.doc;
      // Abaikan hasil poll yang lebih LAMA dari versi terakhir yang kita
      // ketahui (balasan GET basi yang terlambat pulang).
      if (
        lastKnownUpdatedAtRef.current &&
        d.updatedAt !== lastKnownUpdatedAtRef.current &&
        new Date(d.updatedAt).getTime() <
          new Date(lastKnownUpdatedAtRef.current).getTime()
      ) {
        return;
      }
      lastKnownUpdatedAtRef.current = d.updatedAt;
      setDoc(d);
      lastRemoteContentRef.current = d.content;
      // Only update local fields when not dirty.
      setTitle((prev) => (prev === "" ? d.title : prev));
      setLastSavedAt(d.updatedAt);
      setContent((prev) => {
        if (prev === "" || prev === lastRemoteContentRef.current) {
          return d.content;
        }
        // Local edits pending — flag remote change.
        if (d.content !== lastRemoteContentRef.current) {
          setRemoteUpdated(true);
        }
        return prev;
      });
      setError(null);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Kesalahan jaringan";
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [docId]);

  useEffect(() => {
    setLoading(true);
    void fetchDoc();
  }, [fetchDoc]);

  // Polling for remote changes every 5s.
  useEffect(() => {
    const id = setInterval(() => {
      void fetchDoc();
    }, 5000);
    return () => clearInterval(id);
  }, [fetchDoc]);

  // Debounced autosave on title/content change.
  useEffect(() => {
    if (!doc) return;
    if (title === doc.title && content === doc.content) {
      setDirty(false);
      return;
    }
    setDirty(true);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      void save();
    }, 1500);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [title, content, doc]);

  async function save() {
    if (!doc) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/cloud/docs/${docId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, content }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => null);
        toast.error(j?.error || "Gagal menyimpan");
        return;
      }
      const json = (await res.json()) as { doc: DocData };
      setDoc(json.doc);
      lastRemoteContentRef.current = json.doc.content;
      // Versi hasil tulis kita = versi terbaru yang kita ketahui.
      lastKnownUpdatedAtRef.current = json.doc.updatedAt;
      setLastSavedAt(json.doc.updatedAt);
      setDirty(false);
      setRemoteUpdated(false);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Kesalahan jaringan";
      toast.error(msg);
    } finally {
      setSaving(false);
    }
  }

  // Flush suntingan yang masih di debounce saat komponen ditutup /
  // tab disembunyikan — dulu: timer dibatalkan diam-diam → suntingan
  // <1,5 dtk terakhir HILANG.
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    const flush = () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
      if (dirtyRef.current) void saveRef.current();
    };
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      flush();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleBack() {
    openCloudFolder(cloudFolderId, cloudClassroomId);
  }

  if (loading) {
    return (
      <div className="p-4 space-y-3 max-w-4xl mx-auto">
        <Skeleton className="h-9 w-2/3" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (error || !doc) {
    return (
      <div className="p-6 text-center text-sm text-destructive">
        {error || "Dokumen tidak ditemukan."}
        <div className="mt-2">
          <Button variant="link" onClick={handleBack}>
            Kembali ke folder
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="border-b border-border px-4 py-2.5 flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={handleBack}>
          <ArrowLeft className="size-4" /> Kembali
        </Button>
        <div className="flex-1 min-w-0">
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="h-8 border-transparent bg-transparent focus-visible:border-input focus-visible:bg-background font-medium text-base"
            placeholder="Judul dokumen"
          />
        </div>
        <div className="text-xs text-muted-foreground flex items-center gap-1.5">
          {saving ? (
            <>
              <Loader2 className="size-3 animate-spin" /> Menyimpan…
            </>
          ) : dirty ? (
            <>
              <RefreshCw className="size-3" /> Belum tersimpan
            </>
          ) : lastSavedAt ? (
            <>
              <Check className="size-3 text-emerald-500" /> Tersimpan {fmtRelative(lastSavedAt)}
            </>
          ) : null}
        </div>
      </div>

      {remoteUpdated ? (
        <div className="bg-amber-500/10 border-b border-amber-500/30 px-4 py-1.5 text-xs text-amber-700 dark:text-amber-300">
          Diperbarui anggota lain. Perubahanmu lokal — simpan untuk menimpa.
        </div>
      ) : null}

      <div className="flex-1 overflow-y-auto p-4">
        <div className="max-w-4xl mx-auto">
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="Mulai menulis…"
            className="w-full min-h-[60vh] resize-y rounded-md border border-border bg-background p-4 text-sm leading-relaxed font-mono focus:outline-none focus:ring-2 focus:ring-primary/40"
            spellCheck={false}
          />
        </div>
      </div>
    </div>
  );
}
