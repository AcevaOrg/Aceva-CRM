"use client";
/**
 * Command palette, Ctrl K / ⌘K (spec §4.3): Go to · Do · Find.
 */
import * as React from "react";
import { useRouter } from "next/navigation";
import { Command } from "cmdk";
import { Dialog as DialogPrimitive } from "radix-ui";
import { toast } from "sonner";
import {
  BookOpen, CalendarDays, CreditCard, LogIn, LogOut, MessageSquarePlus, NotebookPen, Plus, Search, UserPlus, UserRound,
} from "lucide-react";
import { Avatar, Kbd } from "@/components/ui/misc";
import { useLookup } from "@/hooks/use-directory";
import { useLiveCheck } from "@/features/attendance/today";
import { isLive } from "@/lib/api/http";
import type { Permission } from "@/lib/auth/permissions";
import { useSession } from "@/lib/auth/session";
import { useViewer } from "@/lib/auth/viewer";
import { formatTime } from "@/lib/dates";
import { allNavItems, PHASE2_ENABLED } from "@/lib/nav";
import { useUi } from "@/lib/ui-store";
import { ZONE_COLOR } from "./page-header";
import { useTodayCheck } from "./topbar-widgets";

interface Action {
  label: string;
  icon: React.ElementType;
  permission?: Permission;
  run: () => void;
  keywords?: string;
}

const itemCls =
  "flex h-10 cursor-default select-none items-center gap-3 rounded-lg px-3 text-[13.5px] outline-none data-[selected=true]:bg-muted [&_svg]:size-4 [&_svg]:text-muted-foreground";
const groupCls =
  "[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-3 [&_[cmdk-group-heading]]:text-[10.5px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[0.12em] [&_[cmdk-group-heading]]:text-muted-foreground";

