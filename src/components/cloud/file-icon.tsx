"use client";

import {
  File,
  FileArchive,
  FileAudio,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo,
  MonitorPlay,
  type LucideIcon,
} from "lucide-react";
import type { FileIconName } from "@/lib/cloud-format";

const MAP: Record<FileIconName, LucideIcon> = {
  FileText,
  FileImage,
  FileSpreadsheet,
  MonitorPlay,
  FileArchive,
  FileVideo,
  FileAudio,
  FileCode,
  File,
};

export function FileIcon({
  name,
  className,
}: {
  name: FileIconName;
  className?: string;
}) {
  const Comp = MAP[name] ?? File;
  return <Comp className={className} />;
}
