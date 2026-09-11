"use client";

import { useEffect, useState } from "react";
import { signOut } from "next-auth/react";
import { useMe, type MeResponse } from "@/hooks/use-me";
import { useDmConversations } from "@/hooks/use-dm-conversations";
import { useUIStore } from "@/stores/ui-store";
import { Logo } from "@/components/shared/logo";
import { ThemeToggle } from "@/components/shared/theme-toggle";
import { UserAvatar } from "@/components/shared/user-avatar";
import { OnlineDot } from "@/components/shared/online-dot";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  MessageSquare,
  Users,
  Cloud,
  Shield,
  UserCircle,
  Plus,
  LogOut,
  Hash,
  Lock,
  ChevronRight,
  CalendarDays,
  GraduationCap,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { roleLabel } from "@/lib/constants";
import { toast } from "sonner";
import { UpcomingDialog } from "@/components/shared/upcoming-dialog";

export function AppSidebar({
  me,
  onlineIds,
}: {
  me: MeResponse;
  onlineIds: Set<string>;
}) {
  const { classrooms, groups } = me;
  const user = me.user!;
  const { data: dms } = useDmConversations(true);
  const {
    section,
    conversation,
    cloudFolderId,
    cloudClassroomId,
    membersClassroomId,
    setSection,
    openConversation,
    openCloudFolder,
    openMembers,
    openProfile,
    openAdmin,
    openStudy,
  } = useUIStore();
  const [dmPickerOpen, setDmPickerOpen] = useState(false);
  const [upcomingOpen, setUpcomingOpen] = useState(false);

  const isAdmin = user.role === "ADMIN";

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-4 h-14 border-b border-sidebar-border shrink-0">
        <Logo />
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={() => setUpcomingOpen(true)}
            title="Jadwal tugas (tenggat)"
            aria-label="Jadwal tugas"
          >
            <CalendarDays className="h-4 w-4" />
          </Button>
          <ThemeToggle />
        </div>
      </div>

      <ScrollArea className="flex-1 min-h-0">
        <nav className="px-2 py-3 space-y-5">
          {/* Main nav */}
          <div className="space-y-1">
            <SideButton
              icon={<MessageSquare className="h-4 w-4" />}
              label="Chat Kelas"
              active={section === "chat" && (!conversation || conversation.kind !== "dm")}
              onClick={() => {
                setSection("chat");
                if (classrooms[0]) {
                  openConversation({
                    kind: "classroom",
                    id: classrooms[0].id,
                    name: classrooms[0].name,
                  });
                }
              }}
            />
            <SideButton
              icon={<Cloud className="h-4 w-4" />}
              label="Cloud & Tugas"
              active={section === "cloud"}
              onClick={() =>
                openCloudFolder(null, classrooms[0]?.id ?? null)
              }
            />
            <SideButton
              icon={<Users className="h-4 w-4" />}
              label="Anggota"
              active={section === "members"}
              onClick={() => openMembers(classrooms[0]?.id ?? null)}
            />
            <SideButton
              icon={<GraduationCap className="h-4 w-4" />}
              label="Pusat Belajar"
              active={section === "study"}
              onClick={openStudy}
            />
            {isAdmin ? (
              <SideButton
                icon={<Shield className="h-4 w-4" />}
                label="Admin Panel"
                active={section === "admin"}
                onClick={openAdmin}
              />
            ) : null}
          </div>

          <Separator />

          {/* Classrooms */}
          <SidebarSection title="Kelas" badge={classrooms.length}>
            {classrooms.length === 0 ? (
              <p className="px-3 text-xs text-muted-foreground">Belum ada kelas.</p>
            ) : (
              classrooms.map((c) => {
                const active =
                  section === "chat" &&
                  conversation?.kind === "classroom" &&
                  conversation.id === c.id;
                return (
                  <ChannelItem
                    key={c.id}
                    active={active}
                    onClick={() =>
                      openConversation({
                        kind: "classroom",
                        id: c.id,
                        name: c.name,
                      })
                    }
                    icon={<Hash className="h-4 w-4 shrink-0" />}
                    label={c.name}
                  />
                );
              })
            )}
          </SidebarSection>

          {/* Groups */}
          <SidebarSection title="Grup" badge={groups.length}>
            {groups.length === 0 ? (
              <p className="px-3 text-xs text-muted-foreground">
                Belum ada grup. Buat dari tab Chat.
              </p>
            ) : (
              groups.map((g) => {
                const active =
                  section === "chat" &&
                  conversation?.kind === "group" &&
                  conversation.id === g.id;
                return (
                  <ChannelItem
                    key={g.id}
                    active={active}
                    onClick={() =>
                      openConversation({ kind: "group", id: g.id, name: g.name })
                    }
                    icon={<Lock className="h-4 w-4 shrink-0" />}
                    label={g.name}
                  />
                );
              })
            )}
          </SidebarSection>

          {/* DMs */}
          <SidebarSection
            title="Pesan Langsung"
            badge={dms?.conversations.length ?? 0}
            action={
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6"
                onClick={() => setDmPickerOpen(true)}
                title="Pesan baru"
              >
                <Plus className="h-3.5 w-3.5" />
              </Button>
            }
          >
            {!dms?.conversations.length ? (
              <p className="px-3 text-xs text-muted-foreground">
                Klik + untuk memulai DM.
              </p>
            ) : (
              dms.conversations.map((d) => {
                const active =
                  section === "chat" &&
                  conversation?.kind === "dm" &&
                  conversation.id === d.id;
                return (
                  <button
                    key={d.id}
                    onClick={() =>
                      openConversation({
                        kind: "dm",
                        id: d.id,
                        peerId: d.peer.id,
                        peerName: d.peer.name,
                      })
                    }
                    className={cn(
                      "flex items-center gap-2 w-full rounded-md px-2 py-1.5 text-sm hover:bg-sidebar-accent transition-colors",
                      active && "bg-sidebar-accent text-sidebar-accent-foreground"
                    )}
                  >
                    <div className="relative">
                      <UserAvatar
                        name={d.peer.name}
                        username={d.peer.username}
                        avatarUrl={d.peer.avatarUrl}
                        size="xs"
                      />
                      <OnlineDot online={onlineIds.has(d.peer.id)} />
                    </div>
                    <span className="truncate text-left flex-1">{d.peer.name}</span>
                  </button>
                );
              })
            )}
          </SidebarSection>
        </nav>
      </ScrollArea>

      {/* User footer */}
      <div className="border-t border-sidebar-border p-2 shrink-0">
        <button
          onClick={openProfile}
          className={cn(
            "flex items-center gap-2 w-full rounded-md px-2 py-2 text-sm hover:bg-sidebar-accent transition-colors",
            section === "profile" && "bg-sidebar-accent"
          )}
        >
          <div className="relative">
            <UserAvatar
              name={user.name}
              username={user.username}
              avatarUrl={user.avatarUrl}
              size="sm"
            />
            <OnlineDot online />
          </div>
          <div className="flex-1 min-w-0 text-left">
            <p className="truncate font-medium text-sm">{user.name}</p>
            <p className="truncate text-xs text-muted-foreground">
              @{user.username} · {roleLabel(user.role)}
            </p>
          </div>
          <UserCircle className="h-4 w-4 text-muted-foreground" />
        </button>
        <Button
          variant="ghost"
          size="sm"
          className="w-full justify-start text-muted-foreground hover:text-foreground mt-1"
          onClick={() => {
            toast.success("Sampai jumpa!");
            signOut({ redirect: false }).then(() => window.location.reload());
          }}
        >
          <LogOut className="h-4 w-4" /> Keluar
        </Button>
      </div>

      <DmPickerDialog open={dmPickerOpen} onOpenChange={setDmPickerOpen} />
      <UpcomingDialog open={upcomingOpen} onOpenChange={setUpcomingOpen} />
    </div>
  );
}

