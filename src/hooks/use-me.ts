"use client";

import { useQuery } from "@tanstack/react-query";

export interface MeUser {
  id: string;
  username: string;
  name: string;
  role: "ADMIN" | "GURU" | "STUDENT";
  avatarColor: string;
  avatarUrl: string | null;
  bio: string | null;
  status: string;
  lastSeen: string;
}

export interface MeClassroom {
  id: string;
  name: string;
  description: string | null;
  memberRole: "TEACHER" | "STUDENT";
}

export interface MeGroup {
  id: string;
  name: string;
  description: string | null;
  isPrivate: boolean;
  classroomId: string | null;
}

export interface MeResponse {
  user: MeUser | null;
  classrooms: MeClassroom[];
  groups: MeGroup[];
  onlineUserIds: string[];
}

export function useMe() {
  return useQuery<MeResponse>({
    queryKey: ["me"],
    queryFn: async () => {
      const res = await fetch("/api/me", { cache: "no-store" });
      if (!res.ok) throw new Error("Failed to load user");
      return res.json();
    },
    refetchInterval: 20_000,
  });
}
