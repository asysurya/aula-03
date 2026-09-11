import { db } from "@/lib/db";
import { PRESENCE_TIMEOUT } from "@/lib/constants";

export async function pingPresence(userId: string) {
  await db.presenceRecord.upsert({
    where: { userId },
    create: { userId, lastPing: new Date() },
    update: { lastPing: new Date() },
  });
  await db.user.update({
    where: { id: userId },
    data: { status: "online", lastSeen: new Date() },
  });
}

export async function setOffline(userId: string) {
  // Tandai baris presence basi juga — dulu hanya User.status yang diubah,
  // padahal daftar online (getOnlineUserIds) membaca presenceRecord.lastPing
  // → user tetap tampil "online" sampai 45 dtk setelah tab ditutup.
  await db.presenceRecord
    .update({
      where: { userId },
      data: { lastPing: new Date(0) },
    })
    .catch(() => {
      /* baris memang belum ada */
    });
  await db.user.update({
    where: { id: userId },
    data: { status: "offline", lastSeen: new Date() },
  });
}

export async function getOnlineUserIds(): Promise<Set<string>> {
  const since = new Date(Date.now() - PRESENCE_TIMEOUT);
  const records = await db.presenceRecord.findMany({
    where: { lastPing: { gte: since } },
    select: { userId: true },
  });
  return new Set(records.map((r) => r.userId));
}

export function isOnline(lastPing: Date | null): boolean {
  if (!lastPing) return false;
  return Date.now() - lastPing.getTime() < PRESENCE_TIMEOUT;
}
