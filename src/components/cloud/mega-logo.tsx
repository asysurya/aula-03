// Logo MEGA — dipakai untuk kartu "mount" MEGA Cloud di file browser.

export function MegaLogo({ className = "size-5" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      role="img"
      aria-label="MEGA"
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient id="mega-g" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#F9396B" />
          <stop offset="100%" stopColor="#D9272E" />
        </linearGradient>
      </defs>
      <circle cx="12" cy="12" r="12" fill="url(#mega-g)" />
      <path
        d="M5.4 15.6V8.4c0-.5.4-.9.9-.9h1.1c.4 0 .7.2.9.5l2.7 4.7c.3.5.5.9.7 1.2.2-.4.4-.8.7-1.2l2.7-4.7c.2-.3.5-.5.9-.5h1.1c.5 0 .9.4.9.9v7.2c0 .5-.4.9-.9.9h-.5c-.5 0-.9-.4-.9-.9v-4.3c0-.6 0-1.1.1-1.6-.2.5-.5 1-.8 1.6l-2.2 3.7c-.2.4-.5.6-.9.6h-.5c-.4 0-.7-.2-.9-.6l-2.2-3.7c-.3-.6-.6-1.1-.8-1.6.1.5.1 1 .1 1.6v4.3c0 .5-.4.9-.9.9h-.5c-.5 0-.9-.4-.9-.9z"
        fill="#fff"
      />
    </svg>
  );
}
