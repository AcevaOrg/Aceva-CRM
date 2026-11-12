"use client";
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import { toast } from "sonner";
import {
  Bell, CheckCheck, Keyboard, LogIn, LogOut, Monitor, Moon, Sun, UserRound, Users, Timer, CircleCheck,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Avatar } from "@/components/ui/misc";
import { Popover, PopoverContent, PopoverTrigger, Tip } from "@/components/ui/overlays";
import { SegmentedControl } from "@/components/ui/controls";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem,
  DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { LevelMark } from "@/components/shared/level-mark";
import { useMarkRead, useNotifications } from "@/features/system/hooks";
import { NOTIFICATION_GROUP, type Notification } from "@/features/system/types";
import { useNow } from "@/hooks/use-now";
import { API_MODE, isLive } from "@/lib/api/http";
import { ROLE_LABEL } from "@/lib/auth/permissions";
import { useSession } from "@/lib/auth/session";
import { useViewer } from "@/lib/auth/viewer";
import { formatRelative, formatTime } from "@/lib/dates";
import { minutesToHours } from "@/lib/format";
import { useUi } from "@/lib/ui-store";
import { cn } from "@/lib/utils";
import { EMPLOYEES } from "@/mocks/seed/people";

/* ---------------- Check-in pill ---------------- */

export function useTodayCheck() {
  const empId = useSession((s) => s.empId);
  const checks = useSession((s) => s.checks);
  return React.useMemo(() => {
    const c = empId ? checks[empId] : undefined;
    const today = new Date();
    const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    return c && c.date === iso ? c : undefined;
  }, [empId, checks]);
}

/** Work schedule from Settings (mock): 09:00 start, 15 min grace. */
export const WORK_START = { hour: 9, minute: 0, graceMin: 15, endHour: 18 };

export function CheckInPill() {
  const check = useTodayCheck();
  const checkIn = useSession((s) => s.checkIn);
  const checkOut = useSession((s) => s.checkOut);
  const now = useNow(30_000);

  if (!check?.in) {
    return (
      <Button
        size="sm"
        variant="signal"
        onClick={() => {
          checkIn();
          toast.success(`Checked in at ${formatTime(new Date())}`, { description: "Time comes from the server clock." });
        }}
      >
        <LogIn /> <span className="hidden sm:inline">Check in</span>
      </Button>
    );
  }
  const end = check.out ? new Date(check.out).getTime() : now;
  const elapsed = end ? Math.max(0, Math.round((end - new Date(check.in).getTime()) / 60_000)) : 0;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button className="inline-flex h-8 items-center gap-2 rounded-full border border-border bg-card px-3 text-[12.5px] font-medium shadow-strata transition hover:bg-muted">
          <span className={cn("size-2 rounded-full", check.out ? "bg-muted-foreground" : "bg-signal animate-pulse-signal")} aria-hidden />
          <span className="tabular">{check.out ? "Day ended" : minutesToHours(elapsed)}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Today</p>
        <dl className="mt-2 grid grid-cols-2 gap-y-1 text-[13px]">
          <dt className="text-muted-foreground">Checked in</dt>
          <dd className="text-right font-mono tabular">{formatTime(check.in)}</dd>
          <dt className="text-muted-foreground">Checked out</dt>
          <dd className="text-right font-mono tabular">{check.out ? formatTime(check.out) : "—"}</dd>
          <dt className="text-muted-foreground">Time at work</dt>
          <dd className="text-right font-mono tabular">{minutesToHours(elapsed)}</dd>
        </dl>
        {!check.out && (
          <Button
            className="mt-3 w-full"
            variant="outline"
            onClick={() => {
              checkOut();
              toast.success(`Checked out at ${formatTime(new Date())}`);
            }}
          >
            <LogOut /> Check out
          </Button>
        )}
        <Link href="/attendance" className="mt-2 block text-center text-[12.5px] text-primary hover:underline">
          My attendance
        </Link>
      </PopoverContent>
    </Popover>
  );
}

/* ---------------- Session ring ---------------- */

export function SessionRing({ secondsLeft, limitMin, isIdle }: { secondsLeft: number; limitMin: number; isIdle: boolean }) {
  const pct = Math.max(0, Math.min(1, secondsLeft / (limitMin * 60)));
  const size = 26;
  const r = 10;
  const c = 2 * Math.PI * r;
  const low = secondsLeft <= 120;
  return (
    <Tip
      content={
        <span className="grid gap-0.5">
          <span className="font-semibold">{isIdle ? "Idle" : "Active"} · signs out in {Math.ceil(secondsLeft / 60)} min</span>
          <span className="opacity-80">After {limitMin} minutes without activity{limitMin === 10 ? " on finance screens" : ""}. 12 hours maximum.</span>
        </span>
      }
    >
      <span tabIndex={0} className="relative hidden size-8 place-content-center rounded-full outline-none sm:grid" aria-label={`Session: ${Math.ceil(secondsLeft / 60)} minutes until automatic sign-out`}>
        <svg width={size} height={size} className="-rotate-90">
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--muted)" strokeWidth={3} />
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={low ? "var(--danger)" : isIdle ? "var(--warning)" : "var(--zone-control)"} strokeWidth={3} strokeDasharray={`${c * pct} ${c}`} strokeLinecap="round" />
        </svg>
        <Timer className="absolute left-1/2 top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 text-muted-foreground" />
      </span>
    </Tip>
  );
}

/* ---------------- Notifications ---------------- */

