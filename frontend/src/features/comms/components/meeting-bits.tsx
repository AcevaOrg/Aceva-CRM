"use client";
import * as React from "react";
import { toast } from "sonner";
import { Check, CircleHelp, X } from "lucide-react";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { formatTime } from "@/lib/dates";
import { cn } from "@/lib/utils";
import { useRsvp } from "../hooks";
import type { Meeting, Rsvp } from "../types";

export const RSVP_LABEL: Record<Rsvp, { label: string; tone: BadgeTone }> = {
  yes: { label: "Going", tone: "success" },
  no: { label: "Not going", tone: "danger" },
  maybe: { label: "Maybe", tone: "warning" },
  pending: { label: "No reply", tone: "outline" },
};

export function timeRange(m: Pick<Meeting, "start" | "durationMin">) {
  const end = new Date(new Date(m.start).getTime() + m.durationMin * 60_000);
  return `${formatTime(m.start)}–${formatTime(end)}`;
}

export function isPast(m: Pick<Meeting, "start" | "durationMin">) {
  return new Date(m.start).getTime() + m.durationMin * 60_000 < Date.now();
}

export function RsvpBadge({ rsvp }: { rsvp: Rsvp }) {
  const r = RSVP_LABEL[rsvp];
  return <Badge tone={r.tone}>{r.label}</Badge>;
}

/** Going / Maybe / Not going buttons for the viewer. */
export function RsvpControl({ meetingId, value, size = "md" }: { meetingId: string; value: Rsvp; size?: "sm" | "md" }) {
  const rsvp = useRsvp();
  const opts: { v: Rsvp; label: string; icon: React.ReactNode; on: string }[] = [
    { v: "yes", label: "Going", icon: <Check />, on: "border-success/50 bg-success/14" },
    { v: "maybe", label: "Maybe", icon: <CircleHelp />, on: "border-warning/50 bg-warning/16" },
    { v: "no", label: "No", icon: <X />, on: "border-danger/40 bg-danger/12" },
  ];
  return (
    <div role="radiogroup" aria-label="Your reply" className="inline-flex gap-1" onClick={(e) => e.stopPropagation()}>
      {opts.map((o) => (
        <button
          key={o.v}
          type="button"
          role="radio"
          aria-checked={value === o.v}
          disabled={rsvp.isPending}
          onClick={(e) => {
            e.preventDefault();
            rsvp.mutateAsync({ id: meetingId, rsvp: o.v }).then(() => toast.success(`Replied: ${RSVP_LABEL[o.v].label.toLowerCase()}`));
          }}
          className={cn(
            "inline-flex items-center gap-1 rounded-full border border-border bg-card font-medium text-muted-foreground transition hover:text-foreground [&_svg]:size-3.5",
            size === "sm" ? "h-7 px-2.5 text-[12px]" : "h-8 px-3 text-[12.5px]",
            value === o.v && `text-foreground ${o.on}`,
          )}
        >
          {o.icon} {o.label}
        </button>
      ))}
    </div>
  );
}
