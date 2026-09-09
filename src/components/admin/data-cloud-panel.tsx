"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Switch } from "@/components/ui/switch";
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
import {
  Database,
  Cloud,
  Plus,
  Pencil,
  Trash2,
  Loader2,
  Star,
  Zap,
  AlertCircle,
  Info,
  RefreshCw,
} from "lucide-react";
import { toast } from "sonner";
import { formatDistanceToNow, format } from "date-fns";
import { id as idLocale } from "date-fns/locale";
import { formatBytes } from "@/lib/cloud-format";
import {
  mountVisibleToLabel,
  mountModeLabel,
} from "@/lib/mount-access";
import { cn } from "@/lib/utils";

// ────────────────────────────── Types ──────────────────────────────

type ConnStatus = "connected" | "error" | "unknown" | "checking";

interface DatabaseConnection {
  id: string;
  name: string;
  type: string;
  uriMasked: string;
  isPrimary: boolean;
  active: boolean;
  lastStatus: ConnStatus;
  lastCheckedAt: string | null;
  lastError: string | null;
  latencyMs: number | null;
  createdAt: string;
  updatedAt: string;
}

interface CloudAccount {
  id: string;
  name: string;
  provider: string;
  email: string | null;
  hasPassword: boolean;
  hasKey: boolean;
  hasSession?: boolean;
  active: boolean;
  lastStatus: ConnStatus;
  lastCheckedAt: string | null;
  lastError: string | null;
  spaceTotal: number | null;
  spaceUsed: number | null;
  fileCount: number;
  createdAt: string;
  updatedAt: string;
  // Hak akses mount (file explorer akun cloud di halaman Cloud)
  mountVisibleTo?: "ADMIN" | "GURU" | "ALL";
  mountMode?: "READ" | "WRITE";
  // S3-compatible
  endpoint: string | null;
  region: string | null;
  bucket: string | null;
  hasSecret?: boolean;
}

// ─────────────────────────── Status badge ───────────────────────────

function StatusBadge({ status }: { status: ConnStatus }) {
  const map: Record<ConnStatus, { label: string; dot: string; ring: string }> = {
    connected: { label: "Terhubung", dot: "bg-emerald-500", ring: "text-emerald-600" },
    error: { label: "Error", dot: "bg-red-500", ring: "text-red-600" },
    unknown: { label: "Belum dites", dot: "bg-zinc-400", ring: "text-zinc-500" },
    checking: { label: "Memeriksa…", dot: "bg-amber-500 animate-pulse", ring: "text-amber-600" },
  };
  const cfg = map[status] ?? map.unknown;
  return (
    <Badge variant="secondary" className="gap-1.5 font-normal">
      <span className={cn("h-1.5 w-1.5 rounded-full", cfg.dot)} />
      {cfg.label}
    </Badge>
  );
}

function relativeTime(iso: string | null): string {
  if (!iso) return "—";
  try {
    return formatDistanceToNow(new Date(iso), { addSuffix: true, locale: idLocale });
  } catch {
    return "—";
  }
}

// ─────────────────────────── Panel root ───────────────────────────

export function DataCloudPanel() {
  return (
    <div className="space-y-4">
      <InfoBanner />
      <div className="grid gap-4 lg:grid-cols-2">
        <DatabaseConnectionsSection />
        <CloudAccountsSection />
      </div>
    </div>
  );
}

function InfoBanner() {
  return (
    <div className="rounded-lg border border-emerald-200 dark:border-emerald-900/50 bg-emerald-50 dark:bg-emerald-950/30 px-4 py-3 text-sm flex gap-2.5">
      <Info className="h-4 w-4 text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5" />
      <div className="space-y-1 text-emerald-900 dark:text-emerald-100">
        <p>
          File cloud diunggah ke akun <b>MEGA</b> aktif; bila MEGA gagal
          (mis. akun diblokir) atau belum diatur, otomatis jatuh ke akun{" "}
          <b>S3-compatible</b> (Cloudflare R2 / Backblaze B2 / Spaces).
        </p>
        <p className="text-emerald-700 dark:text-emerald-300/80">
          Koneksi <b>MongoDB</b> di sini hanya untuk monitoring/status — DB
          aplikasi (Aula) sendiri diatur lewat env <code className="font-mono">DATABASE_URL</code>.
        </p>
      </div>
    </div>
  );
}

// ─────────────────────── Database Connections ───────────────────────

