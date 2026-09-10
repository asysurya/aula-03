"use client";

// Papan Peringkat kelas — total poin tugas form yang sudah dikumpulkan,
// jumlah tugas selesai, dan persentase rata-rata. Medali untuk 3 teratas.

import { useQuery } from "@tanstack/react-query";
import { Crown, Medal, Trophy } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { UserAvatar } from "@/components/shared/user-avatar";
import { cn } from "@/lib/utils";

interface LeaderRow {
  rank: number;
  userId: string;
  name: string;
  username: string;
  avatarUrl: string | null;
  avatarColor: string;
  totalScore: number;
  totalMax: number;
  completed: number;
}

function RankIcon({ rank }: { rank: number }) {
  if (rank === 1)
    return <Crown className="size-5 text-amber-400 fill-amber-400 shrink-0" />;
  if (rank === 2)
    return <Medal className="size-5 text-slate-400 fill-slate-400 shrink-0" />;
  if (rank === 3)
    return <Medal className="size-5 text-amber-700 fill-amber-700 shrink-0" />;
  return (
    <span className="w-5 text-center text-xs font-semibold text-muted-foreground shrink-0 tabular-nums">
      {rank}
    </span>
  );
}

export function LeaderboardDialog({
  open,
  onOpenChange,
  classroomId,
  classroomName,
  myUserId,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  classroomId: string | null;
  classroomName: string;
  myUserId: string;
}) {
  const { data, isLoading } = useQuery<{
    leaderboard: LeaderRow[];
    totalForms: number;
  }>({
    queryKey: ["cloud", "leaderboard", classroomId],
    queryFn: async () => {
      const res = await fetch(`/api/cloud/classrooms/${classroomId}/leaderboard`, {
        cache: "no-store",
      });
      if (!res.ok) throw new Error("Gagal memuat papan peringkat");
      return res.json();
    },
    enabled: open && !!classroomId,
  });

  const rows = data?.leaderboard ?? [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md max-h-[75vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Trophy className="size-5 text-amber-400" /> Papan Peringkat
          </DialogTitle>
          <DialogDescription>
            {classroomName} — total poin dari {data?.totalForms ?? 0} tugas
            form. Nilai yang dipakai: percobaan terakhir tiap tugas.
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 min-h-0 overflow-y-auto rounded-lg border border-border divide-y divide-border">
          {isLoading ? (
            <div className="p-3 space-y-2">
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </div>
          ) : rows.length === 0 ? (
            <div className="p-6 text-center text-sm text-muted-foreground">
              <Trophy className="size-6 mx-auto mb-2 opacity-40" />
              Belum ada nilai tugas di kelas ini.
            </div>
          ) : (
            rows.map((r) => (
              <div
                key={r.userId}
                className={cn(
                  "flex items-center gap-3 px-3 py-2.5",
                  r.userId === myUserId && "bg-primary/5"
                )}
              >
                <RankIcon rank={r.rank} />
                <UserAvatar
                  name={r.name}
                  username={r.username}
                  avatarUrl={r.avatarUrl}
                  size="xs"
                />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium truncate">
                    {r.name}
                    {r.userId === myUserId ? (
                      <span className="text-primary"> (kamu)</span>
                    ) : null}
                  </p>
                  <p className="text-[10px] text-muted-foreground">
                    {r.completed} tugas selesai
                    {r.totalMax > 0
                      ? ` · ${Math.round((r.totalScore / r.totalMax) * 100)}% rata-rata`
                      : ""}
                  </p>
                </div>
                <Badge
                  variant="secondary"
                  className="text-xs font-bold tabular-nums shrink-0"
                >
                  {r.totalScore} poin
                </Badge>
              </div>
            ))
          )}
        </div>

        <p className="text-[10px] text-muted-foreground">
          Papan peringkat memotivasi belajar — semua anggota kelas bisa melihat.
        </p>
      </DialogContent>
    </Dialog>
  );
}
