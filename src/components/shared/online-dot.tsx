"use client";

import { cn } from "@/lib/utils";

export function OnlineDot({
  online,
  className,
}: {
  online: boolean;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "absolute -bottom-0.5 -right-0.5 rounded-full border-2 border-background",
        online ? "bg-emerald-500" : "bg-zinc-400",
        className
      )}
      style={{ width: 10, height: 10 }}
      title={online ? "Online" : "Offline"}
    />
  );
}
