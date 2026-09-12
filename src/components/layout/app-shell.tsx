"use client";

import { useEffect } from "react";
import { useMe } from "@/hooks/use-me";
import { usePresence } from "@/hooks/use-presence";
import { LoginForm } from "@/components/auth/login-form";
import { AppSidebar } from "@/components/layout/app-sidebar";
import { MainContent } from "@/components/layout/main-content";
import { OnlineBar } from "@/components/layout/online-bar";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { useUIStore } from "@/stores/ui-store";
import { Logo } from "@/components/shared/logo";
import { ThemeToggle } from "@/components/shared/theme-toggle";
import { CommandPalette } from "@/components/shared/command-palette";
import { NotificationBell } from "@/components/shared/notification-bell";
import { PreviewLayer } from "@/components/cloud/preview-layer";
import { startOverviewPoller } from "@/lib/notify";
import { sweepReaderCache } from "@/lib/reader-file-cache";
import { Menu } from "lucide-react";
import { Button } from "@/components/ui/button";

export function AppShell() {
  const { data: me, isLoading } = useMe();
  const { onlineIds } = usePresence(!!me?.user);
  const { sidebarOpen, setSidebarOpen } = useUIStore();

  // ── Cache sementara Aula Reader / pratinjau ──
  // Tab sebelumnya bisa meninggalkan file di Cache Storage saat ditutup
  // paksa / crash → bersihkan sisa saat aplikasi dibuka (entri yang
  // pratinjaunya masih terbuka di tab ini tetap dipertahankan), plus
  // best-effort saat halaman benar-benar ditutup (pagehide).
  useEffect(() => {
    void sweepReaderCache();
    const onPageHide = () => void sweepReaderCache();
    window.addEventListener("pagehide", onPageHide);
    return () => window.removeEventListener("pagehide", onPageHide);
  }, []);

  // Poller notifikasi global: pantau pesan baru di percakapan yang tidak
  // sedang dibuka (kelas/grup/DM) → lonceng, badge sidebar, web notif.
  useEffect(() => {
    if (!me?.user) return;
    startOverviewPoller({
      myId: me.user.id,
      myUsername: me.user.username,
      myName: me.user.name,
      isConversationActive: (c) => {
        const cur = useUIStore.getState();
        if (cur.section !== "chat" || !cur.conversation) return false;
        return (
          cur.conversation.kind === c.kind && cur.conversation.id === c.id
        );
      },
    });
  }, [me?.user]);

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-pulse text-muted-foreground">Memuat…</div>
      </div>
    );
  }

  if (!me?.user) return <LoginForm />;

  return (
    <div className="h-screen w-full flex overflow-hidden bg-background">
      {/* Desktop sidebar */}
      <aside className="hidden md:flex md:w-72 lg:w-80 shrink-0 border-r border-sidebar-border bg-sidebar">
        <AppSidebar me={me} onlineIds={onlineIds} />
      </aside>

      {/* Mobile sidebar (Sheet) */}
      <Sheet open={sidebarOpen} onOpenChange={setSidebarOpen}>
        <SheetContent side="left" className="w-72 p-0 border-sidebar-border bg-sidebar">
          <AppSidebar me={me} onlineIds={onlineIds} />
        </SheetContent>
      </Sheet>

      {/* Main column */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top bar (mobile) */}
        <header className="md:hidden flex items-center justify-between gap-2 border-b border-border bg-background/80 backdrop-blur px-3 py-2">
          <Button
            variant="ghost"
            size="icon"
            className="h-9 w-9"
            onClick={() => setSidebarOpen(true)}
            aria-label="Buka menu"
          >
            <Menu className="h-5 w-5" />
          </Button>
          <Logo />
          <div className="flex items-center gap-1.5">
            <NotificationBell />
            <CommandPalette me={me} />
            <ThemeToggle />
          </div>
        </header>

        <OnlineBar me={me} onlineIds={onlineIds} />

        <main className="flex-1 min-h-0 overflow-hidden">
          <MainContent me={me} onlineIds={onlineIds} />
        </main>
      </div>

      {/* Jendela pratinjau global + kartu PiP (bertahan selama berpindah
          section; maks 3 pratinjau terbuka bersamaan). */}
      <PreviewLayer />
    </div>
  );
}
