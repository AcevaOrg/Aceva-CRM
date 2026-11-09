"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { PanelLeft } from "lucide-react";
import { Avatar } from "@/components/ui/misc";
import { Tip } from "@/components/ui/overlays";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { LevelMark } from "@/components/shared/level-mark";
import { useApprovalsCount } from "@/features/approvals/hooks";
import { useViewer, type Viewer } from "@/lib/auth/viewer";
import { FOOTER_NAV, matchNav, NAV, PHASE2_ENABLED, type NavItem } from "@/lib/nav";
import { useUi } from "@/lib/ui-store";
import { cn } from "@/lib/utils";
import { AcevaLogo } from "./logo";
import { ZONE_COLOR } from "./page-header";

function visible(item: NavItem, viewer: Viewer) {
  if (item.phase2 && !PHASE2_ENABLED) return false;
  return !item.permission || viewer.can(item.permission);
}

function isActive(pathname: string, href: string) {
  return matchNav(pathname)?.href === href;
}

function NavLink({ item, full, badge, onNavigate }: { item: NavItem; full: boolean; badge?: number; onNavigate?: () => void }) {
  const pathname = usePathname();
  const active = isActive(pathname, item.href);
  const Icon = item.icon;
  const link = (
    <Link
      href={item.href}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={cn(
        "group relative flex h-9 items-center gap-3 rounded-lg px-2.5 text-[13px] font-medium text-sidebar-foreground/85 transition-colors hover:bg-sidebar-accent hover:text-white",
        active && "bg-sidebar-accent text-white",
        !full && "justify-center px-0",
      )}
    >
      {active && <span className="absolute -left-3 top-1.5 bottom-1.5 w-[3px] rounded-r-full" style={{ background: ZONE_COLOR[item.zone] }} aria-hidden />}
      <Icon className="size-[18px] shrink-0 transition-colors" style={active ? { color: ZONE_COLOR[item.zone] } : undefined} aria-hidden />
      {full ? <span className="truncate">{item.label}</span> : <span className="sr-only">{item.label}</span>}
      {!!badge && (
        <span
          className={cn(
            "ml-auto grid h-5 min-w-5 place-content-center rounded-full bg-signal px-1.5 text-[10.5px] font-bold text-signal-foreground tabular",
            !full && "absolute -right-0.5 -top-0.5 h-4 min-w-4 px-1 text-[9px]",
          )}
        >
          {badge}
        </span>
      )}
    </Link>
  );
  return full ? link : <Tip content={item.label} side="right">{link}</Tip>;
}

function SidebarBody({ full, onNavigate }: { full: boolean; onNavigate?: () => void }) {
  const viewer = useViewer();
  const approvals = useApprovalsCount();
  const toggle = useUi((s) => s.toggleSidebar);
  if (!viewer) return null;
  const e = viewer.employee;

  return (
    <div className="flex h-full flex-col">
      <div className={cn("flex h-16 shrink-0 items-center px-4", full ? "justify-between" : "justify-center")}>
        <Link href="/" onClick={onNavigate} aria-label="Aceva home">
          <AcevaLogo collapsed={!full} />
        </Link>
        {full && !onNavigate && (
          <button onClick={toggle} className="hidden rounded-md p-1.5 text-sidebar-muted transition hover:bg-sidebar-accent hover:text-white xl:block" aria-label="Collapse sidebar">
            <PanelLeft className="size-4" />
          </button>
        )}
      </div>

      <nav className="flex-1 overflow-y-auto px-3 pb-4 scrollbar-thin" aria-label="Main">
        {NAV.map((section) => {
          const items = section.items.filter((i) => visible(i, viewer));
          if (!items.length) return null;
          return (
            <div key={section.zone} className="mt-3 first:mt-1">
              {section.label &&
                (full ? (
                  <p className="mb-1 mt-4 flex items-center gap-2 px-2.5 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-sidebar-muted">
                    <span className="size-1.5 rounded-full" style={{ background: ZONE_COLOR[section.zone] }} aria-hidden />
                    {section.label}
                  </p>
                ) : (
                  <div className="mx-auto my-3 h-px w-8 bg-sidebar-border" aria-hidden />
                ))}
              <ul className="grid gap-0.5">
                {items.map((item) => (
                  <li key={item.href}>
                    <NavLink item={item} full={full} onNavigate={onNavigate} badge={item.href === "/approvals" ? approvals : undefined} />
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </nav>

      <div className="shrink-0 border-t border-sidebar-border px-3 py-3">
        <ul className="mb-2 grid gap-0.5">
          {FOOTER_NAV.map((item) => (
            <li key={item.href}>
              <NavLink item={item} full={full} onNavigate={onNavigate} />
            </li>
          ))}
        </ul>
        <Link
          href="/account"
          onClick={onNavigate}
          className={cn("flex items-center gap-2.5 rounded-lg p-2 transition hover:bg-sidebar-accent", !full && "justify-center")}
        >
          <Avatar name={e.name} hue={e.avatarHue} size={32} />
          {full && (
            <span className="grid min-w-0 leading-tight">
              <span className="truncate text-[13px] font-medium text-white">{e.name}</span>
              <span className="flex items-center gap-1.5 text-[11px] text-sidebar-muted">
                <LevelMark level={e.level} />
                <span className="truncate">{e.designation}</span>
                <span className="font-mono">{e.empId}</span>
              </span>
            </span>
          )}
        </Link>
      </div>
    </div>
  );
}

export function Sidebar() {
  const collapsed = useUi((s) => s.sidebarCollapsed);
  const toggle = useUi((s) => s.toggleSidebar);
  return (
    <aside
      className={cn(
        "sticky top-0 hidden h-dvh shrink-0 bg-sidebar text-sidebar-foreground lg:block",
        collapsed ? "w-[72px]" : "w-[72px] xl:w-[264px]",
      )}
    >
      {/* Rail (lg) or full (xl) */}
      <div className={cn("h-full", !collapsed && "xl:hidden")}>
        <SidebarBody full={false} />
        {collapsed && (
          <button onClick={toggle} className="absolute bottom-24 left-1/2 hidden -translate-x-1/2 rounded-md p-1.5 text-sidebar-muted hover:bg-sidebar-accent hover:text-white xl:block" aria-label="Expand sidebar">
            <PanelLeft className="size-4 rotate-180" />
          </button>
        )}
      </div>
      {!collapsed && (
        <div className="hidden h-full xl:block">
          <SidebarBody full />
        </div>
      )}
    </aside>
  );
}

export function MobileSidebar() {
  const open = useUi((s) => s.mobileNavOpen);
  const setOpen = useUi((s) => s.setMobileNav);
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetContent side="left" size="sm" className="w-[280px] border-sidebar-border bg-sidebar text-sidebar-foreground" hideClose>
        <SheetTitle className="sr-only">Navigation</SheetTitle>
        <SidebarBody full onNavigate={() => setOpen(false)} />
      </SheetContent>
    </Sheet>
  );
}
