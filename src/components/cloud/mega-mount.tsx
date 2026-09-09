"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { id as localeId } from "date-fns/locale";
import {
  AlertTriangle,
  ChevronRight,
  Folder,
  HardDrive,
  Loader2,
  RefreshCw,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { FilePreview } from "@/components/cloud/file-preview";
import { MegaLogo } from "@/components/cloud/mega-logo";
import {
  formatBytes,
  mimetypeFromName,
  type CloudFileItem,
} from "@/lib/cloud-format";

// ───────────────────────── Types ─────────────────────────

interface MegaEntry {
  nodeId: string;
  name: string;
  isFolder: boolean;
  size: number;
  timestamp: number | null;
}

interface MegaTreeResponse {
  ok: boolean;
  account: {
    id: string;
    email: string | null;
    name: string;
    status: string | null;
    fileCount: number;
    spaceUsed: number | null;
    spaceTotal: number | null;
    spaceUsedLabel: string | null;
    spaceTotalLabel: string | null;
  };
  nodeId: string;
  path: { id: string; name: string }[];
  entries: MegaEntry[];
}

// ───────────────────────── Component ─────────────────────────

/**
 * Tampilan "mount MEGA Cloud" — browse isi akun MEGA secara read-only
 * dari dalam file browser. Hanya guru/admin (dipaksa di API-nya).
 */
export function MegaMountView({
  onExit,
}: {
  onExit: () => void;
}) {
  const [nodeId, setNodeId] = useState<string | null>(null);
  const [previewFile, setPreviewFile] = useState<CloudFileItem | null>(null);

  const { data, isLoading, error, refetch, isFetching } =
    useQuery<MegaTreeResponse>({
      queryKey: ["mega-tree", nodeId ?? "root"],
      queryFn: async () => {
        const params = new URLSearchParams();
        if (nodeId) params.set("nodeId", nodeId);
        const res = await fetch(
          `/api/cloud/mega/tree?${params.toString()}`,
          { cache: "no-store" }
        );
        const json = await res.json();
        if (!res.ok) throw new Error(json?.error || "Gagal memuat MEGA");
        return json as MegaTreeResponse;
      },
    });

  const usagePct =
    data?.account.spaceTotal && data.account.spaceUsed != null
      ? Math.min(100, (data.account.spaceUsed / data.account.spaceTotal) * 100)
      : null;

  return (
    <div className="flex flex-col h-full">
      {/* Header MEGA */}
      <div className="border-b border-border px-4 py-3 flex items-center gap-3 flex-wrap">
        <div className="rounded-md bg-red-500/10 p-1.5">
          <MegaLogo className="size-5" />
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="font-semibold leading-tight truncate">
              MEGA Cloud
            </h2>
            {data?.account.status === "connected" ? (
              <Badge className="bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-0 text-[10px]">
                Terhubung
              </Badge>
            ) : null}
          </div>
          <p className="text-xs text-muted-foreground truncate">
            {data?.account.name ?? "MEGA"}
            {data?.account.email ? ` · ${data.account.email}` : ""}
          </p>
        </div>

        {/* Kuota */}
        {data?.account.spaceTotalLabel ? (
          <div className="ml-auto hidden sm:flex items-center gap-2 min-w-[180px] max-w-[260px]">
            <HardDrive className="size-4 text-muted-foreground shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="flex justify-between text-[10px] text-muted-foreground mb-0.5">
                <span>{data.account.spaceUsedLabel ?? "—"}</span>
                <span>/ {data.account.spaceTotalLabel}</span>
              </div>
              <div className="h-1.5 rounded-full bg-secondary overflow-hidden">
                <div
                  className="h-full rounded-full bg-red-500"
                  style={{ width: `${usagePct ?? 0}%` }}
                />
              </div>
            </div>
          </div>
        ) : null}

        <div className="ml-auto sm:ml-0 flex items-center gap-1">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => refetch()}
            title="Muat ulang"
          >
            <RefreshCw
              className={`size-4 ${isFetching ? "animate-spin" : ""}`}
            />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={onExit}
            title="Tutup mount MEGA"
          >
            <X className="size-4" />
          </Button>
        </div>
      </div>

      {/* Breadcrumb */}
      <div className="border-b border-border px-4 py-2">
        <Breadcrumb>
          <BreadcrumbList>
            {(data?.path ?? [{ id: "root", name: "MEGA" }]).map((p, i, arr) => {
              const isLast = i === arr.length - 1;
              return (
                <span key={p.id} className="contents">
                  {i > 0 ? <BreadcrumbSeparator /> : null}
                  <BreadcrumbItem>
                    {isLast ? (
                      <BreadcrumbPage className="flex items-center gap-1.5">
                        {i === 0 ? (
                          <MegaLogo className="size-3.5" />
                        ) : null}
                        {p.name}
                      </BreadcrumbPage>
                    ) : (
                      <BreadcrumbLink
                        className="cursor-pointer flex items-center gap-1.5"
                        onClick={() =>
                          setNodeId(p.id === "root" ? null : p.id)
                        }
                      >
                        {i === 0 ? (
                          <MegaLogo className="size-3.5" />
                        ) : null}
                        {p.name}
                      </BreadcrumbLink>
                    )}
                  </BreadcrumbItem>
                </span>
              );
            })}
          </BreadcrumbList>
        </Breadcrumb>
      </div>

      {/* Body */}
      <div className="flex-1 min-h-0">
        <ScrollArea className="h-full">
          <div className="p-4 space-y-4">
            <p className="text-[11px] text-muted-foreground flex items-center gap-1.5">
              <AlertTriangle className="size-3" />
              Mount bersifat baca-saja — upload &amp; hapus file lewat folder
              materi/tugas seperti biasa. File di sini adalah isi asli akun
              MEGA.
            </p>

            {isLoading ? (
              <div className="space-y-2">
                {Array.from({ length: 6 }).map((_, i) => (
                  <Skeleton key={i} className="h-12 rounded-lg" />
                ))}
              </div>
            ) : error ? (
              <div className="text-center py-12 text-sm">
                <p className="text-destructive mb-3">
                  {error instanceof Error ? error.message : "Gagal memuat"}
                </p>
                <Button size="sm" variant="outline" onClick={() => refetch()}>
                  <RefreshCw className="size-4" /> Coba lagi
                </Button>
              </div>
            ) : (data?.entries.length ?? 0) === 0 ? (
              <div className="text-center py-12 text-sm text-muted-foreground">
                <Folder className="size-8 mx-auto mb-2 opacity-50" />
                Folder MEGA kosong.
              </div>
            ) : (
              <div className="space-y-1">
                {data?.entries.map((entry) => {
                  if (entry.isFolder) {
                    return (
                      <button
                        key={entry.nodeId}
                        type="button"
                        onDoubleClick={() => setNodeId(entry.nodeId)}
                        onClick={() => setNodeId(entry.nodeId)}
                        className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-secondary/60 text-left transition-colors group"
                      >
                        <span className="rounded-md bg-red-500/10 p-1.5 shrink-0">
                          <Folder className="size-4 text-red-500" />
                        </span>
                        <span className="flex-1 min-w-0">
                          <span className="block text-sm font-medium truncate">
                            {entry.name}
                          </span>
                          <span className="block text-[11px] text-muted-foreground">
                            Folder
                          </span>
                        </span>
                        <ChevronRight className="size-4 text-muted-foreground opacity-0 group-hover:opacity-100 shrink-0" />
                      </button>
                    );
                  }
                  const fileItem: CloudFileItem = {
                    id: `mega-node-${entry.nodeId}`,
                    name: entry.name,
                    size: entry.size,
                    mimetype: mimetypeFromName(entry.name),
                    storageKey: `mega:${data.account.id}:${entry.nodeId}`,
                    cloudAccountId: data.account.id,
                    createdAt: entry.timestamp
                      ? new Date(entry.timestamp).toISOString()
                      : new Date().toISOString(),
                    uploadedBy: "",
                    uploader: {
                      id: "",
                      name: data.account.name ?? "MEGA",
                      username: data.account.email ?? "mega",
                    },
                    visibility: "PUBLIC",
                    raw: true,
                  };
                  return (
                    <button
                      key={entry.nodeId}
                      type="button"
                      onClick={() => setPreviewFile(fileItem)}
                      className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-secondary/60 text-left transition-colors"
                    >
                      <span className="rounded-md bg-secondary p-1.5 shrink-0 text-muted-foreground">
                        <HardDrive className="size-4" />
                      </span>
                      <span className="flex-1 min-w-0">
                        <span className="block text-sm font-medium truncate">
                          {entry.name}
                        </span>
                        <span className="block text-[11px] text-muted-foreground">
                          {formatBytes(entry.size)}
                          {entry.timestamp
                            ? ` · ${formatDistanceToNow(
                                new Date(entry.timestamp),
                                { addSuffix: true, locale: localeId }
                              )}`
                            : ""}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </ScrollArea>
      </div>

      {/* Preview file MEGA (image/pdf/audio/video/teks/docx) */}
      <FilePreview file={previewFile} onClose={() => setPreviewFile(null)} />
    </div>
  );
}
