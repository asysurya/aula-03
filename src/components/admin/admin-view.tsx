"use client";

import { useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Users, School, Shield, Database, UsersRound, Bot, Hammer } from "lucide-react";
import { UsersPanel } from "@/components/admin/users-panel";
import { ClassroomsPanel } from "@/components/admin/classrooms-panel";
import { DataCloudPanel } from "@/components/admin/data-cloud-panel";
import { GroupsPanel } from "@/components/admin/groups-panel";
import { AiDefaultPanel } from "@/components/admin/ai-default-panel";

export function AdminView() {
  const [tab, setTab] = useState("users");
  return (
    <div className="h-full flex flex-col">
      <div className="border-b border-border px-4 md:px-6 py-4 flex items-center gap-2">
        <Shield className="h-5 w-5 text-primary" />
        <div>
          <h2 className="font-semibold text-lg leading-tight">Admin Panel</h2>
          <p className="text-xs text-muted-foreground">
            Kelola pengguna, kelas, dan keanggotaan.
          </p>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-4 md:px-6 py-4">
        <Tabs value={tab} onValueChange={setTab} className="w-full">
          <TabsList className="mb-4">
            <TabsTrigger value="users" className="gap-1.5">
              <Users className="h-4 w-4" /> Pengguna
            </TabsTrigger>
            <TabsTrigger value="classrooms" className="gap-1.5">
              <School className="h-4 w-4" /> Kelas
            </TabsTrigger>
            <TabsTrigger value="groups" className="gap-1.5">
              <UsersRound className="h-4 w-4" /> Grup
            </TabsTrigger>
            <TabsTrigger value="datacloud" className="gap-1.5">
              <Database className="h-4 w-4" /> Data & Cloud
            </TabsTrigger>
            <TabsTrigger value="temanai" className="gap-1.5">
              <Bot className="h-4 w-4" /> Teman AI
            </TabsTrigger>
            <TabsTrigger value="aibuilder" className="gap-1.5">
              <Hammer className="h-4 w-4" /> AI Builder
            </TabsTrigger>
          </TabsList>
          <TabsContent value="users" className="mt-0">
            <UsersPanel />
          </TabsContent>
          <TabsContent value="classrooms" className="mt-0">
            <ClassroomsPanel />
          </TabsContent>
          <TabsContent value="groups" className="mt-0">
            <GroupsPanel />
          </TabsContent>
          <TabsContent value="datacloud" className="mt-0">
            <DataCloudPanel />
          </TabsContent>
          <TabsContent value="temanai" className="mt-0">
            <AiDefaultPanel />
          </TabsContent>
          <TabsContent value="aibuilder" className="mt-0">
            <AiDefaultPanel variant="builder" />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