function NotificationRow({ n, onOpen }: { n: Notification; onOpen: () => void }) {
  return (
    <Link href={n.link ?? "/notifications"} onClick={onOpen} className={cn("flex gap-3 rounded-lg px-2.5 py-2 transition hover:bg-muted", !n.read && "bg-primary/5")}>
      <span className={cn("mt-1.5 size-2 shrink-0 rounded-full", n.read ? "bg-transparent" : "bg-primary")} aria-hidden />
      <span className="grid min-w-0 gap-0.5">
        <span className="text-[13px] font-medium leading-snug">{n.title}</span>
        {n.body && <span className="line-clamp-2 text-[12px] text-muted-foreground">{n.body}</span>}
        <span className="text-[11px] text-muted-foreground">{formatRelative(n.at)}</span>
      </span>
    </Link>
  );
}

export function NotificationsPopover() {
  const { data = [] } = useNotifications();
  const markRead = useMarkRead();
  const [tab, setTab] = React.useState<"all" | "approvals" | "mentions">("all");
  const [open, setOpen] = React.useState(false);
  const unread = data.filter((n) => !n.read).length;
  const list = data.filter((n) => tab === "all" || NOTIFICATION_GROUP[n.type] === tab).slice(0, 8);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button size="icon" variant="ghost" className="relative" aria-label={`Notifications, ${unread} unread`}>
          <Bell />
          {unread > 0 && (
            <span className="absolute right-1 top-1 grid h-4 min-w-4 place-content-center rounded-full bg-danger px-1 text-[9.5px] font-bold text-white tabular">{unread}</span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[min(92vw,380px)] p-0">
        <div className="flex items-center justify-between px-4 pb-2 pt-3">
          <p className="font-semibold">Notifications</p>
          <Button size="sm" variant="ghost" onClick={() => markRead.mutate(undefined)} disabled={!unread}>
            <CheckCheck /> Mark all read
          </Button>
        </div>
        <div className="px-4 pb-2">
          <SegmentedControl
            size="sm"
            value={tab}
            onChange={setTab}
            className="w-full"
            options={[
              { value: "all", label: "All" },
              { value: "approvals", label: "Approvals" },
              { value: "mentions", label: "Mentions" },
            ]}
          />
        </div>
        <div className="max-h-[60vh] overflow-y-auto px-1.5 pb-1.5 scrollbar-thin">
          {list.length ? (
            list.map((n) => <NotificationRow key={n.id} n={n} onOpen={() => { setOpen(false); if (!n.read) markRead.mutate([n.id]); }} />)
          ) : (
            <p className="flex items-center justify-center gap-2 py-10 text-[13px] text-muted-foreground">
              <CircleCheck className="size-4" /> You&apos;re all caught up
            </p>
          )}
        </div>
        <Link href="/notifications" onClick={() => setOpen(false)} className="block border-t border-border py-2.5 text-center text-[12.5px] font-medium text-primary hover:bg-muted">
          See all notifications
        </Link>
      </PopoverContent>
    </Popover>
  );
}

/* ---------------- User menu (theme, View as, sign out) ---------------- */

export function UserMenu() {
  const viewer = useViewer();
  const { theme, setTheme } = useTheme();
  const viewAs = useSession((s) => s.viewAs);
  const signOut = useSession((s) => s.signOut);
  const setShortcuts = useUi((s) => s.setShortcuts);
  const router = useRouter();
  if (!viewer) return null;
  const e = viewer.employee;
  return (
    <DropdownMenu>
      <Button variant="ghost" className="h-9 gap-2 rounded-full pl-1 pr-2" asChild>
        <DropdownMenuTrigger aria-label="Account menu">
          <Avatar name={e.name} hue={e.avatarHue} size={28} />
          <span className="hidden max-w-28 truncate text-[13px] font-medium md:inline">{e.name.split(" ")[0]}</span>
        </DropdownMenuTrigger>
      </Button>
      <DropdownMenuContent align="end" className="w-64">
        <div className="flex items-center gap-3 px-2 py-2">
          <Avatar name={e.name} hue={e.avatarHue} size={36} />
          <div className="min-w-0">
            <p className="truncate text-[13px] font-semibold">{e.name}</p>
            <p className="flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
              <LevelMark level={e.level} /> {e.designation} · <span className="font-mono">{e.empId}</span>
            </p>
          </div>
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => router.push("/account")}>
          <UserRound /> My account
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => setShortcuts(true)}>
          <Keyboard /> Keyboard shortcuts
        </DropdownMenuItem>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            {theme === "dark" ? <Moon /> : theme === "light" ? <Sun /> : <Monitor />} Theme
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="min-w-40">
            <DropdownMenuRadioGroup value={theme} onValueChange={setTheme}>
              <DropdownMenuRadioItem value="light"><Sun /> Light</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="dark"><Moon /> Dark</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="system"><Monitor /> System</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        {API_MODE === "mock" && !isLive("m2") && (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <Users /> View as… <span className="ml-auto text-[10px] font-semibold uppercase text-muted-foreground">Demo</span>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-72">
              <DropdownMenuLabel>Switch persona</DropdownMenuLabel>
              <DropdownMenuRadioGroup
                value={e.empId}
                onValueChange={(id) => {
                  viewAs(id);
                  const p = EMPLOYEES.find((x) => x.empId === id);
                  toast(`Now viewing as ${p?.name}`, { description: `${ROLE_LABEL[p!.role]} · Level ${p?.level}` });
                  router.push("/");
                }}
              >
                {EMPLOYEES.map((p) => (
                  <DropdownMenuRadioItem key={p.empId} value={p.empId}>
                    <span className="grid min-w-0 leading-tight">
                      <span className="truncate">{p.name}</span>
                      <span className="text-[11px] text-muted-foreground">
                        L{p.level} · {ROLE_LABEL[p.role]}
                        {p.duties.includes("finance") ? " · Finance duty" : ""}
                      </span>
                    </span>
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          destructive
          onSelect={() => {
            signOut();
            router.push("/login");
          }}
        >
          <LogOut /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
