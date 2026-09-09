"use client";

import { useState } from "react";
import { useUIStore } from "@/stores/ui-store";
import { useQuery } from "@tanstack/react-query";
import { useMe, type MeResponse } from "@/hooks/use-me";
import { UserAvatar } from "@/components/shared/user-avatar";
import { OnlineDot } from "@/components/shared/online-dot";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Users, MessageSquare } from "lucide-react";
import { formatDistanceToNow } from "date-fns";

interface MemberUser {
  id: string;
  username: string;
  name: string;
  role: "ADMIN" | "GURU" | "STUDENT";
  avatarColor: string;
  avatarUrl: string | null;
  bio: string | null;
  status: string;
  lastSeen: string;
  memberRole?: "TEACHER" | "STUDENT";
}

export function MembersView({
  me,
  onlineIds,
}: {
  me: MeResponse;
  onlineIds: Set<string>;
}) {
  const membersClassroomId = useUIStore((s) => s.membersClassroomId);
  const openMembers = useUIStore((s) => s.openMembers);
  const [picked, setPicked] = useState<string | null>(null);
  const classroomId =
    picked ?? membersClassroomId ?? me.classrooms[0]?.id ?? null;

  const { data, isLoading } = useQuery<{ users: MemberUser[] }>({
    queryKey: ["members", classroomId],
    queryFn: async () => {
      const res = await fetch(`/api/users?classroomId=${classroomId}`, { cache: "no-store" });
      if (!res.ok) throw new Error();
      return res.json();
    },
    enabled: !!classroomId,
  });

  const members = data?.users ?? [];
  const onlineCount = members.filter((m) => onlineIds.has(m.id)).length;

  return (
    <div className="h-full flex flex-col">
      <div className="border-b border-border px-4 md:px-6 py-4 flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <Users className="h-5 w-5 text-primary" />
          <div>
            <h2 className="font-semibold text-lg leading-tight">Anggota</h2>
            <p className="text-xs text-muted-foreground">
              {members.length} anggota · {onlineCount} online
            </p>
          </div>
        </div>
        <Select
          value={classroomId || undefined}
          onValueChange={(v) => {
            setPicked(v);
            openMembers(v);
          }}
        >
          <SelectTrigger className="w-56">
            <SelectValue placeholder="Pilih kelas…" />
          </SelectTrigger>
          <SelectContent>
            {me.classrooms.map((c) => (
              <SelectItem key={c.id} value={c.id}>
                {c.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex-1 overflow-y-auto px-4 md:px-6 py-4">
        {!classroomId ? (
          <p className="text-center text-muted-foreground py-10">
            Pilih kelas dulu.
          </p>
        ) : isLoading ? (
          <p className="text-center text-muted-foreground py-10">Memuat…</p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {members.map((m) => {
              const isSelf = m.id === me.user?.id;
              const online = onlineIds.has(m.id);
              return (
                <Card key={m.id} className="overflow-hidden">
                  <CardContent className="p-4 space-y-3">
                    <div className="flex items-start gap-3">
                      <div className="relative">
                        <UserAvatar
                          name={m.name}
                          username={m.username}
                          avatarUrl={m.avatarUrl}
                          size="md"
                        />
                        <OnlineDot online={online} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5">
                          <p className="font-semibold truncate">{m.name}</p>
                          {isSelf ? (
                            <Badge variant="outline" className="text-[10px] h-4 px-1">
                              Anda
                            </Badge>
                          ) : null}
                        </div>
                        <p className="text-xs text-muted-foreground truncate">@{m.username}</p>
                        <div className="flex flex-wrap gap-1 mt-1">
                          {m.role === "ADMIN" ? (
                            <Badge variant="default" className="text-[10px] h-4 px-1 bg-brand text-brand-foreground">
                              Admin
                            </Badge>
                          ) : null}
                          {m.role === "GURU" ? (
                            <Badge variant="default" className="text-[10px] h-4 px-1">
                              Guru
                            </Badge>
                          ) : null}
                          {m.memberRole === "TEACHER" ? (
                            <Badge variant="secondary" className="text-[10px] h-4 px-1">
                              Pengajar
                            </Badge>
                          ) : null}
                        </div>
                      </div>
                    </div>
                    {m.bio ? (
                      <p className="text-xs text-muted-foreground line-clamp-2">{m.bio}</p>
                    ) : null}
                    <div className="flex items-center justify-between text-xs text-muted-foreground">
                      <span>
                        {online ? (
                          "Online sekarang"
                        ) : (
                          <>
                            Terakhir{" "}
                            {formatDistanceToNow(new Date(m.lastSeen), { addSuffix: true })}
                          </>
                        )}
                      </span>
                    </div>
                    {!isSelf ? (
                      <DmButton peerId={m.id} peerName={m.name} />
                    ) : null}
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function DmButton({ peerId, peerName }: { peerId: string; peerName: string }) {
  const openConversation = useUIStore((s) => s.openConversation);
  const [loading, setLoading] = useState(false);
  return (
    <button
      onClick={async () => {
        setLoading(true);
        try {
          const res = await fetch("/api/conversations/dm/start", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ peerId }),
          });
          if (!res.ok) throw new Error();
          const { id } = await res.json();
          openConversation({ kind: "dm", id, peerId, peerName });
        } catch {
        } finally {
          setLoading(false);
        }
      }}
      disabled={loading}
      className="w-full inline-flex items-center justify-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium hover:bg-accent transition-colors disabled:opacity-50"
    >
      <MessageSquare className="h-3.5 w-3.5" />
      {loading ? "Memuat…" : "Kirim Pesan"}
    </button>
  );
}
