import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/session";
import { db } from "@/lib/db";
import { deleteFolderCascade } from "@/lib/folder-delete";

const patchSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  description: z.string().max(240).optional(),
});

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  await requireAdmin();
  const { id } = await params;
  const body = await req.json();
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Data tidak valid", details: parsed.error.flatten() },
      { status: 400 }
    );
  }
  const data: any = {};
  if (parsed.data.name) data.name = parsed.data.name;
  if (parsed.data.description !== undefined)
    data.description = parsed.data.description;
  const classroom = await db.classroom.update({ where: { id }, data });
  return NextResponse.json({ classroom });
}

// DELETE /api/admin/classrooms/[id]
// Hapus kelas BESERTA seluruh isinya. (Dulu: langsung classroom.delete →
// SELALUS error P2014 / HTTP 500 karena masih ada anggota, pesan, folder,
// dan grup yang menunjuk kelas dengan relasi NoAction.)
//
// Urutan:
//   1. Semua folder kelas (pakai cascade folder: tugas, form, submission,
//      sharedDoc, file + blob fisik).
//   2. Pesan kelas + pesan grup milik kelas (reaksi, tanda terima, lampiran
//      dan balasan dilepas dulu — NoAction).
//   3. Grup kelas (+ anggotanya).
//   4. Anggota kelas.
//   5. Baris kelas itu sendiri.
export const maxDuration = 60;

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  await requireAdmin();
  const { id } = await params;

  const classroom = await db.classroom.findUnique({
    where: { id },
    select: { id: true },
  });
  if (!classroom) return NextResponse.json({ ok: true });

  try {
    // 1. Folder-folder kelas (mulai dari folder akar; cascade menangani
    //    turunannya). Kegagalan satu folder tidak menghentikan sisanya.
    const rootFolders = await db.cloudFolder.findMany({
      where: { classroomId: id, parentId: null },
      select: { id: true },
    });
    for (const f of rootFolders) {
      try {
        await deleteFolderCascade(f.id);
      } catch (e) {
        console.error("[classrooms/delete] cascade folder gagal:", f.id, e);
      }
    }

    // 2. Grup milik kelas ini → kumpulkan id-nya (pesan grup ikut dibersihkan).
    const groups = await db.group.findMany({
      where: { classroomId: id },
      select: { id: true },
    });
    const groupIds = groups.map((g) => g.id);

    // 3. Semua pesan kelas + pesan grup kelas.
    const messages = await db.message.findMany({
      where:
        groupIds.length > 0
          ? { OR: [{ classroomId: id }, { groupId: { in: groupIds } }] }
          : { classroomId: id },
      select: { id: true },
    });
    const msgIds = messages.map((m) => m.id);
    if (msgIds.length > 0) {
      await db.messageReaction.deleteMany({
        where: { messageId: { in: msgIds } },
      });
      await db.readReceipt.deleteMany({
        where: { messageId: { in: msgIds } },
      });
      await db.messageAttachment.deleteMany({
        where: { messageId: { in: msgIds } },
      });
      // Lepas balasan yang menunjuk pesan ini (relasi replyTo NoAction).
      await db.message.updateMany({
        where: { replyToId: { in: msgIds } },
        data: { replyToId: null },
      });
      await db.message.deleteMany({ where: { id: { in: msgIds } } });
    }

    // 4. Grup + anggotanya.
    if (groupIds.length > 0) {
      await db.groupMember.deleteMany({
        where: { groupId: { in: groupIds } },
      });
      await db.group.deleteMany({ where: { id: { in: groupIds } } });
    }

    // 5. Anggota kelas + sisa folder (safety-net) + baris kelas.
    await db.classroomMember.deleteMany({ where: { classroomId: id } });
    await db.cloudFolder
      .deleteMany({ where: { classroomId: id } })
      .catch(() => {});
    await db.classroom.delete({ where: { id } });

    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("[classrooms/delete]", e);
    return NextResponse.json(
      {
        error:
          "HAPUS_GAGAL: " +
          (e instanceof Error ? e.message : "kesalahan tidak diketahui"),
      },
      { status: 500 }
    );
  }
}
