"use client";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { colorFromString, initials } from "@/lib/constants";
import { cn } from "@/lib/utils";

export function UserAvatar({
  name,
  username,
  avatarUrl,
  size = "md",
  className,
}: {
  name: string;
  username?: string;
  avatarUrl?: string | null;
  size?: "xs" | "sm" | "md" | "lg";
  className?: string;
}) {
  const color = colorFromString(username || name);
  const sizeCls = {
    xs: "h-6 w-6 text-[10px]",
    sm: "h-8 w-8 text-xs",
    md: "h-10 w-10 text-sm",
    lg: "h-14 w-14 text-base",
  }[size];

  return (
    <Avatar className={cn(sizeCls, className)}>
      {avatarUrl ? <AvatarImage src={avatarUrl} alt={name} /> : null}
      <AvatarFallback className={cn(color, "text-white font-semibold")}>
        {initials(name)}
      </AvatarFallback>
    </Avatar>
  );
}
