import { getServerSession } from "next-auth";
import { authOptions, type AppSession } from "@/lib/auth";

export async function getSession(): Promise<AppSession | null> {
  const session = await getServerSession(authOptions);
  if (!session?.user) return null;
  return session as unknown as AppSession;
}

export async function requireUser(): Promise<AppSession["user"]> {
  const session = await getSession();
  if (!session?.user) throw new Error("UNAUTHORIZED");
  return session.user;
}

export async function requireAdmin(): Promise<AppSession["user"]> {
  const user = await requireUser();
  if (user.role !== "ADMIN") throw new Error("FORBIDDEN");
  return user;
}