export function CommandPalette() {
  const open = useUi((s) => s.paletteOpen);
  const setOpen = useUi((s) => s.setPalette);
  const router = useRouter();
  const viewer = useViewer();
  const lookup = useLookup();
  const mockCheckIn = useSession((s) => s.checkIn);
  const mockCheckOut = useSession((s) => s.checkOut);
  // Live (m7): today's state and the time both come from the server; mock mode keeps the browser-only demo.
  const check = useTodayCheck();
  const liveCheck = useLiveCheck();

  if (!viewer) return null;

  const go = (href: string) => {
    setOpen(false);
    router.push(href);
  };

  const runCheck = (kind: "in" | "out") => {
    setOpen(false);
    if (!isLive("m7")) {
      (kind === "in" ? mockCheckIn : mockCheckOut)();
      toast.success(`Checked ${kind} at ${formatTime(new Date())}`);
      return;
    }
    (kind === "in" ? liveCheck.checkIn : liveCheck.checkOut)
      .mutateAsync()
      .then((res) => {
        const at = kind === "in" ? res.checkIn : res.checkOut;
        toast.success(`Checked ${kind} at ${at ? formatTime(at) : "the server time"}`, {
          description: kind === "in" && res.lateMinutes ? `${res.lateMinutes} min after the grace period. It is marked late.` : "Time comes from the server clock.",
        });
      })
      .catch((e: unknown) => toast.error((e as Error).message));
  };
  const candidates: (Action | null)[] = [
    !check?.in
      ? { label: "Check in", icon: LogIn, run: () => runCheck("in"), keywords: "attendance start day" }
      : !check.out
        ? { label: "Check out", icon: LogOut, run: () => runCheck("out"), keywords: "attendance end day" }
        : null,
    { label: "Assign a task", icon: Plus, permission: "task.assign", run: () => go("/tasks?assign=1"), keywords: "new task" },
    { label: "Request leave", icon: CalendarDays, permission: "leave.request", run: () => go("/leave?request=1"), keywords: "holiday time off" },
    { label: "New journal entry", icon: BookOpen, permission: "finance.entry_create", run: () => go("/finance/ledger/new"), keywords: "ledger double entry" },
    { label: "New invoice", icon: CreditCard, permission: "billing.manage", run: () => go("/billing/invoices/new"), keywords: "bill customer" },
    { label: "Add an employee", icon: UserPlus, permission: "people.manage", run: () => go("/people/new"), keywords: "onboarding hire" },
    PHASE2_ENABLED ? { label: "Add a lead", icon: UserRound, permission: "sales.own", run: () => go("/sales/leads?add=1"), keywords: "prospect crm" } : null,
    PHASE2_ENABLED ? { label: "Log my sales day", icon: NotebookPen, permission: "sales.own", run: () => go("/sales?log=1"), keywords: "manual daily log" } : null,
    { label: "New message", icon: MessageSquarePlus, permission: "comms.use", run: () => go("/messages?new=1"), keywords: "chat dm" },
  ];
  const actions = candidates.filter((a): a is Action => !!a && (!a.permission || viewer.can(a.permission)));

  const pages = allNavItems().filter((i) => (!i.phase2 || PHASE2_ENABLED) && (!i.permission || viewer.can(i.permission)));

  return (
    <Command.Dialog
      open={open}
      onOpenChange={setOpen}
      label="Command palette"
      overlayClassName="fixed inset-0 z-50 bg-[oklch(0.15_0.02_265/0.45)] backdrop-blur-[2px]"
      contentClassName="fixed left-1/2 top-[12vh] z-50 w-[calc(100%-2rem)] max-w-xl -translate-x-1/2 overflow-hidden rounded-2xl border border-border bg-popover text-popover-foreground shadow-float"
    >
      <DialogPrimitive.Title className="sr-only">Command palette</DialogPrimitive.Title>
      <div className="flex items-center gap-2 border-b border-border px-4">
        <Search className="size-4 text-muted-foreground" />
        <Command.Input placeholder="Search pages, actions or people…" className="h-12 flex-1 bg-transparent text-[14px] outline-none placeholder:text-muted-foreground" />
        <Kbd>Esc</Kbd>
      </div>
      <Command.List className="max-h-[60vh] overflow-y-auto p-2 scrollbar-thin">
        <Command.Empty className="py-10 text-center text-[13px] text-muted-foreground">No results.</Command.Empty>
        <Command.Group heading="Do" className={groupCls}>
          {actions.map((a) => (
            <Command.Item key={a.label} value={`${a.label} ${a.keywords ?? ""}`} onSelect={a.run} className={itemCls}>
              <a.icon /> {a.label}
            </Command.Item>
          ))}
        </Command.Group>
        <Command.Group heading="Go to" className={groupCls}>
          {pages.map((p) => (
            <Command.Item key={p.href} value={`${p.label} ${(p.keywords ?? []).join(" ")}`} onSelect={() => go(p.href)} className={itemCls}>
              <p.icon style={{ color: ZONE_COLOR[p.zone] }} /> {p.label}
            </Command.Item>
          ))}
        </Command.Group>
        <Command.Group heading="People" className={groupCls}>
          {lookup.employees
            .filter((e) => e.status !== "left")
            .map((e) => (
              <Command.Item key={e.empId} value={`${e.name} ${e.empId} ${e.designation}`} onSelect={() => go(`/people/${e.empId}`)} className={itemCls}>
                <Avatar name={e.name} hue={e.avatarHue} size={22} />
                <span className="flex-1 truncate">{e.name}</span>
                <span className="font-mono text-[11.5px] text-muted-foreground">{e.empId}</span>
              </Command.Item>
            ))}
        </Command.Group>
      </Command.List>
      <div className="flex items-center gap-3 border-t border-border px-4 py-2 text-[11.5px] text-muted-foreground">
        <span className="flex items-center gap-1"><Kbd>↑</Kbd><Kbd>↓</Kbd> move</span>
        <span className="flex items-center gap-1"><Kbd>↵</Kbd> open</span>
        <span className="ml-auto flex items-center gap-1"><Kbd>?</Kbd> all shortcuts</span>
      </div>
    </Command.Dialog>
  );
}
