"use client";

import { create } from "zustand";

export type Conversation =
  | { kind: "classroom"; id: string; name: string }
  | { kind: "group"; id: string; name: string }
  | { kind: "dm"; id: string; peerId: string; peerName: string };

export type Section = "chat" | "cloud" | "members" | "admin" | "profile";

interface UIState {
  section: Section;
  conversation: Conversation | null;

  cloudFolderId: string | null;
  cloudClassroomId: string | null;
  cloudDocId: string | null;

  membersClassroomId: string | null;

  sidebarOpen: boolean;

  setSection: (s: Section) => void;
  openConversation: (c: Conversation) => void;
  openCloudFolder: (folderId: string | null, classroomId?: string | null) => void;
  openCloudDoc: (docId: string) => void;
  openMembers: (classroomId?: string | null) => void;
  openProfile: () => void;
  openAdmin: () => void;
  toggleSidebar: () => void;
  setSidebarOpen: (open: boolean) => void;
}

export const useUIStore = create<UIState>((set) => ({
  section: "chat",
  conversation: null,
  cloudFolderId: null,
  cloudClassroomId: null,
  cloudDocId: null,
  membersClassroomId: null,
  sidebarOpen: false,

  setSection: (s) =>
    set(() => ({
      section: s,
      sidebarOpen: false,
      cloudDocId: null,
    })),

  openConversation: (c) =>
    set(() => ({
      section: "chat",
      conversation: c,
      cloudDocId: null,
      sidebarOpen: false,
    })),

  openCloudFolder: (folderId, classroomId = null) =>
    set(() => ({
      section: "cloud",
      cloudFolderId: folderId,
      cloudClassroomId: classroomId,
      cloudDocId: null,
      sidebarOpen: false,
    })),

  openCloudDoc: (docId) =>
    set(() => ({ section: "cloud", cloudDocId: docId, sidebarOpen: false })),

  openMembers: (classroomId = null) =>
    set(() => ({
      section: "members",
      membersClassroomId: classroomId,
      cloudDocId: null,
      sidebarOpen: false,
    })),

  openProfile: () =>
    set(() => ({ section: "profile", cloudDocId: null, sidebarOpen: false })),

  openAdmin: () =>
    set(() => ({ section: "admin", cloudDocId: null, sidebarOpen: false })),

  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  setSidebarOpen: (open) => set(() => ({ sidebarOpen: open })),
}));
