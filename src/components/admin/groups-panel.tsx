"use client";

// Panel admin — daftar SEMUA grup (lintas kelas). READ-ONLY:
// admin hanya melihat; tidak ada tombol hapus/edit di sini.

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  RefreshCw,
  Search,
  Copy,
  Check,
  UsersRound,
  AlertCircle,
} from "lucide-react";
import { toast } from "sonner";
import { formatDistanceToNow } from "date-fns";
import { id as localeId } from "date-fns/locale";
import { cn } from "@/lib/utils";

interface AdminGroup {
  id: string;
  name: string;
  description: string | null;
  isPrivate: boolean;
  inviteCode: string;
  allowStudentInvite: boolean;
  createdAt: string;
  updatedAt: string;
  memberCount: number;
  creator: { name: string; username: string } | null;
  classroom: { id: string; name: string } | null;
}

function relativeTime(iso: string | null): string {
  if (!iso) return "—";
  try {
    return formatDistanceToNow(new Date(iso), {
      addSuffix: true,
      locale: localeId,
    });
  } catch {
    return "—";
  }
}

export function GroupsPanel() {
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // Debounce pencarian ~300ms sebelum refetch.
  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  const { data, isLoading, isError, refetch, isFetching } = useQuery<{
    groups: AdminGroup[];
  }>({
    queryKey: ["admin-groups", debounced],
    queryFn: async () => {
      const res = await fetch(
        `/api/admin/groups?q=${encodeURIComponent(debounced)}`,
        { cache: "no-store" }
      );
      if (!res.ok) throw new Error();
      return res.json();
    },
  });

  const groups = data?.groups ?? [];

  async function handleCopy(g: AdminGroup) {
    try {
      await navigator.clipboard.writeText(g.inviteCode);
      setCopiedId(g.id);
      toast.success("Kode invite tersalin");
      setTimeout(() => setCopiedId(null), 1500);
    } catch {
      toast.error("Gagal menyalin kode");
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 justify-between">
        <div>
          <h3 className="font-semibold">Daftar Grup</h3>
          <p className="text-sm text-muted-foreground">
            {groups.length} grup di aplikasi (lintas kelas) · hanya lihat
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="h-4 w-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Cari nama grup…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-48 pl-8"
            />
          </div>
          <Button
            variant="outline"
            size="icon"
            onClick={() => refetch()}
            title="Muat ulang"
            disabled={isFetching}
          >
            <RefreshCw
              className={cn("h-4 w-4", isFetching && "animate-spin")}
            />
          </Button>
        </div>
      </div>

      {isError ? (
        <div className="rounded-lg border border-border px-4 py-10 text-center space-y-3">
          <AlertCircle className="h-5 w-5 text-destructive inline-block" />
          <p className="text-sm text-muted-foreground">
            Gagal memuat grup.
          </p>
          <Button variant="outline" size="sm" onClick={() => refetch()}>
            <RefreshCw className="h-3.5 w-3.5 mr-1.5" /> Coba lagi
          </Button>
        </div>
      ) : (
        <div className="rounded-lg border border-border overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Nama</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Kode Invite</TableHead>
                <TableHead className="hidden md:table-cell">Anggota</TableHead>
                <TableHead className="hidden md:table-cell">Pembuat</TableHead>
                <TableHead className="hidden lg:table-cell">Kelas</TableHead>
                <TableHead className="hidden lg:table-cell">Dibuat</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                [0, 1, 2, 3, 4].map((i) => (
                  <TableRow key={i}>
                    <TableCell colSpan={7}>
                      <div className="flex items-center gap-3">
                        <Skeleton className="h-8 w-8 rounded-full shrink-0" />
                        <div className="space-y-1.5 flex-1">
                          <Skeleton className="h-4 w-40" />
                          <Skeleton className="h-3 w-64" />
                        </div>
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              ) : groups.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={7}
                    className="text-center text-muted-foreground py-10"
                  >
                    <UsersRound className="h-5 w-5 inline-block mr-2" />
                    Belum ada grup.
                  </TableCell>
                </TableRow>
              ) : (
                groups.map((g) => (
                  <TableRow key={g.id}>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <div className="h-8 w-8 rounded-full bg-muted flex items-center justify-center shrink-0">
                          <UsersRound className="h-4 w-4 text-muted-foreground" />
                        </div>
                        <div className="min-w-0 max-w-[16rem]">
                          <p className="font-medium truncate">{g.name}</p>
                          {g.description ? (
                            <p className="text-xs text-muted-foreground truncate">
                              {g.description}
                            </p>
                          ) : null}
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant={g.isPrivate ? "secondary" : "outline"}>
                        {g.isPrivate ? "Privat" : "Terbuka"}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 font-mono text-xs gap-1"
                        onClick={() => handleCopy(g)}
                        title="Klik untuk salin kode invite"
                      >
                        {copiedId === g.id ? (
                          <Check className="h-3.5 w-3.5 text-emerald-600" />
                        ) : (
                          <Copy className="h-3.5 w-3.5 text-muted-foreground" />
                        )}
                        {g.inviteCode}
                      </Button>
                    </TableCell>
                    <TableCell className="hidden md:table-cell">
                      <Badge variant="secondary">{g.memberCount}</Badge>
                    </TableCell>
                    <TableCell className="hidden md:table-cell">
                      {g.creator ? (
                        <div className="min-w-0">
                          <p className="text-sm font-medium truncate">
                            {g.creator.name}
                          </p>
                          <p className="text-xs text-muted-foreground truncate">
                            @{g.creator.username}
                          </p>
                        </div>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="hidden lg:table-cell text-sm text-muted-foreground">
                      {g.classroom ? (
                        <span className="truncate block max-w-[12rem]">
                          {g.classroom.name}
                        </span>
                      ) : (
                        "—"
                      )}
                    </TableCell>
                    <TableCell className="hidden lg:table-cell text-sm text-muted-foreground">
                      {relativeTime(g.createdAt)}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
