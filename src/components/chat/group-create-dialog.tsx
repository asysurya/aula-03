"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AutoTextarea } from "@/components/ui/auto-textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useUIStore, type Conversation } from "@/stores/ui-store";
import type { MeResponse } from "@/hooks/use-me";

interface CreatedGroup {
  id: string;
  name: string;
}

export function GroupCreateDialog({
  me,
  open,
  onOpenChange,
  trigger,
}: {
  me: MeResponse;
  open?: boolean;
  onOpenChange?: (o: boolean) => void;
  trigger?: React.ReactNode;
}) {
  const [internalOpen, setInternalOpen] = useState(false);
  const isOpen = open ?? internalOpen;
  const setOpen = onOpenChange ?? setInternalOpen;
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [classroomId, setClassroomId] = useState<string>("");
  const [allowStudentInvite, setAllowStudentInvite] = useState(false);
  const [loading, setLoading] = useState(false);
  const queryClient = useQueryClient();
  const openConversation = useUIStore((s) => s.openConversation);

  const classrooms = me.classrooms;

  async function submit() {
    const trimmed = name.trim();
    if (trimmed.length < 2) {
      toast.error("Nama grup minimal 2 karakter");
      return;
    }
    setLoading(true);
    try {
      const res = await fetch("/api/chat/groups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: trimmed,
          description: description.trim() || undefined,
          classroomId: classroomId || undefined,
          allowStudentInvite,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Gagal membuat grup");
      const group: CreatedGroup = data.group;
      await queryClient.invalidateQueries({ queryKey: ["me"] });
      const conv: Conversation = {
        kind: "group",
        id: group.id,
        name: group.name,
      };
      openConversation(conv);
      toast.success(`Grup "${group.name}" dibuat`);
      setOpen(false);
      setName("");
      setDescription("");
      setClassroomId("");
      setAllowStudentInvite(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Gagal membuat grup");
    } finally {
      setLoading(false);
    }
  }

  const content = (
    <DialogContent className="max-w-md">
      <DialogHeader>
        <DialogTitle>Buat grup diskusi</DialogTitle>
        <DialogDescription>
          Grup privat dengan kode invite. Maks 2 grup per pengguna. Bagikan
          kode ke teman untuk bergabung.
        </DialogDescription>
      </DialogHeader>
      <div className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="grp-name">Nama grup</Label>
          <Input
            id="grp-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Misal: Tim LKS Fisika"
            maxLength={60}
            autoFocus
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="grp-desc">Deskripsi (opsional)</Label>
          <AutoTextarea
            id="grp-desc"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Apa tujuan grup ini?"
            maxHeight={120}
            maxLength={280}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="grp-class">Tautkan ke kelas (opsional)</Label>
          <Select
            value={classroomId}
            onValueChange={(v) => setClassroomId(v === "__none__" ? "" : v)}
          >
            <SelectTrigger id="grp-class">
              <SelectValue placeholder="Tanpa kelas" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__none__">Tanpa kelas</SelectItem>
              {classrooms.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-start gap-2 rounded-md border border-border bg-muted/30 p-3">
          <Checkbox
            id="grp-allow-student"
            checked={allowStudentInvite}
            onCheckedChange={(v) => setAllowStudentInvite(v === true)}
            className="mt-0.5"
          />
          <div className="space-y-0.5">
            <Label htmlFor="grp-allow-student" className="cursor-pointer text-sm font-medium">
              Izinkan siswa membagikan kode invite
            </Label>
            <p className="text-xs text-muted-foreground">
              Jika nonaktif, hanya guru & admin yang bisa membagikan kode invite
              grup ini. Default: nonaktif.
            </p>
          </div>
        </div>
      </div>
      <DialogFooter>
        <Button
          variant="outline"
          onClick={() => setOpen(false)}
          disabled={loading}
        >
          Batal
        </Button>
        <Button onClick={submit} disabled={loading || name.trim().length < 2}>
          {loading ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" /> Membuat…
            </>
          ) : (
            "Buat Grup"
          )}
        </Button>
      </DialogFooter>
    </DialogContent>
  );

  if (trigger) {
    return (
      <Dialog open={isOpen} onOpenChange={setOpen}>
        <DialogTrigger asChild>{trigger}</DialogTrigger>
        {content}
      </Dialog>
    );
  }

  return (
    <Dialog open={isOpen} onOpenChange={setOpen}>
      {content}
    </Dialog>
  );
}
