import * as React from "react";
import { FileText, Paperclip } from "lucide-react";
import { formatBytes } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { Attachment } from "@/types";

export interface TimelineItem {
  id: string;
  icon?: React.ReactNode;
  /** CSS colour for the dot. */
  color?: string;
  title: React.ReactNode;
  meta?: React.ReactNode;
  body?: React.ReactNode;
  time?: React.ReactNode;
  muted?: boolean;
}

/** Vertical timeline (status history, activity, sales timeline). */
export function Timeline({ items, className }: { items: TimelineItem[]; className?: string }) {
  return (
    <ol className={cn("relative grid gap-0", className)}>
      {items.map((it, i) => (
        <li key={it.id} className="relative grid grid-cols-[28px_1fr] gap-3 pb-4 last:pb-0">
          {i < items.length - 1 && <span className="absolute left-[13.5px] top-7 bottom-0 w-px bg-border" aria-hidden />}
          <span
            className={cn(
              "relative z-[1] mt-0.5 grid size-7 place-content-center rounded-full border border-border bg-card text-muted-foreground [&_svg]:size-3.5",
              it.muted && "opacity-60",
            )}
            style={it.color ? { color: it.color, borderColor: `color-mix(in oklch, ${it.color} 35%, transparent)`, background: `color-mix(in oklch, ${it.color} 10%, var(--card))` } : undefined}
          >
            {it.icon ?? <span className="size-1.5 rounded-full bg-current" />}
          </span>
          <div className={cn("min-w-0 pt-0.5", it.muted && "opacity-70")}>
            <div className="flex flex-wrap items-baseline justify-between gap-x-3">
              <p className="text-[13px] font-medium">{it.title}</p>
              {it.time && <span className="text-[11.5px] text-muted-foreground tabular">{it.time}</span>}
            </div>
            {it.meta && <div className="text-[12px] text-muted-foreground">{it.meta}</div>}
            {it.body && <div className="mt-1.5 text-[13px]">{it.body}</div>}
          </div>
        </li>
      ))}
    </ol>
  );
}

export function FileCard({ file, onOpen, className }: { file: Pick<Attachment, "fileName" | "sizeBytes"> & { mimeType?: string }; onOpen?: () => void; className?: string }) {
  const ext = file.fileName.split(".").pop()?.toUpperCase() ?? "FILE";
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn("flex w-full min-w-0 items-center gap-3 rounded-lg border border-border bg-card px-3 py-2 text-left transition hover:bg-muted", className)}
    >
      <span className="grid size-9 shrink-0 place-content-center rounded-md bg-muted text-muted-foreground">
        {ext === "PDF" || ext === "DOCX" ? <FileText className="size-4" /> : <Paperclip className="size-4" />}
      </span>
      <span className="grid min-w-0">
        <span className="truncate text-[13px] font-medium">{file.fileName}</span>
        <span className="text-[11.5px] text-muted-foreground">
          {ext} · {formatBytes(file.sizeBytes)}
        </span>
      </span>
    </button>
  );
}
