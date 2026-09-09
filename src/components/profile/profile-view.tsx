"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { UserAvatar } from "@/components/shared/user-avatar";
import { AVATAR_COLORS } from "@/lib/constants";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { Shield, KeyRound, Loader2, Save } from "lucide-react";
import type { MeResponse } from "@/hooks/use-me";

export function ProfileView({ me }: { me: MeResponse }) {
  const user = me.user!;
  const qc = useQueryClient();
  const [name, setName] = useState(user.name);
  const [bio, setBio] = useState(user.bio || "");
  const [color, setColor] = useState(user.avatarColor);
  const [curPw, setCurPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [confPw, setConfPw] = useState("");

  const profileMut = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, bio, avatarColor: color }),
      });
      if (!res.ok) throw new Error("Gagal menyimpan");
    },
    onSuccess: () => {
      toast.success("Profil diperbarui");
      qc.invalidateQueries({ queryKey: ["me"] });
    },
    onError: () => toast.error("Gagal menyimpan profil"),
  });

  const pwMut = useMutation({
    mutationFn: async () => {
      if (newPw !== confPw) throw new Error("Konfirmasi password tidak cocok");
      if (newPw.length < 4) throw new Error("Password baru minimal 4 karakter");
      const res = await fetch("/api/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          currentPassword: curPw,
          newPassword: newPw,
        }),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error(e.error || "Gagal ganti password");
      }
    },
    onSuccess: () => {
      toast.success("Password diganti");
      setCurPw(""); setNewPw(""); setConfPw("");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="h-full overflow-y-auto">
      <div className="border-b border-border px-4 md:px-6 py-4 flex items-center gap-2">
        <Shield className="h-5 w-5 text-primary" />
        <div>
          <h2 className="font-semibold text-lg leading-tight">Profil Saya</h2>
          <p className="text-xs text-muted-foreground">
            Kelola info akun dan password Anda.
          </p>
        </div>
      </div>

      <div className="max-w-2xl mx-auto px-4 md:px-6 py-6 space-y-6">
        {/* Identity card */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Identitas</CardTitle>
            <CardDescription>Info yang tampil ke anggota lain.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center gap-4">
              <UserAvatar
                name={name || user.name}
                username={user.username}
                avatarUrl={user.avatarUrl}
                size="lg"
              />
              <div>
                <p className="font-semibold text-lg">{user.name}</p>
                <p className="text-sm text-muted-foreground">@{user.username}</p>
                <Badge variant={user.role === "ADMIN" ? "default" : "secondary"} className="mt-1">
                  {user.role === "ADMIN" ? "Admin" : user.role === "GURU" ? "Guru" : "Siswa"}
                </Badge>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label>Nama</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
            </div>
            <div className="space-y-1.5">
              <Label>Bio</Label>
              <Textarea
                value={bio}
                onChange={(e) => setBio(e.target.value)}
                maxLength={240}
                placeholder="Sedikit tentang Anda…"
              />
              <p className="text-xs text-muted-foreground">{bio.length}/240</p>
            </div>
            <div className="space-y-1.5">
              <Label>Warna avatar</Label>
              <div className="flex flex-wrap gap-2">
                {AVATAR_COLORS.map((c) => {
                  const key = c.replace("bg-", "").replace("-500", "");
                  return (
                    <button
                      key={c}
                      type="button"
                      onClick={() => setColor(key)}
                      className={cn(
                        "h-8 w-8 rounded-full ring-2 ring-offset-2 ring-offset-background transition-transform hover:scale-110",
                        c,
                        color === key ? "ring-foreground" : "ring-transparent"
                      )}
                    />
                  );
                })}
              </div>
            </div>
            <Button onClick={() => profileMut.mutate()} disabled={profileMut.isPending} className="gap-1.5">
              {profileMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              Simpan Profil
            </Button>
          </CardContent>
        </Card>

        {/* Password card */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Keamanan</CardTitle>
            <CardDescription>Ganti password Anda.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-1.5">
              <Label>Password saat ini</Label>
              <Input
                type="password"
                value={curPw}
                onChange={(e) => setCurPw(e.target.value)}
                autoComplete="current-password"
              />
            </div>
            <div className="grid sm:grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Password baru</Label>
                <Input
                  type="password"
                  value={newPw}
                  onChange={(e) => setNewPw(e.target.value)}
                  autoComplete="new-password"
                />
              </div>
              <div className="space-y-1.5">
                <Label>Konfirmasi password baru</Label>
                <Input
                  type="password"
                  value={confPw}
                  onChange={(e) => setConfPw(e.target.value)}
                  autoComplete="new-password"
                />
              </div>
            </div>
            <Button
              onClick={() => pwMut.mutate()}
              disabled={pwMut.isPending || !curPw || !newPw || !confPw}
              variant="outline"
              className="gap-1.5"
            >
              {pwMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
              Ganti Password
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
