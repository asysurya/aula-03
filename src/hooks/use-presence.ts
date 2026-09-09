"use client";

import { useEffect, useRef, useState } from "react";

export function usePresence(enabled: boolean) {
  const [onlineIds, setOnlineIds] = useState<Set<string>>(new Set());
  const stoppedRef = useRef(false);

  useEffect(() => {
    if (!enabled) return;
    stoppedRef.current = false;

    async function ping() {
      try {
        await fetch("/api/presence", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });
      } catch {}
    }
    async function refresh() {
      try {
        const res = await fetch("/api/presence", { cache: "no-store" });
        const data = await res.json();
        setOnlineIds(new Set(data.online as string[]));
      } catch {}
    }

    ping();
    refresh();
    const pingInt = setInterval(ping, 15_000);
    const refreshInt = setInterval(refresh, 15_000);

    function onUnload() {
      // best-effort offline ping (beacon not used to keep it simple)
      fetch("/api/presence", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ offline: true }),
        keepalive: true,
      }).catch(() => {});
    }
    window.addEventListener("beforeunload", onUnload);

    return () => {
      stoppedRef.current = true;
      clearInterval(pingInt);
      clearInterval(refreshInt);
      window.removeEventListener("beforeunload", onUnload);
      onUnload();
    };
  }, [enabled]);

  return { onlineIds };
}