function DatabaseConnectionsSection() {
  const qc = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [editC, setEditC] = useState<DatabaseConnection | null>(null);
  const [deleteC, setDeleteC] = useState<DatabaseConnection | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);

  const { data, isLoading } = useQuery<{ connections: DatabaseConnection[] }>({
    queryKey: ["admin-db-connections"],
    queryFn: async () => {
      const res = await fetch("/api/admin/database-connections", { cache: "no-store" });
      if (!res.ok) throw new Error();
      return res.json();
    },
  });

  const connections = data?.connections ?? [];

  const toggleActive = useMutation({
    mutationFn: async (c: DatabaseConnection) => {
      const res = await fetch(`/api/admin/database-connections/${c.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: !c.active }),
      });
      if (!res.ok) throw new Error();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-db-connections"] }),
    onError: () => toast.error("Gagal mengubah status"),
  });

  const testMut = useMutation({
    mutationFn: async (id: string) => {
      setTestingId(id);
      const res = await fetch(`/api/admin/database-connections/${id}/test`, {
        method: "POST",
      });
      if (!res.ok) throw new Error();
      return res.json();
    },
    onSuccess: (data: { status: string; latencyMs?: number; error?: string }) => {
      qc.invalidateQueries({ queryKey: ["admin-db-connections"] });
      if (data.status === "connected") {
        toast.success(`Terhubung · ${data.latencyMs ?? 0} ms`);
      } else if (data.status === "error") {
        toast.error(data.error || "Koneksi gagal");
      } else {
        toast(data.error || "Tipe belum didukung");
      }
      setTestingId(null);
    },
    onError: () => {
      toast.error("Gagal menguji koneksi");
      setTestingId(null);
    },
  });

  const deleteMut = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/admin/database-connections/${id}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin-db-connections"] });
      toast.success("Koneksi dihapus");
      setDeleteC(null);
    },
    onError: () => toast.error("Gagal menghapus koneksi"),
  });

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Database className="h-4 w-4 text-primary" />
          <div>
            <h3 className="font-semibold leading-tight">Database Connections</h3>
            <p className="text-xs text-muted-foreground">
              {connections.length} koneksi · monitoring status
            </p>
          </div>
        </div>
        <Button size="sm" onClick={() => setCreateOpen(true)} className="gap-1.5">
          <Plus className="h-4 w-4" /> Tambah
        </Button>
      </div>

      {isLoading ? (
        <div className="text-center text-muted-foreground py-8 text-sm">
          <Loader2 className="h-4 w-4 animate-spin inline mr-2" /> Memuat…
        </div>
      ) : connections.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            <Database className="h-6 w-6 mx-auto mb-2 opacity-40" />
            Belum ada koneksi database. Klik “Tambah”.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {connections.map((c) => (
            <Card key={c.id}>
              <CardHeader className="pb-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <CardTitle className="text-base flex items-center gap-1.5 truncate">
                      {c.name}
                      {c.isPrimary ? (
                        <Star className="h-3.5 w-3.5 fill-amber-500 text-amber-500" />
                      ) : null}
                    </CardTitle>
                    <Badge
                      variant="secondary"
                      className="bg-primary/10 text-primary font-mono text-[10px]"
                    >
                      {c.type}
                    </Badge>
                  </div>
                  <StatusBadge status={c.lastStatus} />
                </div>
              </CardHeader>
              <CardContent className="space-y-2.5 pt-0">
                <div className="text-xs font-mono text-muted-foreground break-all">
                  {c.uriMasked}
                </div>
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  <span>
                    Latensi:{" "}
                    <span className="font-medium text-foreground">
                      {c.latencyMs != null ? `${c.latencyMs} ms` : "—"}
                    </span>
                  </span>
                  <span>
                    Diperiksa:{" "}
                    <span className="font-medium text-foreground">
                      {relativeTime(c.lastCheckedAt)}
                    </span>
                  </span>
                  {c.lastError ? (
                    <span className="text-red-600 dark:text-red-400 inline-flex items-center gap-1">
                      <AlertCircle className="h-3 w-3" />
                      <span className="truncate max-w-[14rem]">{c.lastError}</span>
                    </span>
                  ) : null}
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                  <div className="flex items-center gap-2">
                    <Switch
                      checked={c.active}
                      onCheckedChange={() => toggleActive.mutate(c)}
                    />
                    <span className="text-xs text-muted-foreground">
                      {c.active ? "Aktif" : "Nonaktif"}
                    </span>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 gap-1.5"
                      onClick={() => testMut.mutate(c.id)}
                      disabled={testingId === c.id}
                    >
                      {testingId === c.id ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Zap className="h-3.5 w-3.5" />
                      )}
                      Tes Koneksi
                    </Button>
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
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <CreateConnectionDialog open={createOpen} onOpenChange={setCreateOpen} />
      {editC ? (
        <EditConnectionDialog
          conn={editC}
          open
          onOpenChange={(o) => !o && setEditC(null)}
        />
      ) : null}
      <AlertDialog
        open={!!deleteC}
        onOpenChange={(o) => !o && setDeleteC(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Hapus koneksi?</AlertDialogTitle>
            <AlertDialogDescription>
              Menghapus <b>{deleteC?.name}</b>. Konfigurasi koneksi akan dihapus permanen.
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

function CreateConnectionDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [type, setType] = useState("mongodb");
  const [uri, setUri] = useState("");
  const [isPrimary, setIsPrimary] = useState(false);

  const mut = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/admin/database-connections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, type, uri, isPrimary }),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error(e.error || "Gagal membuat");
      }
      return res.json();
    },
    onSuccess: () => {
      toast.success("Koneksi dibuat");
      qc.invalidateQueries({ queryKey: ["admin-db-connections"] });
      setName(""); setType("mongodb"); setUri(""); setIsPrimary(false);
      onOpenChange(false);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Tambah Koneksi Database</DialogTitle>
          <DialogDescription>
            Koneksi disimpan untuk monitoring status. Aplikasi tetap pakai DATABASE_URL untuk datanya sendiri.
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
            <Label>Nama koneksi</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} required placeholder="cth: Atlas Prod" />
          </div>
          <div className="space-y-1.5">
            <Label>Tipe</Label>
            <Select value={type} onValueChange={setType}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="mongodb">MongoDB</SelectItem>
                <SelectItem value="postgres">PostgreSQL (segera)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Connection URI</Label>
            <Input
              value={uri}
              onChange={(e) => setUri(e.target.value)}
              required
              autoCapitalize="none"
              spellCheck={false}
              className="font-mono text-xs"
              placeholder="mongodb+srv://user:pass@cluster.xxxxx.mongodb.net"
            />
            <p className="text-xs text-muted-foreground">
              URI disimpan sensitif. Hanya 8 karakter terakhir yang ditampilkan.
            </p>
          </div>
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <Switch checked={isPrimary} onCheckedChange={setIsPrimary} />
            <span>jadikan koneksi utama</span>
          </label>
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

function EditConnectionDialog({
  conn,
  open,
  onOpenChange,
}: {
  conn: DatabaseConnection;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState(conn.name);
  const [uri, setUri] = useState("");
  const [isPrimary, setIsPrimary] = useState(conn.isPrimary);

  const mut = useMutation({
    mutationFn: async () => {
      const body: Record<string, unknown> = { name, isPrimary };
      if (uri.length > 0) body.uri = uri;
      const res = await fetch(`/api/admin/database-connections/${conn.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error(e.error || "Gagal menyimpan");
      }
      return res.json();
    },
    onSuccess: () => {
      toast.success("Perubahan disimpan");
      qc.invalidateQueries({ queryKey: ["admin-db-connections"] });
      onOpenChange(false);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit Koneksi</DialogTitle>
          <DialogDescription>@{conn.uriMasked}</DialogDescription>
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
            <Label>URI baru (opsional)</Label>
            <Input
              value={uri}
              onChange={(e) => setUri(e.target.value)}
              autoCapitalize="none"
              spellCheck={false}
              className="font-mono text-xs"
              placeholder={conn.uriMasked}
            />
            <p className="text-xs text-muted-foreground">
              Kosongkan jika tidak ingin mengubah.
            </p>
          </div>
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <Switch checked={isPrimary} onCheckedChange={setIsPrimary} />
            <span>jadikan koneksi utama</span>
          </label>
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

// ───────────────────────── Cloud Accounts ─────────────────────────

function CloudAccountsSection() {
  const qc = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [editA, setEditA] = useState<CloudAccount | null>(null);
  const [deleteA, setDeleteA] = useState<CloudAccount | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [syncingId, setSyncingId] = useState<string | null>(null);
  const [syncingAll, setSyncingAll] = useState(false);

  const { data, isLoading } = useQuery<{ accounts: CloudAccount[] }>({
    queryKey: ["admin-cloud-accounts"],
    queryFn: async () => {
      const res = await fetch("/api/admin/cloud-accounts", { cache: "no-store" });
      if (!res.ok) throw new Error();
      return res.json();
    },
  });

  const accounts = data?.accounts ?? [];

  const toggleActive = useMutation({
    mutationFn: async (a: CloudAccount) => {
      const res = await fetch(`/api/admin/cloud-accounts/${a.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: !a.active }),
      });
      if (!res.ok) throw new Error();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-cloud-accounts"] }),
    onError: () => toast.error("Gagal mengubah status"),
  });

  const testMut = useMutation({
    mutationFn: async (id: string) => {
      setTestingId(id);
      const res = await fetch(`/api/admin/cloud-accounts/${id}/test`, {
        method: "POST",
      });
      if (!res.ok) throw new Error();
      return res.json();
    },
    onSuccess: (data: { status: string; spaceTotal?: number; spaceUsed?: number; error?: string }) => {
      qc.invalidateQueries({ queryKey: ["admin-cloud-accounts"] });
      if (data.status === "connected") {
        const used = data.spaceUsed ? formatBytes(data.spaceUsed) : "?";
        const total = data.spaceTotal ? formatBytes(data.spaceTotal) : "?";
        toast.success(`Terhubung · ${used} / ${total}`);
      } else if (data.status === "error") {
        toast.error(data.error || "Login gagal");
      } else {
        toast(data.error || "Provider belum didukung");
      }
      setTestingId(null);
    },
    onError: () => {
      toast.error("Gagal menguji akun");
      setTestingId(null);
    },
  });

  const deleteMut = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/admin/cloud-accounts/${id}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error(e.error || "Gagal menghapus");
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin-cloud-accounts"] });
      toast.success("Akun dihapus");
      setDeleteA(null);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // Patch hak akses mount (siapa boleh membuka + mode baca/tulis).
  const mountAccessMut = useMutation({
    mutationFn: async (payload: {
      id: string;
      mountVisibleTo?: "ADMIN" | "GURU" | "ALL";
      mountMode?: "READ" | "WRITE";
    }) => {
      const { id, ...body } = payload;
      const res = await fetch(`/api/admin/cloud-accounts/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error(e.error || "Gagal menyimpan hak akses");
      }
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin-cloud-accounts"] });
      toast.success("Hak akses mount diperbarui");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // Sync one account: migrate local files to this MEGA account.
  const syncMut = useMutation({
    mutationFn: async (id: string) => {
      setSyncingId(id);
      const res = await fetch(`/api/admin/cloud-accounts/${id}/sync`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ limit: 50 }),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error(e.error || "Gagal sinkronisasi");
      }
      return res.json();
    },
    onSuccess: (data: { synced?: number; failed?: number; total?: number; message?: string }) => {
      qc.invalidateQueries({ queryKey: ["admin-cloud-accounts"] });
      if (data.message) {
        toast(data.message);
      } else {
        toast.success(
          `Sinkronisasi selesai: ${data.synced ?? 0} dipindah, ${data.failed ?? 0} gagal`
        );
      }
      setSyncingId(null);
    },
    onError: (e: Error) => {
      toast.error(e.message);
      setSyncingId(null);
    },
  });

  // Sync all: distribute local files across all active MEGA accounts.
  const syncAllMut = useMutation({
    mutationFn: async () => {
      setSyncingAll(true);
      const res = await fetch("/api/admin/cloud-accounts/sync-all", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ limit: 100 }),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error(e.error || "Gagal sinkronisasi");
      }
      return res.json();
    },
    onSuccess: (data: { synced?: number; failed?: number; accountsUsed?: number; message?: string }) => {
      qc.invalidateQueries({ queryKey: ["admin-cloud-accounts"] });
      if (data.message) {
        toast(data.message);
      } else {
        toast.success(
          `Sinkronisasi semua: ${data.synced ?? 0} file dipindah ke ${data.accountsUsed ?? 0} akun`
        );
      }
      setSyncingAll(false);
    },
    onError: (e: Error) => {
      toast.error(e.message);
      setSyncingAll(false);
    },
  });

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Cloud className="h-4 w-4 text-primary" />
          <div>
            <h3 className="font-semibold leading-tight">Cloud Storage Accounts</h3>
            <p className="text-xs text-muted-foreground">
              {accounts.length} akun · MEGA + S3 (R2/B2/Spaces)
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {accounts.length > 0 ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => syncAllMut.mutate()}
              disabled={syncingAll || syncMut.isPending}
              className="gap-1.5"
              title="Pindahkan semua file lokal ke akun MEGA aktif (round-robin)"
            >
              {syncingAll ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4" />
              )}
              Sync All
            </Button>
          ) : null}
          <Button size="sm" onClick={() => setCreateOpen(true)} className="gap-1.5">
            <Plus className="h-4 w-4" /> Tambah
          </Button>
        </div>
      </div>

      {isLoading ? (
        <div className="text-center text-muted-foreground py-8 text-sm">
          <Loader2 className="h-4 w-4 animate-spin inline mr-2" /> Memuat…
        </div>
      ) : accounts.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            <Cloud className="h-6 w-6 mx-auto mb-2 opacity-40" />
            Belum ada akun cloud. Tambahkan MEGA atau S3 (Cloudflare R2 —
            gratis 10 GB, tidak pernah memblokir server).
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {accounts.map((a) => {
            const pct =
              a.spaceTotal && a.spaceTotal > 0
                ? Math.min(100, Math.round(((a.spaceUsed ?? 0) / a.spaceTotal) * 100))
                : 0;
            return (
              <Card key={a.id}>
                <CardHeader className="pb-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <CardTitle className="text-base flex items-center gap-1.5 truncate">
                        {a.name}
                      </CardTitle>
                      <Badge
                        variant="secondary"
                        className={cn(
                          "font-mono text-[10px] uppercase",
                          a.provider === "mega"
                            ? "bg-red-500/10 text-red-600 dark:text-red-400"
                            : "bg-amber-500/10 text-amber-600 dark:text-amber-400"
                        )}
                      >
                        {a.provider === "s3" ? "S3" : a.provider}
                      </Badge>
                      {a.provider === "mega" && a.hasSession ? (
                        <Badge
                          variant="secondary"
                          className="font-mono text-[10px] bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                          title="Session MEGA tersimpan — login password hanya sekali"
                        >
                          session-aktif
                        </Badge>
                      ) : null}
                    </div>
                    <StatusBadge status={a.lastStatus} />
                  </div>
                </CardHeader>
                <CardContent className="space-y-2.5 pt-0">
                  <div className="text-xs text-muted-foreground space-y-0.5">
                    {a.provider === "s3" ? (
                      <p className="truncate" title={a.endpoint ?? ""}>
                        {a.bucket ? (
                          <>
                            <span className="font-mono">{a.bucket}</span>
                            {a.region ? ` · ${a.region}` : ""}
                            {a.endpoint ? ` · ${a.endpoint}` : " (AWS S3)"}
                          </>
                        ) : (
                          <span className="italic">bucket belum diisi</span>
                        )}
                      </p>
                    ) : a.email ? (
                      <p>{a.email}</p>
                    ) : (
                      <p className="italic">email belum diisi</p>
                    )}
                  </div>
                  {/* Quota progress */}
                  <div className="space-y-1">
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-muted-foreground">Kapasitas</span>
                      <span className="font-medium">
                        {a.spaceUsed != null ? formatBytes(a.spaceUsed) : "—"} /{" "}
                        {a.spaceTotal != null ? formatBytes(a.spaceTotal) : "—"}
                      </span>
                    </div>
                    {a.spaceTotal ? (
                      <Progress value={pct} className="h-1.5" />
                    ) : (
                      <div className="h-1.5 rounded-full bg-muted" />
                    )}
                  </div>

                  {/* Hak akses mount (khusus MEGA) — siapa boleh membuka
                      explorer MEGA Cloud + mode baca/tulis */}
                  {a.provider === "mega" ? (
                    <div className="rounded-md border border-border bg-muted/30 px-3 py-2 space-y-1.5">
                      <p className="text-[11px] font-medium text-muted-foreground">
                        Hak Akses Mount (Explorer MEGA di halaman Cloud)
                      </p>
                      <div className="flex flex-wrap items-center gap-2">
                        <Select
                          value={a.mountVisibleTo ?? "GURU"}
                          onValueChange={(v) =>
                            mountAccessMut.mutate({
                              id: a.id,
                              mountVisibleTo: v as "ADMIN" | "GURU" | "ALL",
                            })
                          }
                          disabled={mountAccessMut.isPending}
                        >
                          <SelectTrigger size="sm" className="w-[190px] h-7 text-xs">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="ADMIN">Admin saja</SelectItem>
                            <SelectItem value="GURU">Guru &amp; Admin</SelectItem>
                            <SelectItem value="ALL">Semua user (siswa ikut)</SelectItem>
                          </SelectContent>
                        </Select>
                        <Select
                          value={a.mountMode ?? "WRITE"}
                          onValueChange={(v) =>
                            mountAccessMut.mutate({
                              id: a.id,
                              mountMode: v as "READ" | "WRITE",
                            })
                          }
                          disabled={mountAccessMut.isPending}
                        >
                          <SelectTrigger size="sm" className="w-[150px] h-7 text-xs">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="READ">Baca-saja</SelectItem>
                            <SelectItem value="WRITE">Baca &amp; tulis</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <p className="text-[10px] text-muted-foreground">
                        Bisa dibuka: {mountVisibleToLabel(a.mountVisibleTo)} ·
                        Hak: {mountModeLabel(a.mountMode)}
                      </p>
                    </div>
                  ) : null}
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                    <span>
                      File:{" "}
                      <span className="font-medium text-foreground">{a.fileCount}</span>
                    </span>
                    <span>
                      Diperiksa:{" "}
                      <span className="font-medium text-foreground">
                        {relativeTime(a.lastCheckedAt)}
                      </span>
                    </span>
                    {a.lastError ? (
                      <span className="text-red-600 dark:text-red-400 inline-flex items-center gap-1">
                        <AlertCircle className="h-3 w-3" />
                        <span className="truncate max-w-[14rem]">{a.lastError}</span>
                      </span>
                    ) : null}
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                    <div className="flex items-center gap-2">
                      <Switch
                        checked={a.active}
                        onCheckedChange={() => toggleActive.mutate(a)}
                      />
                      <span className="text-xs text-muted-foreground">
                        {a.active ? "Aktif" : "Nonaktif"}
                      </span>
                    </div>
                    <div className="flex items-center gap-1">
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 gap-1.5"
                        onClick={() => testMut.mutate(a.id)}
                        disabled={testingId === a.id}
                      >
                        {testingId === a.id ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Zap className="h-3.5 w-3.5" />
                        )}
                        Tes Akun
                      </Button>
                      {a.provider === "mega" ? (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 gap-1.5"
                          onClick={() => syncMut.mutate(a.id)}
                          disabled={syncingId === a.id || syncingAll || a.lastStatus === "error"}
                          title="Pindahkan file lokal ke akun MEGA ini"
                        >
                          {syncingId === a.id ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <RefreshCw className="h-3.5 w-3.5" />
                          )}
                          Sync
                        </Button>
                      ) : null}
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        onClick={() => setEditA(a)}
                        title="Edit"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-destructive hover:text-destructive"
                        onClick={() => setDeleteA(a)}
                        title="Hapus"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <CreateCloudAccountDialog open={createOpen} onOpenChange={setCreateOpen} />
      {editA ? (
        <EditCloudAccountDialog
          account={editA}
          open
          onOpenChange={(o) => !o && setEditA(null)}
        />
      ) : null}
      <AlertDialog
        open={!!deleteA}
        onOpenChange={(o) => !o && setDeleteA(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Hapus akun cloud?</AlertDialogTitle>
            <AlertDialogDescription>
              Menghapus <b>{deleteA?.name}</b>.
              {deleteA && deleteA.fileCount > 0 ? (
                <span className="block mt-2 text-red-600 dark:text-red-400">
                  Akun ini masih menyimpan {deleteA.fileCount} file. Pindahkan atau
                  hapus file tersebut terlebih dahulu.
                </span>
              ) : (
                <span className="block mt-2">
                  Tidak ada file tersisa di akun ini. Aman untuk dihapus.
                </span>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Batal</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={!!deleteA && deleteA.fileCount > 0}
              onClick={() => deleteA && deleteMut.mutate(deleteA.id)}
            >
              {deleteMut.isPending ? "Menghapus…" : "Hapus"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function CreateCloudAccountDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [provider, setProvider] = useState("mega");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [key, setKey] = useState("");
  // S3
  const [endpoint, setEndpoint] = useState("");
  const [region, setRegion] = useState("");
  const [bucket, setBucket] = useState("");
  const [accessKeyId, setAccessKeyId] = useState("");
  const [secretAccessKey, setSecretAccessKey] = useState("");
  const [testNow, setTestNow] = useState(true);

  const mut = useMutation({
    mutationFn: async () => {
      const body: Record<string, unknown> =
        provider === "s3"
          ? {
              name,
              provider,
              endpoint: endpoint || undefined,
              region: region || undefined,
              bucket: bucket || undefined,
              accessKeyId: accessKeyId || undefined,
              secretAccessKey: secretAccessKey || undefined,
              testNow,
            }
          : {
              name,
              provider,
              email: email || undefined,
              password: password || undefined,
              key: key || undefined,
              testNow,
            };
      const res = await fetch("/api/admin/cloud-accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error(e.error || `Gagal membuat (HTTP ${res.status})`);
      }
      return res.json();
    },
    onSuccess: () => {
      toast.success(testNow ? "Akun dibuat, sedang dites…" : "Akun dibuat. Klik Tes Akun untuk verifikasi.");
      qc.invalidateQueries({ queryKey: ["admin-cloud-accounts"] });
      setName(""); setProvider("mega"); setEmail(""); setPassword(""); setKey("");
      setEndpoint(""); setRegion(""); setBucket(""); setAccessKeyId(""); setSecretAccessKey("");
      setTestNow(true);
      onOpenChange(false);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Tambah Akun Cloud</DialogTitle>
          <DialogDescription>
            MEGA (login email/password) atau S3-compatible (Cloudflare R2,
            Backblaze B2, DO Spaces, Wasabi, MinIO) — dipakai untuk menyimpan
            file cloud Aula.
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
            <Label>Nama akun</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} required placeholder="cth: MEGA Pribadi / R2 Utama" />
          </div>
          <div className="space-y-1.5">
            <Label>Provider</Label>
            <Select value={provider} onValueChange={setProvider}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="mega">MEGA (email + password)</SelectItem>
                <SelectItem value="s3">S3-compatible (R2 / B2 / Spaces)</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Akun MEGA kena blokir/rate-limit? Pakai S3 — Cloudflare R2
              gratis 10 GB dan tidak pernah memblokir server.
            </p>
          </div>

          {provider === "mega" ? (
            <>
              <div className="space-y-1.5">
                <Label>Email MEGA</Label>
                <Input
                  type="text"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  placeholder="email@contoh.com"
                />
              </div>
              <div className="space-y-1.5">
                <Label>Password MEGA</Label>
                <Input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                />
                <p className="text-xs text-muted-foreground">
                  Disimpan plaintext di DB. Enkripsi di production (lihat DEPLOY.md).
                </p>
              </div>
              <div className="space-y-1.5">
                <Label>Master Key (opsional)</Label>
                <Input
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                  autoCapitalize="none"
                  spellCheck={false}
                  className="font-mono text-xs"
                  placeholder="biarkan kosong"
                />
              </div>
            </>
          ) : (
            <>
              <div className="space-y-1.5">
                <Label>Endpoint (kosongkan untuk AWS S3)</Label>
                <Input
                  value={endpoint}
                  onChange={(e) => setEndpoint(e.target.value)}
                  autoCapitalize="none"
                  spellCheck={false}
                  className="font-mono text-xs"
                  placeholder="https://<accountid>.r2.cloudflarestorage.com"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label>Region</Label>
                  <Input
                    value={region}
                    onChange={(e) => setRegion(e.target.value)}
                    autoCapitalize="none"
                    className="font-mono text-xs"
                    placeholder="auto"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>Bucket</Label>
                  <Input
                    value={bucket}
                    onChange={(e) => setBucket(e.target.value)}
                    autoCapitalize="none"
                    className="font-mono text-xs"
                    placeholder="aula-files"
                    required
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label>Access Key ID</Label>
                <Input
                  value={accessKeyId}
                  onChange={(e) => setAccessKeyId(e.target.value)}
                  autoCapitalize="none"
                  spellCheck={false}
                  className="font-mono text-xs"
                  placeholder="AKIA…"
                  required
                />
              </div>
              <div className="space-y-1.5">
                <Label>Secret Access Key</Label>
                <Input
                  type="password"
                  value={secretAccessKey}
                  onChange={(e) => setSecretAccessKey(e.target.value)}
                  className="font-mono text-xs"
                  placeholder="••••••••"
                  required
                />
              </div>
              <p className="text-xs text-muted-foreground">
                R2: buat bucket di dashboard Cloudflare → R2 → Manage API
                tokens → Object Read &amp; Write. Nilai “Access Key ID” dan
                “Secret Access Key”-nya diisi di sini.
              </p>
            </>
          )}

          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <Switch checked={testNow} onCheckedChange={setTestNow} />
            <span>Tes koneksi otomatis setelah dibuat</span>
          </label>
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

function EditCloudAccountDialog({
  account,
  open,
  onOpenChange,
}: {
  account: CloudAccount;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState(account.name);
  const [email, setEmail] = useState(account.email ?? "");
  const [password, setPassword] = useState("");
  const [key, setKey] = useState("");
  // S3
  const [endpoint, setEndpoint] = useState(account.endpoint ?? "");
  const [region, setRegion] = useState(account.region ?? "");
  const [bucket, setBucket] = useState(account.bucket ?? "");
  const [accessKeyId, setAccessKeyId] = useState("");
  const [secretAccessKey, setSecretAccessKey] = useState("");

  const mut = useMutation({
    mutationFn: async () => {
      const body: Record<string, unknown> = { name };
      if (account.provider === "s3") {
        body.endpoint = endpoint;
        body.region = region;
        body.bucket = bucket;
        if (accessKeyId.length > 0) body.accessKeyId = accessKeyId;
        if (secretAccessKey.length > 0) body.secretAccessKey = secretAccessKey;
      } else {
        body.email = email;
        if (password.length > 0) body.password = password;
        if (key.length > 0) body.key = key;
      }
      const res = await fetch(`/api/admin/cloud-accounts/${account.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error(e.error || "Gagal menyimpan");
      }
      return res.json();
    },
    onSuccess: () => {
      toast.success("Perubahan disimpan — tekan Tes Akun untuk verifikasi ulang");
      qc.invalidateQueries({ queryKey: ["admin-cloud-accounts"] });
      onOpenChange(false);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit Akun Cloud</DialogTitle>
          <DialogDescription>
            {account.provider === "s3" ? "Provider S3-compatible" : "Provider MEGA"}
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
            <Label>Nama</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} required />
          </div>

          {account.provider === "s3" ? (
            <>
              <div className="space-y-1.5">
                <Label>Endpoint</Label>
                <Input
                  value={endpoint}
                  onChange={(e) => setEndpoint(e.target.value)}
                  autoCapitalize="none"
                  spellCheck={false}
                  className="font-mono text-xs"
                  placeholder="https://<accountid>.r2.cloudflarestorage.com"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label>Region</Label>
                  <Input
                    value={region}
                    onChange={(e) => setRegion(e.target.value)}
                    autoCapitalize="none"
                    className="font-mono text-xs"
                    placeholder="auto"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>Bucket</Label>
                  <Input
                    value={bucket}
                    onChange={(e) => setBucket(e.target.value)}
                    autoCapitalize="none"
                    className="font-mono text-xs"
                    required
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label>Access Key ID baru (opsional)</Label>
                <Input
                  value={accessKeyId}
                  onChange={(e) => setAccessKeyId(e.target.value)}
                  autoCapitalize="none"
                  spellCheck={false}
                  className="font-mono text-xs"
                  placeholder="(tidak diubah)"
                />
              </div>
              <div className="space-y-1.5">
                <Label>Secret Access Key baru (opsional)</Label>
                <Input
                  type="password"
                  value={secretAccessKey}
                  onChange={(e) => setSecretAccessKey(e.target.value)}
                  className="font-mono text-xs"
                  placeholder="(tidak diubah)"
                />
              </div>
            </>
          ) : (
            <>
              <div className="space-y-1.5">
                <Label>Email</Label>
                <Input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoCapitalize="none"
                  spellCheck={false}
                />
              </div>
              <div className="space-y-1.5">
                <Label>Password baru (opsional)</Label>
                <Input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={account.hasPassword ? "•••••••• (tidak diubah)" : "belum diisi"}
                />
                <p className="text-xs text-muted-foreground">
                  Kosongkan jika tidak ingin mengubah password.
                </p>
              </div>
              <div className="space-y-1.5">
                <Label>Master Key (opsional)</Label>
                <Input
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                  autoCapitalize="none"
                  spellCheck={false}
                  className="font-mono text-xs"
                  placeholder={account.hasKey ? "(tidak diubah)" : "belum diisi"}
                />
              </div>
            </>
          )}

          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>File tersimpan: <b className="text-foreground">{account.fileCount}</b></span>
            <span>
              Dibuat:{" "}
              <b className="text-foreground">
                {format(new Date(account.createdAt), "dd MMM yyyy")}
              </b>
            </span>
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
