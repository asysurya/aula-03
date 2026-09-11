import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";

// GET /api/chat/overview — ringkasan SEMUA percakapan user (kelas, grup, DM):
// pesan terakhir per percakapan. Dipakai poller notifikasi global (tiap ±30
// dtk) untuk mendeteksi pesan baru di percakapan yang SEDANG TIDAK DIBUKA —
// memicu lonceng notifikasi, badge tidak-dibaca per percakapan di sidebar,
// dan Web Notification bila tab tersembunyi. Payload sengaja minimal.

export const dynamic = "force-dynamic";

export async function GET() {
  const user = await requireUser().catch(() => null);
  if (!user) {
    return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
  }

  const [cms, gms, dms] = await Promise.all([
    db.classroomMember.findMany({
      where: { userId: user.id },
      select: { classroom: { select: { id: true, name: true } } },
    }),
    db.groupMember.findMany({
      where: { userId: user.id },
      select: { group: { select: { id: true, name: true } } },
    }),
    db.dMConversation.findMany({
      where: { OR: [{ user1Id: user.id }, { user2Id: user.id }] },
      select: {
        id: true,
        user1Id: true,
        user2Id: true,
        user1: { select: { id: true, name: true, username: true } },
        user2: { select: { id: true, name: true, username: true } },
      },
    }),
  ]);

  interface ConvOverview {
    kind: "classroom" | "group" | "dm";
    id: string;
    name: string;
    last: {
      id: string;
      content: string;
      createdAt: string;
      senderId: string;
      senderName: string;
      assignmentId: string | null;
      assignmentTitle: string | null;
    } | null;
  }

  const out: ConvOverview[] = [];
  const jobs: Promise<void>[] = [];

  const pushConv = (
    kind: ConvOverview["kind"],
    id: string,
    name: string,
    where: { classroomId?: string; groupId?: string; dmId?: string }
  ) => {
    jobs.push(
      (async () => {
        const last = await db.message.findFirst({
          where,
          orderBy: { createdAt: "desc" },
          select: {
            id: true,
            content: true,
            createdAt: true,
            senderId: true,
            assignmentId: true,
            sender: { select: { name: true } },
          },
        });
        let assignmentTitle: string | null = null;
        if (last?.assignmentId) {
          const a = await db.assignment.findUnique({
            where: { id: last.assignmentId },
            select: { title: true },
          });
          assignmentTitle = a?.title ?? null;
        }
        out.push({
          kind,
          id,
          name,
          last: last
            ? {
                id: last.id,
                content: (last.content || "").slice(0, 160),
                createdAt: last.createdAt.toISOString(),
                senderId: last.senderId,
                senderName: last.sender.name,
                assignmentId: last.assignmentId,
                assignmentTitle,
              }
            : null,
        });
      })()
    );
  };

  for (const cm of cms) {
    pushConv("classroom", cm.classroom.id, cm.classroom.name, {
      classroomId: cm.classroom.id,
    });
  }
  for (const gm of gms) {
    pushConv("group", gm.group.id, gm.group.name, {
      groupId: gm.group.id,
    });
  }
  for (const dm of dms) {
    const other = dm.user1Id === user.id ? dm.user2 : dm.user1;
    pushConv("dm", dm.id, other.name, { dmId: dm.id });
  }

  await Promise.all(jobs);

  return NextResponse.json({
    conversations: out,
    serverTime: new Date().toISOString(),
  });
}
