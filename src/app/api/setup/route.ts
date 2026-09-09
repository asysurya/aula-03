import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";

// GET /api/setup
// Auto-seeds the database if it's empty (no users).
// Safe to call multiple times — checks if admin exists before seeding.
// This enables "deploy and it just works" — first visit triggers seed.
export async function GET() {
  try {
    const userCount = await db.user.count();
    if (userCount > 0) {
      return NextResponse.json({
        ok: true,
        alreadySeeded: true,
        message: "Database sudah ter-seed.",
        userCount,
      });
    }

    // Seed admin
    const adminPass = await bcrypt.hash("admin123", 10);
    const admin = await db.user.create({
      data: {
        username: "admin",
        name: "Administrator",
        password: adminPass,
        role: "ADMIN",
        avatarColor: "emerald",
        bio: "Pengelola kelas",
      },
    });

    // Seed default classroom
    const classroom = await db.classroom.create({
      data: {
        name: "Kelas 12 IPA 1",
        description: "Ruang utama diskusi kelas",
        members: {
          create: { userId: admin.id, role: "TEACHER" },
        },
      },
    });

    // Seed root cloud folder
    await db.cloudFolder.create({
      data: {
        name: "Materi Kelas",
        classroomId: classroom.id,
        createdBy: admin.id,
        type: "FOLDER",
      },
    });

    // Seed guru
    const guruPass = await bcrypt.hash("guru123", 10);
    const guru = await db.user.create({
      data: {
        username: "guru",
        name: "Pak Andika",
        password: guruPass,
        role: "GURU",
        avatarColor: "violet",
        bio: "Guru Matematika",
        classroomMemberships: {
          create: { classroomId: classroom.id, role: "TEACHER" },
        },
      },
    });
    void guru; // guru created

    // Seed sample students
    const students = [
      { username: "budi", name: "Budi Santoso" },
      { username: "siti", name: "Siti Nurhaliza" },
      { username: "andi", name: "Andi Wijaya" },
    ];
    const studentPass = await bcrypt.hash("siswa123", 10);
    for (const s of students) {
      await db.user.create({
        data: {
          username: s.username,
          name: s.name,
          password: studentPass,
          role: "STUDENT",
          classroomMemberships: {
            create: { classroomId: classroom.id, role: "STUDENT" },
          },
        },
      });
    }

    return NextResponse.json({
      ok: true,
      alreadySeeded: false,
      message: "Database berhasil di-seed!",
      accounts: {
        admin: "admin / admin123",
        guru: "guru / guru123",
        student: "budi / siswa123",
      },
    });
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        error: e instanceof Error ? e.message : "SETUP_FAILED",
      },
      { status: 500 }
    );
  }
}
