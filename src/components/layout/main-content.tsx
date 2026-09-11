"use client";

import { useUIStore } from "@/stores/ui-store";
import type { MeResponse } from "@/hooks/use-me";
import { ChatView } from "@/components/chat/chat-view";
import { CloudView } from "@/components/cloud/cloud-view";
import { MembersView } from "@/components/members/members-view";
import { AdminView } from "@/components/admin/admin-view";
import { ProfileView } from "@/components/profile/profile-view";
import { StudyHub } from "@/components/study/study-hub";
import { EmptyState } from "@/components/shared/empty-state";

export function MainContent({
  me,
  onlineIds,
}: {
  me: MeResponse;
  onlineIds: Set<string>;
}) {
  const section = useUIStore((s) => s.section);
  const conversation = useUIStore((s) => s.conversation);

  if (section === "chat") {
    if (!conversation) {
      return (
        <EmptyState
          title="Pilih percakapan"
          description="Buka kelas, grup, atau pesan langsung dari sidebar untuk mulai mengobrol."
        />
      );
    }
    return <ChatView conversation={conversation} me={me} onlineIds={onlineIds} />;
  }

  if (section === "cloud") return <CloudView me={me} />;
  if (section === "members") return <MembersView me={me} onlineIds={onlineIds} />;
  if (section === "admin")
    return me.user?.role === "ADMIN" ? (
      <AdminView />
    ) : (
      <EmptyState title="Akses ditolak" description="Halaman ini khusus admin." />
    );
  if (section === "profile") return me.user ? <ProfileView me={me} /> : null;
  if (section === "study") return <StudyHub me={me} />;

  return null;
}
