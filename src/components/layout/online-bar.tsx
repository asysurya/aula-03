"use client";

import { Users } from "lucide-react";
import type { MeResponse } from "@/hooks/use-me";

export function OnlineBar({
  me,
  onlineIds,
}: {
  me: MeResponse;
  onlineIds: Set<string>;
}) {
  const onlineCount = onlineIds.size;
  return (
    <div className="hidden md:flex items-center gap-2 px-4 h-9 border-b border-border bg-background/60 text-xs text-muted-foreground">
      <span className="inline-flex items-center gap-1.5">
        <span className="relative flex h-2 w-2">
          <span
            className={`absolute inline-flex h-full w-full rounded-full ${
              onlineCount > 0 ? "bg-emerald-500 animate-ping opacity-75" : "bg-zinc-400"
            }`}
          />
          <span
            className={`relative inline-flex rounded-full h-2 w-2 ${
              onlineCount > 0 ? "bg-emerald-500" : "bg-zinc-400"
            }`}
          />
        </span>
        {onlineCount} online
      </span>
      <span className="text-border">·</span>
      <Users className="h-3.5 w-3.5" />
      <span>{me.classrooms.length} kelas · {me.groups.length} grup</span>
    </div>
  );
}
