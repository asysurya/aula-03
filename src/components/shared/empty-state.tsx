"use client";

import { MessageSquarePlus } from "lucide-react";

export function EmptyState({
  title,
  description,
}: {
  title: string;
  description?: string;
}) {
  return (
    <div className="h-full flex items-center justify-center p-8">
      <div className="text-center max-w-sm">
        <div className="mx-auto mb-4 h-12 w-12 rounded-full bg-accent flex items-center justify-center">
          <MessageSquarePlus className="h-6 w-6 text-accent-foreground" />
        </div>
        <h3 className="font-semibold text-lg">{title}</h3>
        {description ? (
          <p className="text-sm text-muted-foreground mt-1">{description}</p>
        ) : null}
      </div>
    </div>
  );
}
