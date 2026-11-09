"use client";
import * as React from "react";
import { Hash, Users } from "lucide-react";
import { Avatar } from "@/components/ui/misc";
import { useLookup } from "@/hooks/use-directory";
import { useViewer } from "@/lib/auth/viewer";
import { cn } from "@/lib/utils";
import { usePresence } from "../hooks";
import type { Conversation, PresenceState } from "../types";

export function useMediaQuery(query: string) {
  const [match, setMatch] = React.useState(false);
  React.useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setMatch(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [query]);
  return match;
}

/** Display name for any conversation: "#engineering", a group name, or the other person in a DM. */
export function useConversationTitle() {
  const lookup = useLookup();
  const viewer = useViewer();
  return React.useCallback(
    (c: Pick<Conversation, "kind" | "name" | "memberEmpIds">) => {
      if (c.kind === "channel") return `#${c.name}`;
      if (c.kind === "group") return c.name ?? "Group";
      const other = c.memberEmpIds.find((p) => p !== viewer?.employee.empId);
      return lookup.employee(other)?.name ?? other ?? "Direct message";
    },
    [lookup, viewer],
  );
}

export function dmOther(c: Pick<Conversation, "kind" | "memberEmpIds">, me?: string) {
  return c.kind === "dm" ? c.memberEmpIds.find((p) => p !== me) : undefined;
}

const DOT: Record<PresenceState, string> = { online: "bg-success", away: "bg-warning", offline: "bg-muted-foreground/50" };
const DOT_LABEL: Record<PresenceState, string> = { online: "Online", away: "Away", offline: "Offline" };

export function PresenceDot({ state, className }: { state?: PresenceState; className?: string }) {
  if (!state) return null;
  return <span title={DOT_LABEL[state]} aria-label={DOT_LABEL[state]} className={cn("block size-2.5 rounded-full ring-2 ring-card", DOT[state], className)} />;
}

export function usePresenceOf() {
  const { data } = usePresence();
  return React.useCallback((empId?: string) => data?.find((p) => p.empId === empId), [data]);
}

/** Avatar for a conversation: person (DM), # tile (channel) or people tile (group). */
export function ConversationAvatar({ c, size = 32 }: { c: Pick<Conversation, "kind" | "name" | "memberEmpIds">; size?: number }) {
  const lookup = useLookup();
  const viewer = useViewer();
  const presenceOf = usePresenceOf();
  if (c.kind === "dm") {
    const other = lookup.employee(dmOther(c, viewer?.employee.empId));
    const p = presenceOf(other?.empId);
    const disabled = other?.status === "left";
    return (
      <span className="relative shrink-0">
        <Avatar name={other?.name ?? "?"} hue={other?.avatarHue} size={size} className={cn(disabled && "grayscale opacity-60")} />
        {!disabled && <PresenceDot state={p?.state} className="absolute -bottom-0.5 -right-0.5" />}
      </span>
    );
  }
  return (
    <span
      className={cn("grid shrink-0 place-content-center rounded-lg text-muted-foreground", c.kind === "channel" ? "bg-zone-work/14" : "bg-muted")}
      style={{ width: size, height: size }}
      aria-hidden
    >
      {c.kind === "channel" ? <Hash className="size-4 text-zone-work" /> : <Users className="size-4" />}
    </span>
  );
}
