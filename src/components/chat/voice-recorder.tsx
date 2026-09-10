"use client";

// Tombol rekam pesan suara — MediaRecorder → file audio/webm → unggah ke
// cloud (jalur lampiran chat biasa) → masuk antrian lampiran pesan.

import { useEffect, useRef, useState } from "react";
import { Mic, Send, Square, Trash2, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { uploadSmart } from "@/lib/upload-client";
import { cn } from "@/lib/utils";

interface UploadedVoice {
  fileId: string;
  name: string;
  size: number;
  mimetype: string;
  storageKey: string;
}

export function VoiceRecorder({
  conversation,
  disabled,
  onUploaded,
}: {
  conversation: { kind: "classroom" | "group" | "dm"; id: string };
  disabled?: boolean;
  onUploaded: (v: UploadedVoice) => void;
}) {
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [asking, setAsking] = useState(false); // konfirmasi izin mikrofon ditolak
  const mediaRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const MAX_SEC = 120; // 2 menit

  useEffect(() => {
    return () => {
      // Bersih-bersih saat unmount.
      if (timerRef.current) clearInterval(timerRef.current);
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  async function start() {
    if (disabled || recording || uploading) return;
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      toast.error("Browser ini tidak mendukung perekaman suara");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : MediaRecorder.isTypeSupported("audio/webm")
          ? "audio/webm"
          : "";
      const rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
      mediaRef.current = rec;
      chunksRef.current = [];
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      rec.onstop = () => void finish(mime || rec.mimeType || "audio/webm");
      rec.start(500);
      setRecording(true);
      setElapsed(0);
      setAsking(false);
      timerRef.current = setInterval(() => {
        setElapsed((s) => {
          if (s + 1 >= MAX_SEC) {
            // Batas 2 menit — stop otomatis.
            if (mediaRef.current?.state === "recording") {
              mediaRef.current.stop();
            }
          }
          return s + 1;
        });
      }, 1000);
    } catch {
      setAsking(true);
      toast.error("Izin mikrofon ditolak — aktifkan izin mikrofon di browser");
    }
  }

  function stopRecording() {
    if (mediaRef.current?.state === "recording") mediaRef.current.stop();
    if (timerRef.current) clearInterval(timerRef.current);
    setRecording(false);
  }

  function cancel() {
    if (mediaRef.current?.state === "recording") {
      mediaRef.current.onstop = null;
      mediaRef.current.stop();
    }
    if (timerRef.current) clearInterval(timerRef.current);
    streamRef.current?.getTracks().forEach((t) => t.stop());
    setRecording(false);
    chunksRef.current = [];
  }

  async function finish(mime: string) {
    if (timerRef.current) clearInterval(timerRef.current);
    streamRef.current?.getTracks().forEach((t) => t.stop());
    const blob = new Blob(chunksRef.current, { type: mime });
    chunksRef.current = [];
    if (blob.size < 500) {
      toast.error("Perekaman terlalu pendek");
      return;
    }
    const ext = mime.includes("webm") ? "webm" : "m4a";
    const stamp = new Date();
    const name = `suara-${stamp.getHours()}${String(stamp.getMinutes()).padStart(2, "0")}-${String(
      stamp.getSeconds()
    ).padStart(2, "0")}.${ext}`;
    const file = new File([blob], name, { type: "audio/webm" });
    setUploading(true);
    try {
      const res = await uploadSmart<{
        fileId?: string;
        name?: string;
        size?: number;
        mimetype?: string;
        storageKey?: string;
        error?: string;
      }>(file, {
        kind: "attachment",
        convKind: conversation.kind,
        convId: conversation.id,
      });
      const json = res.json;
      if (!res.ok || !json?.fileId) {
        throw new Error(json?.error || "Upload gagal");
      }
      onUploaded({
        fileId: json.fileId,
        name: json.name ?? name,
        size: json.size ?? blob.size,
        mimetype: json.mimetype ?? "audio/webm",
        storageKey: json.storageKey ?? "",
      });
      toast.success("Rekaman suara siap dikirim");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Gagal mengunggah rekaman");
    } finally {
      setUploading(false);
    }
  }

  const mm = String(Math.floor(elapsed / 60)).padStart(2, "0");
  const ss = String(elapsed % 60).padStart(2, "0");

  if (uploading) {
    return (
      <Button
        type="button"
        size="icon"
        variant="ghost"
        disabled
        className="h-10 w-10 shrink-0 rounded-full"
        title="Mengunggah rekaman…"
      >
        <Loader2 className="h-4 w-4 animate-spin" />
      </Button>
    );
  }

  if (!recording) {
    return (
      <Button
        type="button"
        size="icon"
        variant="ghost"
        disabled={disabled}
        onClick={() => void start()}
        aria-label="Rekam pesan suara"
        title="Rekam pesan suara (maks 2 menit)"
        className="h-10 w-10 shrink-0 rounded-full"
      >
        <Mic className="h-4 w-4" />
      </Button>
    );
  }

  return (
    <div className="flex items-center gap-2 rounded-full border border-destructive/40 bg-destructive/5 pl-3 pr-1 py-1">
      <span className="relative flex size-2.5">
        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-destructive opacity-75" />
        <span className="relative inline-flex rounded-full size-2.5 bg-destructive" />
      </span>
      <span className="font-mono text-xs font-semibold tabular-nums text-destructive">
        {mm}:{ss}
      </span>
      <span className="text-[10px] text-muted-foreground hidden sm:inline">
        merekam…
      </span>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        onClick={cancel}
        aria-label="Buang rekaman"
        title="Buang rekaman"
        className="size-8 rounded-full text-muted-foreground"
      >
        <Trash2 className="size-4" />
      </Button>
      <Button
        type="button"
        size="icon"
        onClick={stopRecording}
        aria-label="Selesai merekam, unggah"
        title="Selesai & lampirkan"
        className={cn("size-8 rounded-full bg-destructive hover:bg-destructive/90")}
      >
        <Square className="size-3.5 fill-current" />
      </Button>
      <Send className="size-3.5 text-muted-foreground opacity-0" />
    </div>
  );
}
