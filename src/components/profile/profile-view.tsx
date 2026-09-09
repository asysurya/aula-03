"use client";

import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { UserAvatar } from "@/components/shared/user-avatar";
import { AVATAR_COLORS } from "@/lib/constants";
import { uploadSmart } from "@/lib/upload-client";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { Shield, KeyRound, Loader2, Save, Camera, Trash2, Lock } from "lucide-react";
import type { MeResponse } from "@/hooks/use-me";

export function ProfileView({ me }: { me: MeResponse }) {
  const user = me.user!;
  const qc = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(user.name);
  const [bio, setBio] = useState(user.bio || "");
  const [color, setColor] = useState(user.avatarColor);
  const [avatarUrl, setAvatarUrl] = useState(user.avatarUrl || "");
  const [curPw, setCurPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [confPw, setConfPw] = useState("");

  const profileMut = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          bio,
          avatarColor: color,
          avatarUrl: avatarUrl || "",
        }),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error(e.error || "Gagal menyimpan");
      }
    },
    onSuccess: () => {
      toast.success("Profil diperbarui");
      qc.invalidateQueries({ queryKey: ["me"] });
      qc.invalidateQueries({ queryKey: ["messages"] });
    },
    onError: (e: Error) => toast.error(e.message),
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

  // Upload foto avatar langsung ke cloud (MEGA/S3) — file besar otomatis
  // chunked supaya lolos batas body serverless.
  const avatarUploadMut = useMutation({
    mutationFn: async (file: File) => {
      const res = await uploadSmart<{ avatarUrl?: string; error?: string }>(file, {
        kind: "avatar",
      });
      if (!res.ok || !res.json.avatarUrl) {
        throw new Error(res.json.error || "Gagal mengunggah foto");
      }
      return res.json as { avatarUrl: string };
    },
    onSuccess: (data) => {
      setAvatarUrl(data.avatarUrl);
      toast.success("Foto profil diperbarui");
      qc.invalidateQueries({ queryKey: ["me"] });
      qc.invalidateQueries({ queryKey: ["messages"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const avatarDeleteMut = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/profile/avatar", { method: "DELETE" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Gagal menghapus foto");
    },
    onSuccess: () => {
      setAvatarUrl("");
      toast.success("Foto profil dihapus");
      qc.invalidateQueries({ queryKey: ["me"] });
      qc.invalidateQueries({ queryKey: ["messages"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const onPickFile = (f: File | null | undefined) => {
    if (!f) return;
    if (!f.type.startsWith("image/")) {
      toast.error("File harus berupa gambar");
      return;
    }
    if (f.size > 5 * 1024 * 1024) {
      toast.error("Foto maksimal 5 MB");
      return;
    }
    avatarUploadMut.mutate(f);
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="border-b border-border px-4 md:px-6 py-4 flex items-center gap-2">
        <Shield className="h-5 w-5 text-primary" />
        <div>
          <h2 className="font-semibold text-lg leading-tight">Profil Saya</h2>
          <p className="text-xs text-muted-foreground">
            Kelola info akun, foto, dan password Anda.
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
            <div className="flex items-center gap-4 flex-wrap">
              <div className="relative group">
                <UserAvatar
                  name={name || user.name}
                  username={user.username}
                  avatarUrl={avatarUrl || null}
                  size="lg"
                />
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={avatarUploadMut.isPending}
                  title="Ganti foto profil"
                  className="absolute -bottom-1 -right-1 rounded-full bg-primary text-primary-foreground p-1.5 shadow-md hover:scale-110 transition-transform disabled:opacity-50"
                >
                  {avatarUploadMut.isPending ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Camera className="h-3.5 w-3.5" />
                  )}
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => {
                    onPickFile(e.target.files?.[0]);
                    e.target.value = "";
                  }}
                />
              </div>
              <div>
                <p className="font-semibold text-lg">{user.name}</p>
                <p className="text-sm text-muted-foreground">@{user.username}</p>
                <Badge variant={user.role === "ADMIN" ? "default" : "secondary"} className="mt-1">
                  {user.role === "ADMIN" ? "Admin" : user.role === "GURU" ? "Guru" : "Siswa"}
                </Badge>
              </div>
              <div className="flex flex-col gap-1.5 sm:ml-auto">
                <Button
                  size="sm"
                  variant="outline"
                  className="gap-1.5"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={avatarUploadMut.isPending}
                >
                  {avatarUploadMut.isPending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Camera className="h-4 w-4" />
                  )}
                  Unggah Foto
                </Button>
                {avatarUrl ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="gap-1.5 text-destructive hover:text-destructive"
                    onClick={() => avatarDeleteMut.mutate()}
                    disabled={avatarDeleteMut.isPending}
                  >
                    {avatarDeleteMut.isPending ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Trash2 className="h-4 w-4" />
                    )}
                    Hapus Foto
                  </Button>
                ) : null}
              </div>
            </div>

            <div className="space-y-1.5">
              <Label>Username</Label>
              <div className="relative">
                <Input value={user.username} disabled readOnly />
                <Lock className="h-3.5 w-3.5 text-muted-foreground absolute right-3 top-1/2 -translate-y-1/2" />
              </div>
              <p className="text-xs text-muted-foreground">
                Username dipakai untuk login dan tidak bisa diubah.
              </p>
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
