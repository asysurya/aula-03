"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { UserAvatar } from "@/components/shared/user-avatar";
import { Plus, Pencil, Trash2, Users, Loader2, UserPlus, X } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

interface AdminClassroom {
  id: string;
  name: string;
  description: string | null;
  _count: { members: number; folders: number; groups: number };
  members: {
    userId: string;
    role: "TEACHER" | "STUDENT";
    user: { id: string; name: string; username: string; role: string; avatarColor: string };
  }[];
}

export function ClassroomsPanel() {
  const qc = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [editC, setEditC] = useState<AdminClassroom | null>(null);
  const [membersC, setMembersC] = useState<AdminClassroom | null>(null);
  const [deleteC, setDeleteC] = useState<AdminClassroom | null>(null);

  const { data, isLoading } = useQuery<{ classrooms: AdminClassroom[] }>({
    queryKey: ["admin-classrooms"],
    queryFn: async () => {
      const res = await fetch("/api/admin/classrooms", { cache: "no-store" });
      if (!res.ok) throw new Error();
      return res.json();
    },
  });

  const classrooms = data?.classrooms ?? [];

  const deleteMut = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/admin/classrooms/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Gagal menghapus");
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin-classrooms"] });
      qc.invalidateQueries({ queryKey: ["me"] });
      toast.success("Kelas dihapus");
      setDeleteC(null);
    },
    onError: () => toast.error("Gagal menghapus kelas"),
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h3 className="font-semibold">Daftar Kelas</h3>
          <p className="text-sm text-muted-foreground">
            {classrooms.length} kelas · admin dapat mengatur anggota tiap kelas
          </p>
        </div>
        <Button onClick={() => setCreateOpen(true)} className="gap-1.5">
          <Plus className="h-4 w-4" /> Kelas Baru
        </Button>
      </div>

      {isLoading ? (
        <div className="text-center text-muted-foreground py-10">
          <Loader2 className="h-5 w-5 animate-spin inline mr-2" /> Memuat…
        </div>
      ) : classrooms.length === 0 ? (
        <div className="text-center text-muted-foreground py-10">
          Belum ada kelas. Klik “Kelas Baru”.
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {classrooms.map((c) => (
            <Card key={c.id}>
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between gap-2">
                  <CardTitle className="text-base">{c.name}</CardTitle>
                  <div className="flex gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      onClick={() => setEditC(c)}
                      title="Edit"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-destructive hover:text-destructive"
                      onClick={() => setDeleteC(c)}
                      title="Hapus"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
                {c.description ? (
                  <p className="text-xs text-muted-foreground line-clamp-2">{c.description}</p>
                ) : null}
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex flex-wrap gap-2 text-xs">
                  <Badge variant="secondary" className="gap-1">
                    <Users className="h-3 w-3" /> {c._count.members} anggota
                  </Badge>
                  <Badge variant="secondary">{c._count.folders} folder</Badge>
                  <Badge variant="secondary">{c._count.groups} grup</Badge>
                </div>
                <div className="flex -space-x-2">
                  {c.members.slice(0, 6).map((m) => (
                    <UserAvatar
                      key={m.userId}
                      name={m.user.name}
                      username={m.user.username}
                      size="sm"
                      className="ring-2 ring-background"
                    />
                  ))}
                  {c.members.length > 6 ? (
                    <div className="h-8 w-8 rounded-full bg-muted ring-2 ring-background flex items-center justify-center text-[10px] font-medium text-muted-foreground">
                      +{c.members.length - 6}
                    </div>
                  ) : null}
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full gap-1.5"
                  onClick={() => setMembersC(c)}
                >
                  <UserPlus className="h-3.5 w-3.5" /> Kelola Anggota
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <CreateClassroomDialog open={createOpen} onOpenChange={setCreateOpen} />
      {editC ? (
        <EditClassroomDialog c={editC} open onOpenChange={(o) => !o && setEditC(null)} />
      ) : null}
      {membersC ? (
        <MembersDialog c={membersC} open onOpenChange={(o) => !o && setMembersC(null)} />
      ) : null}
      <AlertDialog open={!!deleteC} onOpenChange={(o) => !o && setDeleteC(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Hapus kelas?</AlertDialogTitle>
            <AlertDialogDescription>
              Menghapus <b>{deleteC?.name}</b> beserta semua folder, file, grup, dan pesan
              di dalamnya. Tidak bisa dibatalkan.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Batal</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => deleteC && deleteMut.mutate(deleteC.id)}
            >
              {deleteMut.isPending ? "Menghapus…" : "Hapus"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function CreateClassroomDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const mut = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/admin/classrooms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, description: desc || undefined }),
      });
      if (!res.ok) throw new Error("Gagal membuat");
    },
    onSuccess: () => {
      toast.success("Kelas dibuat");
      qc.invalidateQueries({ queryKey: ["admin-classrooms"] });
      qc.invalidateQueries({ queryKey: ["me"] });
      setName(""); setDesc("");
      onOpenChange(false);
    },
    onError: () => toast.error("Gagal membuat kelas"),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Kelas Baru</DialogTitle>
          <DialogDescription>
            Admin otomatis menjadi pengajar di kelas ini.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            mut.mutate();
          }}
          className="space-y-3"
        >
          <div className="space-y-1.5">
            <Label>Nama kelas</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} required />
          </div>
          <div className="space-y-1.5">
            <Label>Deskripsi (opsional)</Label>
            <Textarea
              value={desc}
              onChange={(e) => setDesc(e.target.value)}
              maxLength={240}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Batal
            </Button>
            <Button type="submit" disabled={mut.isPending}>
              {mut.isPending ? "Membuat…" : "Buat"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function EditClassroomDialog({
  c,
  open,
  onOpenChange,
}: {
  c: AdminClassroom;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState(c.name);
  const [desc, setDesc] = useState(c.description || "");
  const mut = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/admin/classrooms/${c.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, description: desc }),
      });
      if (!res.ok) throw new Error("Gagal menyimpan");
    },
    onSuccess: () => {
      toast.success("Disimpan");
      qc.invalidateQueries({ queryKey: ["admin-classrooms"] });
      qc.invalidateQueries({ queryKey: ["me"] });
      onOpenChange(false);
    },
    onError: () => toast.error("Gagal menyimpan"),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit Kelas</DialogTitle>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            mut.mutate();
          }}
          className="space-y-3"
        >
          <div className="space-y-1.5">
            <Label>Nama</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} required />
          </div>
          <div className="space-y-1.5">
            <Label>Deskripsi</Label>
            <Textarea value={desc} onChange={(e) => setDesc(e.target.value)} maxLength={240} />
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Batal
            </Button>
            <Button type="submit" disabled={mut.isPending}>
              {mut.isPending ? "Menyimpan…" : "Simpan"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function MembersDialog({
  c,
  open,
  onOpenChange,
}: {
  c: AdminClassroom;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const qc = useQueryClient();
  const [addUserId, setAddUserId] = useState("");
  const [addRole, setAddRole] = useState<"TEACHER" | "STUDENT">("STUDENT");

  const { data, isLoading } = useQuery<{ members: any[]; candidates: any[] }>({
    queryKey: ["admin-classroom-members", c.id],
    queryFn: async () => {
      const res = await fetch(`/api/admin/classrooms/${c.id}/members`, { cache: "no-store" });
      if (!res.ok) throw new Error();
      return res.json();
    },
    enabled: open,
  });

  const addMut = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/admin/classrooms/${c.id}/members`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: addUserId, role: addRole }),
      });
      if (!res.ok) throw new Error("Gagal menambah");
    },
    onSuccess: () => {
      toast.success("Anggota ditambahkan");
      qc.invalidateQueries({ queryKey: ["admin-classroom-members", c.id] });
      qc.invalidateQueries({ queryKey: ["admin-classrooms"] });
      qc.invalidateQueries({ queryKey: ["me"] });
      setAddUserId("");
    },
    onError: () => toast.error("Gagal menambah anggota"),
  });

  const removeMut = useMutation({
    mutationFn: async (userId: string) => {
      const res = await fetch(
        `/api/admin/classrooms/${c.id}/members?userId=${userId}`,
        { method: "DELETE" }
      );
      if (!res.ok) throw new Error("Gagal menghapus");
    },
    onSuccess: () => {
      toast.success("Anggota dikeluarkan");
      qc.invalidateQueries({ queryKey: ["admin-classroom-members", c.id] });
      qc.invalidateQueries({ queryKey: ["admin-classrooms"] });
      qc.invalidateQueries({ queryKey: ["me"] });
    },
    onError: () => toast.error("Gagal mengeluarkan"),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Anggota: {c.name}</DialogTitle>
          <DialogDescription>
            {data?.members.length ?? 0} anggota. Admin otomatis menjadi pengajar.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {/* Add member */}
          <div className="flex gap-2 items-end">
            <div className="flex-1 space-y-1.5">
              <Label className="text-xs">Tambah pengguna</Label>
              <Select value={addUserId} onValueChange={setAddUserId}>
                <SelectTrigger><SelectValue placeholder="Pilih pengguna…" /></SelectTrigger>
                <SelectContent>
                  {(data?.candidates ?? []).map((u) => (
                    <SelectItem key={u.id} value={u.id}>
                      {u.name} (@{u.username})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Select value={addRole} onValueChange={(v: any) => setAddRole(v)}>
              <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="STUDENT">Siswa</SelectItem>
                <SelectItem value="TEACHER">Pengajar</SelectItem>
              </SelectContent>
            </Select>
            <Button
              onClick={() => addMut.mutate()}
              disabled={!addUserId || addMut.isPending}
              size="icon"
            >
              <Plus className="h-4 w-4" />
            </Button>
          </div>

          {/* Member list */}
          <div className="max-h-80 overflow-y-auto space-y-1 rounded-lg border border-border p-1">
            {isLoading ? (
              <p className="text-center text-sm text-muted-foreground py-6">Memuat…</p>
            ) : (data?.members ?? []).length === 0 ? (
              <p className="text-center text-sm text-muted-foreground py-6">
                Belum ada anggota.
              </p>
            ) : (
              (data?.members ?? []).map((m) => (
                <div
                  key={m.userId}
                  className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-accent"
                >
                  <UserAvatar name={m.user.name} username={m.user.username} size="sm" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{m.user.name}</p>
                    <p className="text-xs text-muted-foreground truncate">@{m.user.username}</p>
                  </div>
                  <Badge variant={m.role === "TEACHER" ? "default" : "secondary"}>
                    {m.role === "TEACHER" ? "Pengajar" : "Siswa"}
                  </Badge>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-muted-foreground hover:text-destructive"
                    onClick={() => removeMut.mutate(m.userId)}
                    title="Keluarkan"
                  >
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
