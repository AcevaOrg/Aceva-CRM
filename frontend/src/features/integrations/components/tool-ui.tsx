"use client";
import { CircleCheck, CirclePause, CircleX, Plug } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { TOOL_META } from "../logic";
import type { ConnectionStatus, ToolId } from "../types";

/** Neutral lettered tile (no third-party logos in the app). */
export function ToolTile({ tool, size = 40 }: { tool: ToolId; size?: number }) {
  const m = TOOL_META[tool];
  return (
    <span
      aria-hidden
      className="grid shrink-0 place-content-center rounded-xl font-bold text-white shadow-[inset_0_1px_0_oklch(1_0_0/0.25)]"
      style={{ width: size, height: size, background: m.color, fontSize: size * 0.34 }}
    >
      {m.short}
    </span>
  );
}

export function ConnectionBadge({ status }: { status: ConnectionStatus }) {
  if (status === "working")
    return (
      <Badge tone="success">
        <CircleCheck /> Working
      </Badge>
    );
  if (status === "failing")
    return (
      <Badge tone="danger">
        <CircleX /> Failing
      </Badge>
    );
  if (status === "paused")
    return (
      <Badge tone="warning">
        <CirclePause /> Paused
      </Badge>
    );
  return (
    <Badge tone="outline">
      <Plug /> Not connected
    </Badge>
  );
}

export function KeyMask({ last4, className }: { last4?: string; className?: string }) {
  if (!last4) return <span className={cn("text-muted-foreground", className)}>No key saved</span>;
  return <span className={cn("font-mono tabular", className)}>••••{last4}</span>;
}
