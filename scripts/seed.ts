import bcrypt from "bcryptjs";
import { db } from "@/lib/db";

async function main() {
  console.log("🌱 Seeding Aula...");

  // Admin user (default credentials — CHANGE PASSWORD after first login!)
  const adminPass = await bcrypt.hash("admin123", 10);
  const admin = await db.user.upsert({
    where: { username: "admin" },
    update: {},
    create: {
      username: "admin",
      name: "Administrator",
      password: adminPass,
      role: "ADMIN",
      avatarColor: "emerald",
      bio: "Pengelola kelas",
    },
  });

  // Default classroom
  const classroom = await db.classroom.upsert({
    where: { id: "default-classroom" },
    update: {},
    create: {
      id: "default-classroom",
      name: "Kelas 12 IPA 1",
      description: "Ruang utama diskusi kelas",
    },
  });

  await db.classroomMember.upsert({
    where: {
      classroomId_userId: { classroomId: classroom.id, userId: admin.id },
    },
    update: { role: "TEACHER" },
    create: { classroomId: classroom.id, userId: admin.id, role: "TEACHER" },
  });

  // A few sample students
  const students = [
    { username: "budi", name: "Budi Santoso" },
    { username: "siti", name: "Siti Nurhaliza" },
    { username: "andi", name: "Andi Wijaya" },
  ];
  const studentPass = await bcrypt.hash("siswa123", 10);
  for (const s of students) {
    const u = await db.user.upsert({
      where: { username: s.username },
      update: {},
      create: {
        username: s.username,
        name: s.name,
        password: studentPass,
        role: "STUDENT",
      },
    });
    await db.classroomMember.upsert({
      where: {
        classroomId_userId: { classroomId: classroom.id, userId: u.id },
      },
      update: {},
      create: { classroomId: classroom.id, userId: u.id, role: "STUDENT" },
    });
  }

  // A sample guru (teacher) account
  const guruPass = await bcrypt.hash("guru123", 10);
  const guru = await db.user.upsert({
    where: { username: "guru" },
    update: {},
    create: {
      username: "guru",
      name: "Pak Andika",
      password: guruPass,
      role: "GURU",
      avatarColor: "violet",
      bio: "Guru Matematika",
    },
  });
  await db.classroomMember.upsert({
    where: {
      classroomId_userId: { classroomId: classroom.id, userId: guru.id },
    },
    update: { role: "TEACHER" },
    create: { classroomId: classroom.id, userId: guru.id, role: "TEACHER" },
  });

  // Root cloud folder for the classroom
  await db.cloudFolder.upsert({
    where: { id: "root-classroom-folder" },
    update: {},
    create: {
      id: "root-classroom-folder",
      name: "Materi Kelas",
      classroomId: classroom.id,
      createdBy: admin.id,
      type: "FOLDER",
    },
  });

  console.log("✅ Seed complete.");
  console.log("   Admin login:    admin / admin123");
  console.log("   Guru login:     guru / guru123");
  console.log("   Student login:  budi / siswa123");
  console.log("   ⚠️  Change passwords after first login!");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await db.$disconnect();
  });