function SidebarSection({
  title,
  badge,
  action,
  children,
}: {
  title: string;
  badge?: number;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex items-center justify-between px-3 mb-1">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            {title}
          </span>
          {typeof badge === "number" ? (
            <Badge variant="secondary" className="h-4 px-1.5 text-[10px]">
              {badge}
            </Badge>
          ) : null}
        </div>
        {action}
      </div>
      <div className="space-y-0.5">{children}</div>
    </div>
  );
}

function SideButton({
  icon,
  label,
  active,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex items-center gap-2.5 w-full rounded-md px-3 py-2 text-sm font-medium transition-colors",
        active
          ? "bg-sidebar-primary text-sidebar-primary-foreground shadow-sm"
          : "hover:bg-sidebar-accent text-sidebar-foreground"
      )}
    >
      {icon}
      <span className="flex-1 text-left">{label}</span>
      <ChevronRight className="h-3.5 w-3.5 opacity-50" />
    </button>
  );
}

function ChannelItem({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex items-center gap-2 w-full rounded-md px-3 py-1.5 text-sm transition-colors",
        active
          ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
          : "hover:bg-sidebar-accent text-sidebar-foreground/90"
      )}
    >
      {icon}
      <span className="truncate flex-1 text-left">{label}</span>
    </button>
  );
}

function DmPickerDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const { data } = useDmConversations(open);
  const { openConversation } = useUIStore();
  const [loadingPeer, setLoadingPeer] = useState<string | null>(null);
  const existing = data?.conversations ?? [];

  async function startDm(peerId: string, peerName: string) {
    setLoadingPeer(peerId);
    try {
      const res = await fetch("/api/conversations/dm/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ peerId }),
      });
      if (!res.ok) throw new Error();
      const { id } = await res.json();
      openConversation({ kind: "dm", id, peerId, peerName });
      onOpenChange(false);
    } catch {
      toast.error("Gagal memulai percakapan");
    } finally {
      setLoadingPeer(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Pesan baru</DialogTitle>
          <DialogDescription>
            Pilih anggota untuk memulai percakapan langsung.
          </DialogDescription>
        </DialogHeader>
        <StartDmList existing={existing} onStart={startDm} loadingPeer={loadingPeer} />
      </DialogContent>
    </Dialog>
  );
}

function StartDmList({
  existing,
  onStart,
  loadingPeer,
}: {
  existing: { peer: { id: string } }[];
  onStart: (peerId: string, peerName: string) => void;
  loadingPeer: string | null;
}) {
  const [users, setUsers] = useState<
    { id: string; name: string; username: string; avatarUrl: string | null }[]
  >([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    fetch("/api/users", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        if (active) setUsers(d.users || []);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  if (loading) return <p className="text-sm text-muted-foreground">Memuat…</p>;
  const existingIds = new Set(existing.map((e) => e.peer.id));

  return (
    <div className="max-h-80 overflow-y-auto -mx-1 space-y-0.5">
      {users.map((u) => {
        const has = existingIds.has(u.id);
        return (
          <button
            key={u.id}
            onClick={() => onStart(u.id, u.name)}
            disabled={loadingPeer === u.id}
            className="flex items-center gap-2 w-full rounded-md px-2 py-1.5 text-sm hover:bg-accent transition-colors disabled:opacity-50"
          >
            <UserAvatar name={u.name} username={u.username} avatarUrl={u.avatarUrl} size="sm" />
            <span className="flex-1 text-left truncate">{u.name}</span>
            {has ? (
              <span className="text-[10px] text-muted-foreground">sudah ada</span>
            ) : (
              <Plus className="h-3.5 w-3.5 text-muted-foreground" />
            )}
          </button>
        );
      })}
    </div>
  );
}
