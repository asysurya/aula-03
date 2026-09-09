import { cn } from "@/lib/utils";
import { APP_NAME } from "@/lib/constants";

export function Logo({
  className,
  showText = true,
}: {
  className?: string;
  showText?: boolean;
}) {
  return (
    <div className={cn("flex items-center gap-2", className)}>
      <LogoMark className="h-7 w-7" />
      {showText ? (
        <span className="font-bold text-lg tracking-tight">
          {APP_NAME}
        </span>
      ) : null}
    </div>
  );
}

export function LogoMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 40 40"
      className={cn("text-primary", className)}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
    >
      {/* Stylized "A" formed by converging people / gathering */}
      <defs>
        <linearGradient id="aulaGrad" x1="4" y1="6" x2="36" y2="36" gradientUnits="userSpaceOnUse">
          <stop stopColor="oklch(0.72 0.165 162)" />
          <stop offset="1" stopColor="oklch(0.74 0.168 70)" />
        </linearGradient>
      </defs>
      <rect width="40" height="40" rx="10" fill="url(#aulaGrad)" />
      {/* The "A" shape made of two strokes + a dot for the people-node */}
      <path
        d="M20 9 L29 30"
        stroke="white"
        strokeWidth="3.2"
        strokeLinecap="round"
      />
      <path
        d="M20 9 L11 30"
        stroke="white"
        strokeWidth="3.2"
        strokeLinecap="round"
        opacity="0.85"
      />
      <path
        d="M14.5 22 L25.5 22"
        stroke="white"
        strokeWidth="3.2"
        strokeLinecap="round"
      />
      <circle cx="20" cy="9" r="3" fill="white" />
    </svg>
  );
}
