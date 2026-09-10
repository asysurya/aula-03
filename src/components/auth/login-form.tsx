"use client";

import { useEffect, useState } from "react";
import { signIn } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Logo } from "@/components/shared/logo";
import { ThemeToggle } from "@/components/shared/theme-toggle";
import { APP_NAME, APP_TAGLINE } from "@/lib/constants";
import { Loader2, LogIn } from "lucide-react";
import { toast } from "sonner";

export function LoginForm() {
  const router = useRouter();
  const qc = useQueryClient();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  // Auto-seed database on first load (idempotent — safe to call multiple times).
  // Ensures admin account exists after a fresh deploy to space-z.
  useEffect(() => {
    fetch("/api/setup", { cache: "no-store" })
      .then((r) => r.json())
      .catch(() => {
        // Ignore errors — sandbox can't reach MongoDB, that's expected.
      });
  }, []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!username.trim() || !password) {
      toast.error("Isi username dan password");
      return;
    }
    setLoading(true);
    const res = await signIn("credentials", {
      username: username.trim().toLowerCase(),
      password,
      redirect: false,
    });
    setLoading(false);
    if (res?.error) {
      toast.error("Username atau password salah");
      return;
    }
    toast.success("Berhasil masuk!");
    qc.invalidateQueries({ queryKey: ["me"] });
    router.refresh();
  }

  return (
    <div className="relative min-h-screen flex flex-col bg-gradient-to-br from-background via-background to-accent/30">
      {/* decorative blobs */}
      <div className="pointer-events-none absolute -top-24 -right-24 h-72 w-72 rounded-full bg-primary/20 blur-3xl" />
      <div className="pointer-events-none absolute -bottom-24 -left-24 h-72 w-72 rounded-full bg-brand/20 blur-3xl" />

      <header className="flex items-center justify-between px-5 py-4">
        <Logo />
        <ThemeToggle />
      </header>

      <main className="flex-1 flex items-center justify-center px-4 pb-10">
        <Card className="w-full max-w-sm shadow-xl border-border/60 backdrop-blur-sm">
          <CardHeader className="space-y-2 text-center">
            <div className="mx-auto">
              <Logo showText={false} className="scale-125" />
            </div>
            <CardTitle className="text-2xl">Selamat datang di {APP_NAME}</CardTitle>
            <CardDescription>{APP_TAGLINE}</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={onSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="username">Username</Label>
                <Input
                  id="username"
                  autoCapitalize="none"
                  autoCorrect="off"
                  placeholder="cth: admin"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  disabled={loading}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="password">Password</Label>
                <PasswordInput
                  id="password"
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={loading}
                  autoComplete="current-password"
                />
              </div>
              <Button type="submit" className="w-full" disabled={loading}>
                {loading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <>
                    <LogIn className="h-4 w-4" /> Masuk
                  </>
                )}
              </Button>
            </form>
          </CardContent>
        </Card>
      </main>

      <footer className="px-5 py-4 text-center text-xs text-muted-foreground">
        {APP_NAME} · dibuat untuk diskusi & kerja kelompok kelas
      </footer>
    </div>
  );
}
