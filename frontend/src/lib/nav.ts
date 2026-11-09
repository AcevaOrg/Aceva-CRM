/**
 * Navigation: the single source of truth (spec §4.2).
 * Items without the required permission are not rendered.
 */
import type { LucideIcon } from "lucide-react";
import {
  Activity, Bell, BookOpen, Building2, CalendarCheck, CalendarClock, CalendarDays, ChartColumn, CreditCard, Gauge,
  House, Inbox, Landmark, ListTodo, ListTree, Lock, Megaphone, MessagesSquare, Network, Plug, Receipt, Repeat,
  ScrollText, Settings, Sheet, SquareKanban, Sunrise, Target, UserRound, Users, Wallet, Contact, FileText, ChartLine,
} from "lucide-react";
import type { Zone } from "@/types";
import type { Permission } from "@/lib/auth/permissions";

export interface NavItem {
  label: string;
  href: string;
  icon: LucideIcon;
  zone: Zone;
  /** Visible if the viewer has ANY of these. */
  permission?: Permission | Permission[];
  /** Plan module number, for developers (not shown in the UI). */
  module: string;
  phase2?: boolean;
  /** Extra words for the command palette. */
  keywords?: string[];
  /** Match only this exact path (for section roots like /sales). */
  exact?: boolean;
  /** Other path prefixes that belong to this item (e.g. /sales/deals → Pipeline). */
  aliases?: string[];
}

export interface NavSection {
  zone: Zone;
  label: string | null;
  items: NavItem[];
}

export const ZONE_LABEL: Record<Zone, string> = {
  home: "Home",
  work: "People and work",
  finance: "Finance",
  sales: "Sales",
  control: "Control",
};

export const APPROVER_PERMISSIONS: Permission[] = [
  "leave.approve", "task.review", "finance.entry_approve", "payroll.review", "payroll.approve",
  "sales.team", "sales.commission_approve", "attendance.approve_correction", "finance.close",
];

