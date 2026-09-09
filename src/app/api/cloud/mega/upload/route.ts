import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/session";
import { uploadMegaFileAction, type UploadBytes } from "@/lib/upload-actions";

// POST /api/cloud/mega/upload — multipart/form-data:
//   `file` (File, wajib) + `parentId` (opsional) + `accountId` (opsional).
// Upload langsung ke folder mana pun di mount MEGA Cloud (guru/admin).
// File yang diupload dari sini TIDAK membuat baris CloudFile — murni
// node MEGA. Inti logika di lib/upload-actions.ts (dipakai juga jalur
// chunked /api/upload/complete untuk file besar).

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const user = await requireUser().catch(() => null);
  if (!user) {
    return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "INVALID_FORMDATA" }, { status: 400 });
  }

  const file = form.get("file");
  const parentIdRaw = form.get("parentId");
  const accountIdRaw = form.get("accountId");
  const parentId =
    typeof parentIdRaw === "string" && parentIdRaw.length > 0 ? parentIdRaw : null;
  const accountId =
    typeof accountIdRaw === "string" && accountIdRaw.length > 0
      ? accountIdRaw
      : null;

  if (!(file instanceof File)) {
    return NextResponse.json({ error: "FILE_REQUIRED" }, { status: 400 });
  }

  const upload: UploadBytes = {
    name: file.name,
    mimetype: file.type || "application/octet-stream",
    size: file.size,
    bytes: Buffer.from(await file.arrayBuffer()),
  };

  const result = await uploadMegaFileAction(user, upload, {
    parentId,
    accountId,
  });
  return NextResponse.json(result.body, { status: result.status });
}
