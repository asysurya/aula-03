import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/session";
import { db } from "@/lib/db";

// GET /api/admin/groups — daftar SEMUA grup (lintas kelas) untuk admin.
// Query param opsional: `q` — cari nama grup (case-insensitive contains).
export async function GET(req: NextRequest) {
  try {
    await requireAdmin();
  } catch (e) {
    const msg = e instanceof Error ? e.message : "";
    if (msg === "UNAUTHORIZED") {
      return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
    }
    return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });
  }

  const q = (req.nextUrl.searchParams.get("q") ?? "").trim();

  // Catatan: connector MongoDB Prisma TIDAK mendukung `mode: "insensitive"`
  // pada StringFilter — jadi pencarian nama difilter di JS (case-insensitive),
  // bukan di query (dataset grup kecil, aman).
  const qLower = q.toLowerCase();
  const groups = await db.group.findMany({
    select: {
      id: true,
      name: true,
      description: true,
      isPrivate: true,
      inviteCode: true,
      allowStudentInvite: true,
      createdAt: true,
      updatedAt: true,
      creator: { select: { name: true, username: true } },
      classroom: { select: { id: true, name: true } },
      _count: { select: { members: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 500,
  });

  return NextResponse.json({
    groups: groups
      .filter((g) =>
        !qLower
          ? true
          : g.name.toLowerCase().includes(qLower) ||
            (g.description ?? "").toLowerCase().includes(qLower)
      )
      .map(({ _count, ...g }) => ({
        ...g,
        memberCount: _count.members,
      })),
  });
}
