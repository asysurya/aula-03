import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import {
  errorResponse,
  folderClassroomId,
  getClassroomRole,
  isClassroomMember,
} from "@/lib/cloud-utils";
import {
  canEditFolder,
  isFolderAncestor,
  type ClassroomRole,
  type UserRole,
} from "@/lib/cloud-perms";

// POST /api/cloud/folders/copy
// Body: { folderIds: string[], targetFolderId: string|null }
//
// Salin folder SECARA REKURSIF ke folder tujuan (paritas "Ctrl+C → Ctrl+V"
// drive pada umumnya). Baris CloudFile hasil salinan MEMAKAI storageKey yang
// sama dengan aslinya (tidak menduplikasi blob di MEGA/S3 — hemat kuota).
// Nama folder/file diberi akhiran "(salinan)" bila bentrok di tujuan.
//
// Validasi (mengikuti route move):
//  - User boleh mengedit folder sumber (pembuat/admin/guru/guru kelas).
//  - User anggota classroom folder tujuan.
//  - Tujuan bukan folder itu sendiri / turunannya (siklus).
//  - Folder tetap satu classroom (tidak lintas kelas).

const MAX_NODES = 300;

export async function POST(req: NextRequest) {
  const user = await requireUser().catch(() => null);
  if (!user) return errorResponse("UNAUTHORIZED", 401);

  let body: { folderIds?: string[]; targetFolderId?: string | null };
  try {
    body = await req.json();
  } catch {
    return errorResponse("INVALID_JSON", 400);
  }

  const folderIds = Array.isArray(body.folderIds)
    ? body.folderIds.filter((x): x is string => typeof x === "string" && !!x)
    : [];
  if (folderIds.length === 0) return errorResponse("FOLDER_IDS_REQUIRED", 400);
  if (folderIds.length > 20) return errorResponse("TOO_MANY", 400);

  const targetFolderId =
    body.targetFolderId === null || body.targetFolderId === undefined
      ? null
      : String(body.targetFolderId);

  const userRole = user.role as UserRole;

  // ── Resolve target classroom + membership ──
  let targetClassroomId: string | null = null;
  if (targetFolderId) {
    const targetFolder = await db.cloudFolder.findUnique({
      where: { id: targetFolderId },
      select: { id: true, classroomId: true },
    });
    if (!targetFolder) return errorResponse("TARGET_NOT_FOUND", 404);
    targetClassroomId = await folderClassroomId(targetFolderId);
    if (!targetClassroomId) return errorResponse("TARGET_NO_CLASSROOM", 400);
    if (
      userRole !== "ADMIN" &&
      !(await isClassroomMember(targetClassroomId, user.id))
    ) {
      return errorResponse("FORBIDDEN_TARGET", 403);
    }
  }

  // ── Fetch + validasi folder sumber ──
  const folders = await db.cloudFolder.findMany({
    where: { id: { in: folderIds } },
    select: {
      id: true,
      visibility: true,
      createdBy: true,
      classroomId: true,
    },
  });
  if (folders.length === 0) return errorResponse("FOLDERS_NOT_FOUND", 404);
  if (folders.length !== folderIds.length) {
    return errorResponse("SOME_FOLDERS_NOT_FOUND", 404);
  }

  for (const folder of folders) {
    let classroomRole: ClassroomRole | null = null;
    let cid = folder.classroomId;
    if (!cid) cid = await folderClassroomId(folder.id);
    if (cid) {
      classroomRole =
        userRole === "ADMIN" ? "TEACHER" : await getClassroomRole(cid, user.id);
    }
    if (
      !canEditFolder(
        {
          id: folder.id,
          visibility: folder.visibility,
          createdBy: folder.createdBy,
        },
        user.id,
        userRole,
        classroomRole
      )
    ) {
      return errorResponse("FORBIDDEN_FOLDER", 403, { folderId: folder.id });
    }
    // Siklus: tujuan tidak boleh folder itu sendiri / turunannya.
    if (targetFolderId) {
      if (folder.id === targetFolderId) {
        return errorResponse("CANNOT_COPY_INTO_SELF", 400, { folderId: folder.id });
      }
      if (await isFolderAncestor(folder.id, targetFolderId)) {
        return errorResponse("CYCLE_DETECTED", 400, { folderId: folder.id });
      }
    }
    // Tidak lintas classroom.
    if (cid && targetClassroomId && cid !== targetClassroomId) {
      return errorResponse("CROSS_CLASSROOM_COPY_NOT_ALLOWED", 400, {
        folderId: folder.id,
      });
    }
  }

  // ── Salin rekursif ──
  let copiedFolders = 0;
  let copiedFiles = 0;

  /** Nama unik: tambah " (salinan)" / " (salinan 2)" bila bentrok. */
  async function dedupeName(
    base: string,
    isFolder: boolean,
    parentId: string | null
  ): Promise<string> {
    const siblings = await db.cloudFolder.findMany({
      where: { parentId },
      select: { name: true },
    });
    const fileNames = isFolder
      ? new Set<string>()
      : new Set(
          (
            await db.cloudFile.findMany({
              where: { folderId: parentId },
              select: { name: true },
            })
          ).map((f) => f.name)
        );
    const taken = new Set([
      ...siblings.map((s) => s.name),
      ...fileNames,
    ]);
    if (!taken.has(base)) return base;
    for (let i = 1; i < 50; i++) {
      const candidate = `${base} (salinan${i > 1 ? ` ${i}` : ""})`;
      if (!taken.has(candidate)) return candidate;
    }
    return `${base} (${Date.now()})`;
  }

  /** Salin satu subtree folder; mengembalikan id folder baru. */
  async function copyFolderTree(
    sourceId: string,
    newParentId: string | null
  ): Promise<string> {
    const src = await db.cloudFolder.findUniqueOrThrow({
      where: { id: sourceId },
      include: {
        assignment: true,
        files: true,
        children: { select: { id: true } },
      },
    });

    const name = await dedupeName(src.name, true, newParentId);
    const created = await db.cloudFolder.create({
      data: {
        name,
        parentId: newParentId,
        classroomId: src.classroomId,
        type: src.type,
        visibility: src.visibility,
        createdBy: user.id,
      },
    });
    copiedFolders++;

    // Assignment menempel di folder → salin juga (plus Form + soalnya)
    // supaya folder tugas hasil salinan tetap berfungsi.
    if (src.assignment) {
      await db.assignment.create({
        data: {
          folderId: created.id,
          title: src.assignment.title,
          description: src.assignment.description,
          deadline: src.assignment.deadline,
          maxScore: src.assignment.maxScore,
          createdBy: user.id,
        },
      });
      const form = await db.form.findUnique({
        where: { assignmentId: src.assignment.id },
      });
      if (form) {
        const newForm = await db.form.create({
          data: {
            assignmentId: (
              await db.assignment.findUniqueOrThrow({
                where: { folderId: created.id },
                select: { id: true },
              })
            ).id,
            shuffleQuestions: form.shuffleQuestions,
            shuffleOptions: form.shuffleOptions,
            oneByOne: form.oneByOne,
            preventPaste: form.preventPaste,
            trackTabSwitch: form.trackTabSwitch,
            timeLimitMin: form.timeLimitMin,
            showResult: form.showResult,
            createdBy: user.id,
          },
        });
        const questions = await db.formQuestion.findMany({
          where: { formId: form.id },
          orderBy: { order: "asc" },
        });
        for (const q of questions) {
          await db.formQuestion.create({
            data: {
              formId: newForm.id,
              type: q.type,
              text: q.text,
              points: q.points,
              required: q.required,
              order: q.order,
              options: q.options,
              imageFileId: q.imageFileId, // file gambar dipakai bersama
              correct: q.correct,
            },
          });
        }
      }
    }

    // File di dalam folder: baris baru menunjuk storageKey yang sama.
    for (const f of src.files) {
      const fileName = await dedupeName(f.name, false, created.id);
      await db.cloudFile.create({
        data: {
          name: fileName,
          folderId: created.id,
          uploadedBy: user.id,
          storageKey: f.storageKey,
          size: f.size,
          mimetype: f.mimetype,
          visibility: f.visibility,
          cloudAccountId: f.cloudAccountId,
        },
      });
      copiedFiles++;
    }

    // Turunan folder (rekursif) + batas total node.
    for (const child of src.children) {
      if (copiedFolders + copiedFiles > MAX_NODES) {
        return errorResponse("COPY_TOO_LARGE", 400, {
          maxNodes: MAX_NODES,
        });
      }
      await copyFolderTree(child.id, created.id);
    }
    return created.id;
  }

  for (const fid of folderIds) {
    if (copiedFolders + copiedFiles > MAX_NODES) {
      return errorResponse("COPY_TOO_LARGE", 400, { maxNodes: MAX_NODES });
    }
    await copyFolderTree(fid, targetFolderId);
  }

  return Response.json({
    ok: true,
    copiedFolders,
    copiedFiles,
  });
}
