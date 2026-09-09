import type { NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";

export const authOptions: NextAuthOptions = {
  providers: [
    CredentialsProvider({
      name: "credentials",
      credentials: {
        username: { label: "Username", type: "text" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        if (!credentials?.username || !credentials?.password) return null;
        const username = credentials.username.trim().toLowerCase();
        const user = await db.user.findUnique({
          where: { username },
        });
        if (!user) return null;
        const ok = await bcrypt.compare(credentials.password, user.password);
        if (!ok) return null;
        return {
          id: user.id,
          name: user.name,
          email: user.username,
          role: user.role,
        } as any;
      },
    }),
  ],
  session: { strategy: "jwt", maxAge: 30 * 24 * 60 * 60 },
  // Percayai host dari request (Vercel) — membuat NEXTAUTH_URL opsional
  // dan mencegah error host-mismatch di serverless deployment.
  trustHost: true,
  pages: { signIn: "/" },
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.id = (user as any).id;
        token.role = (user as any).role;
        token.username = (user as any).email;
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        (session.user as any).id = token.id;
        (session.user as any).role = token.role;
        (session.user as any).username = token.username;
      }
      return session;
    },
  },
  // Fallback secret if env var missing (prevents JWT decryption errors).
  // In production, always set NEXTAUTH_SECRET env var to a strong random value.
  secret:
    process.env.NEXTAUTH_SECRET ||
    "aula-dev-fallback-secret-change-in-production-9f3a7c2e1b",
};

export type AppSession = {
  user: {
    id: string;
    name: string;
    username: string;
    role: "ADMIN" | "GURU" | "STUDENT";
  };
};
