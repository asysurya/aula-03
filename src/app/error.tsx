"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { AlertTriangle, RefreshCw } from "lucide-react";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("App error:", error);
  }, [error]);

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-background">
      <div className="max-w-md w-full space-y-4 text-center">
        <div className="mx-auto h-12 w-12 rounded-full bg-destructive/10 flex items-center justify-center">
          <AlertTriangle className="h-6 w-6 text-destructive" />
        </div>
        <div className="space-y-1">
          <h2 className="text-xl font-semibold">Terjadi kesalahan</h2>
          <p className="text-sm text-muted-foreground">
            Gagal memuat aplikasi. Pastikan database (MongoDB) sudah dikonfigurasi.
          </p>
        </div>
        <div className="rounded-md border border-border bg-muted/50 p-3 text-left">
          <p className="text-xs font-mono text-muted-foreground break-all">
            {error.message || "Unknown error"}
          </p>
        </div>
        <div className="flex gap-2 justify-center">
          <Button onClick={reset} variant="outline" className="gap-1.5">
            <RefreshCw className="h-4 w-4" /> Coba lagi
          </Button>
          <Button onClick={() => window.location.reload()}>
            Muat ulang halaman
          </Button>
        </div>
      </div>
    </div>
  );
}
