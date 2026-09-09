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
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useUIStore, type Conversation } from "@/stores/ui-store";

interface JoinedGroup {
  id: string;
  name: string;
}

export function GroupJoinDialog({
  open,
  onOpenChange,
  trigger,
}: {
  open?: boolean;
  onOpenChange?: (o: boolean) => void;
  trigger?: React.ReactNode;
}) {
  const [internalOpen, setInternalOpen] = useState(false);
  const isOpen = open ?? internalOpen;
  const setOpen = onOpenChange ?? setInternalOpen;
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(false);
  const queryClient = useQueryClient();
  const openConversation = useUIStore((s) => s.openConversation);

  async function submit() {
    const trimmed = code.trim();
    if (trimmed.length < 4) {
      toast.error("Masukkan kode invite yang valid");
      return;
    }
    setLoading(true);
    try {
      const res = await fetch("/api/chat/groups/join", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ inviteCode: trimmed }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Gagal bergabung");
      const group: JoinedGroup = data.group;
      await queryClient.invalidateQueries({ queryKey: ["me"] });
      const conv: Conversation = {
        kind: "group",
        id: group.id,
        name: group.name,
      };
      openConversation(conv);
      toast.success(
        data.alreadyMember
          ? `Kamu sudah anggota "${group.name}"`
          : `Berhasil bergabung ke "${group.name}"`
      );
      setOpen(false);
      setCode("");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Gagal bergabung");
    } finally {
      setLoading(false);
    }
  }

  const content = (
    <DialogContent className="max-w-md">
      <DialogHeader>
        <DialogTitle>Gabung grup</DialogTitle>
        <DialogDescription>
          Masukkan kode invite 8 karakter dari temanmu. Maks 20 grup per
          pengguna. Kode tidak bersifat sensitif huruf.
        </DialogDescription>
      </DialogHeader>
      <div className="space-y-1.5">
        <Label htmlFor="grp-code">Kode invite</Label>
        <Input
          id="grp-code"
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase().slice(0, 8))}
          placeholder="ABCD1234"
          className="font-mono tracking-widest uppercase"
          autoComplete="off"
          autoFocus
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
        />
      </div>
      <DialogFooter>
        <Button
          variant="outline"
          onClick={() => setOpen(false)}
          disabled={loading}
        >
          Batal
        </Button>
        <Button onClick={submit} disabled={loading || code.trim().length < 4}>
          {loading ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" /> Bergabung…
            </>
          ) : (
            "Gabung"
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
