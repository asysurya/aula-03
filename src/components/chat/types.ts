// Shared client-side chat types & helpers.

export interface ChatSender {
  id: string;
  name: string;
  username: string;
  avatarUrl: string | null;
  avatarColor: string;
}

export interface ChatAttachmentFile {
  id: string;
  name: string;
  size: number;
  mimetype: string;
  storageKey: string;
}

export interface ChatAttachment {
  id: string;
  file: ChatAttachmentFile;
}

export interface ChatReaction {
  id: string;
  emoji: string;
  user: { id: string; name: string; username: string };
}

export interface ChatReplyTo {
  id: string;
  content: string;
  sender: { id: string; name: string; username: string };
}

export interface ChatMessage {
  id: string;
  content: string;
  createdAt: string; // ISO
  editedAt?: string | null; // ISO
  senderId: string;
  sender: ChatSender;
  attachments?: ChatAttachment[];
  reactions?: ChatReaction[];
  replyTo?: ChatReplyTo | null;
}

export type UserRole = "ADMIN" | "GURU" | "STUDENT";

export interface GroupInfo {
  id: string;
  name: string;
  description: string | null;
  isPrivate: boolean;
  classroomId: string | null;
  inviteCode: string;
  allowStudentInvite: boolean;
  createdBy: string;
  canShareInvite: boolean;
  createdAt: string;
  members: Array<{
    id: string;
    joinedAt: string;
    user: {
      id: string;
      name: string;
      username: string;
      avatarUrl: string | null;
      avatarColor: string;
      role: UserRole;
    };
  }>;
}

// Group consecutive messages by the same sender within `maxGapMs` ms.
export function groupMessages(
  messages: ChatMessage[],
  maxGapMs = 5 * 60 * 1000
): Array<{ message: ChatMessage; showHeader: boolean }> {
  const out: Array<{ message: ChatMessage; showHeader: boolean }> = [];
  let prev: ChatMessage | null = null;
  for (const m of messages) {
    const showHeader =
      !prev ||
      prev.senderId !== m.senderId ||
      new Date(m.createdAt).getTime() - new Date(prev.createdAt).getTime() >
        maxGapMs;
    out.push({ message: m, showHeader });
    prev = m;
  }
  return out;
}

// Group reactions by emoji -> count + flag whether current user reacted.
export function groupReactions(
  reactions: ChatReaction[] | undefined,
  currentUserId: string
): Array<{ emoji: string; count: number; mine: boolean }> {
  if (!reactions || reactions.length === 0) return [];
  const map = new Map<string, { count: number; mine: boolean }>();
  for (const r of reactions) {
    const existing = map.get(r.emoji);
    if (existing) {
      existing.count += 1;
      if (r.user.id === currentUserId) existing.mine = true;
    } else {
      map.set(r.emoji, {
        count: 1,
        mine: r.user.id === currentUserId,
      });
    }
  }
  return Array.from(map.entries()).map(([emoji, v]) => ({
    emoji,
    count: v.count,
    mine: v.mine,
  }));
}