export const NAV: NavSection[] = [
  {
    zone: "home",
    label: null,
    items: [
      { label: "Home", href: "/", icon: House, zone: "home", module: "M12", keywords: ["dashboard", "my day"] },
      { label: "Approvals", href: "/approvals", icon: Inbox, zone: "home", module: "cross", permission: APPROVER_PERMISSIONS, keywords: ["inbox", "approve", "review"] },
    ],
  },
  {
    zone: "work",
    label: "People and work",
    items: [
      { label: "Tasks", href: "/tasks", icon: ListTodo, zone: "work", module: "M5", permission: "task.view_own", keywords: ["todo", "assign", "board", "workload"] },
      { label: "Attendance", href: "/attendance", icon: CalendarCheck, zone: "work", module: "M7", permission: "attendance.self", keywords: ["check in", "check out", "late"] },
      { label: "Leave", href: "/leave", icon: CalendarDays, zone: "work", module: "M7", permission: "leave.request", keywords: ["holiday", "vacation", "time off"] },
      { label: "Performance", href: "/performance", icon: Gauge, zone: "work", module: "M6", permission: "performance.view_own", keywords: ["scorecard", "score", "review"] },
      { label: "People", href: "/people", icon: Users, zone: "work", module: "M3", permission: "people.view_directory", keywords: ["directory", "employee", "profile"] },
      { label: "Payroll", href: "/payroll", icon: Wallet, zone: "work", module: "M8", permission: ["payroll.view_own", "payroll.view"], keywords: ["salary", "payslip"] },
      { label: "Messages", href: "/messages", icon: MessagesSquare, zone: "work", module: "M14", permission: "comms.use", keywords: ["chat", "channel", "dm"] },
      { label: "Announcements", href: "/announcements", icon: Megaphone, zone: "work", module: "M14", permission: "comms.use" },
      { label: "Meetings", href: "/meetings", icon: CalendarClock, zone: "work", module: "M14", permission: "comms.use", keywords: ["agenda", "calendar"] },
    ],
  },
  {
    zone: "finance",
    label: "Finance",
    items: [
      { label: "Ledger", href: "/finance/ledger", icon: BookOpen, zone: "finance", module: "M9", permission: "finance.view", keywords: ["journal", "entry", "double entry"] },
      { label: "Accounts", href: "/finance/accounts", icon: ListTree, zone: "finance", module: "M9", permission: "finance.view", keywords: ["chart of accounts", "coa"] },
      { label: "Clients and vendors", href: "/finance/parties", icon: Building2, zone: "finance", module: "M9", permission: "finance.view" },
      { label: "Bills and expenses", href: "/finance/bills", icon: Receipt, zone: "finance", module: "M9", permission: "finance.view" },
      { label: "Banking", href: "/finance/banking", icon: Landmark, zone: "finance", module: "M9", permission: "finance.view", keywords: ["reconcile", "transfer", "bank"] },
      { label: "Month close", href: "/finance/close", icon: Lock, zone: "finance", module: "M9", permission: "finance.close" },
      { label: "Statements", href: "/finance/statements", icon: FileText, zone: "finance", module: "M10", permission: "statements.view", keywords: ["balance sheet", "income", "cash flow", "equity"] },
      { label: "Spreadsheet", href: "/finance/sheet", icon: Sheet, zone: "finance", module: "M11", permission: "sheet.view", keywords: ["grid", "excel"] },
      { label: "Insights", href: "/finance/insights", icon: ChartColumn, zone: "finance", module: "M11", permission: "insights.view", keywords: ["graphs", "charts"] },
      { label: "Billing", href: "/billing", icon: CreditCard, zone: "finance", module: "M13", permission: "billing.view", keywords: ["invoice", "payment", "customer"] },
      { label: "Subscriptions", href: "/billing/subscriptions", icon: Repeat, zone: "finance", module: "M13", permission: "subscriptions.view", keywords: ["renewal", "apollo", "domain"] },
    ],
  },
  {
    zone: "sales",
    label: "Sales",
    items: [
      { label: "My sales day", href: "/sales", icon: Sunrise, zone: "sales", module: "M15", permission: "sales.own", phase2: true, exact: true, keywords: ["targets", "follow up"] },
      { label: "Leads", href: "/sales/leads", icon: Contact, zone: "sales", module: "M15", permission: "sales.own", phase2: true, keywords: ["prospect", "crm"] },
      { label: "Pipeline", href: "/sales/pipeline", icon: SquareKanban, zone: "sales", module: "M15", permission: "sales.own", phase2: true, aliases: ["/sales/deals"], keywords: ["deals", "kanban"] },
      { label: "Sales reports", href: "/sales/reports", icon: ChartLine, zone: "sales", module: "M15", permission: "sales.own", phase2: true, keywords: ["daily report", "scorecard"] },
      { label: "Targets and commission", href: "/sales/targets", icon: Target, zone: "sales", module: "M15", permission: ["sales.targets", "sales.commission_view"], phase2: true },
    ],
  },
  {
    zone: "control",
    label: "Control",
    items: [
      { label: "Org and access", href: "/org", icon: Network, zone: "control", module: "M1", permission: "org.view", keywords: ["org chart", "roles", "permissions", "hierarchy"] },
      { label: "Activity", href: "/activity", icon: Activity, zone: "control", module: "M4", permission: "activity.view_own", keywords: ["tracking", "online", "timeline", "alerts"] },
      { label: "Audit log", href: "/audit", icon: ScrollText, zone: "control", module: "M12", permission: "audit.view" },
      { label: "Integrations", href: "/integrations", icon: Plug, zone: "control", module: "M16", permission: "integrations.view", phase2: true, keywords: ["apollo", "millionverifier", "mailbox", "sync"] },
      { label: "Settings", href: "/settings", icon: Settings, zone: "control", module: "M12", permission: "settings.view" },
    ],
  },
];

export const FOOTER_NAV: NavItem[] = [
  { label: "My account", href: "/account", icon: UserRound, zone: "control", module: "M2", keywords: ["password", "2fa", "devices"] },
  { label: "Notifications", href: "/notifications", icon: Bell, zone: "control", module: "M12" },
];

export const PHASE2_ENABLED = process.env.NEXT_PUBLIC_ENABLE_PHASE2 !== "false";

export function allNavItems() {
  return [...NAV.flatMap((s) => s.items), ...FOOTER_NAV];
}

/** Length of the longest prefix of `pathname` this item owns (0 = no match). */
function matchScore(item: NavItem, pathname: string) {
  if (item.href === "/" || item.exact) return pathname === item.href ? item.href.length : 0;
  return Math.max(0, ...[item.href, ...(item.aliases ?? [])].filter((h) => pathname === h || pathname.startsWith(h + "/")).map((h) => h.length));
}

/** Find the nav item (and so the zone) for a pathname: longest matching prefix wins. Used by sidebar and breadcrumb. */
export function matchNav(pathname: string): NavItem | undefined {
  let best: NavItem | undefined;
  let bestScore = 0;
  for (const item of allNavItems()) {
    const s = matchScore(item, pathname);
    if (s > bestScore) {
      best = item;
      bestScore = s;
    }
  }
  return best;
}
