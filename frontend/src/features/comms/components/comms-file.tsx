"use client";
import * as React from "react";
import { toast } from "sonner";
import { Loader2, ShieldAlert } from "lucide-react";
import { FileCard } from "@/components/shared/timeline";
import { isLive } from "@/lib/api/http";
import { ApiError } from "@/lib/api/mock";
import { cn } from "@/lib/utils";
import { liveCommsApi } from "../live-api";
import type { CommsAttachment } from "../types";

const LIVE = isLive("m14");

/**
 * A shared file. Live: it opens through the API (access checked every time, audited) and only once ClamAV has passed it;
 * while it is being checked it says so, and a blocked file (malware found) can never be opened.
 */
export function CommsFile({ file, className }: { file: Pick<CommsAttachment, "id" | "fileName" | "sizeBytes" | "mimeType"> & { scan?: CommsAttachment["scan"]; discarded?: boolean }; className?: string }) {
  const [busy, setBusy] = React.useState(false);
  const scan = file.scan ?? "clean";
  const open = async () => {
    if (!LIVE) return void toast("Opening a private link (demo)", { description: "Links expire in minutes and every download is permission-checked." });
    if (file.discarded) return void toast("This file was never sent", { description: "Files that are not sent within a day are removed." });
    if (scan === "scanning") return void toast("This file is still being checked for viruses", { description: "It can be opened as soon as the check passes." });
    if (scan === "blocked") return void toast.error("This file was blocked", { description: "Malware was found in it, so it was removed and can never be opened." });
    setBusy(true);
    try {
      await liveCommsApi.downloadFile(file.id, file.fileName);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't open the file.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={cn("grid gap-0.5", className)} data-scan={scan}>
      <FileCard file={file} onOpen={open} className={cn(scan === "blocked" && "border-danger/40 opacity-70")} />
      {scan === "scanning" && (
        <span className="inline-flex items-center gap-1 px-1 text-[11.5px] text-muted-foreground">
          <Loader2 className="size-3 animate-spin" /> Checking for viruses…
        </span>
      )}
      {scan === "blocked" && (
        <span className="inline-flex items-center gap-1 px-1 text-[11.5px] font-medium text-danger">
          <ShieldAlert className="size-3" /> Blocked: malware found
        </span>
      )}
      {busy && <span className="px-1 text-[11.5px] text-muted-foreground">Opening…</span>}
    </div>
  );
}
