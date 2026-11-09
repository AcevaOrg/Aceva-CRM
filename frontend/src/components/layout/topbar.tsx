"use client";
import { usePathname } from "next/navigation";
import { ChevronRight, Menu, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/misc";
import { matchNav, ZONE_LABEL } from "@/lib/nav";
import { useUi } from "@/lib/ui-store";
import { CheckInPill, NotificationsPopover, SessionRing, UserMenu } from "./topbar-widgets";
import { ZONE_COLOR } from "./page-header";

export function Topbar({ session }: { session: { secondsLeft: number; limitMin: number; isIdle: boolean } }) {
  const pathname = usePathname();
  const nav = matchNav(pathname);
  const setPalette = useUi((s) => s.setPalette);
  const setMobileNav = useUi((s) => s.setMobileNav);

  return (
    <header className="sticky top-0 z-30 flex h-16 items-center gap-2 border-b border-border bg-background/85 px-4 backdrop-blur-md sm:px-6 lg:px-8">
      <Button size="icon" variant="ghost" className="lg:hidden" onClick={() => setMobileNav(true)} aria-label="Open navigation">
        <Menu />
      </Button>

      <nav aria-label="Breadcrumb" className="hidden min-w-0 items-center gap-1.5 text-[13px] md:flex">
        {nav && nav.zone !== "home" && (
          <>
            <span className="flex items-center gap-1.5 text-muted-foreground">
              <span className="size-1.5 rounded-full" style={{ background: ZONE_COLOR[nav.zone] }} />
              {ZONE_LABEL[nav.zone]}
            </span>
            <ChevronRight className="size-3.5 text-muted-foreground/60" />
          </>
        )}
        <span className="truncate font-medium">{nav?.label ?? "Aceva"}</span>
      </nav>

      <button
        onClick={() => setPalette(true)}
        className="mx-auto flex h-9 w-full max-w-md items-center gap-2 rounded-lg border border-border bg-card px-3 text-[13px] text-muted-foreground shadow-strata transition hover:border-input hover:text-foreground md:mx-4"
      >
        <Search className="size-4" />
        <span className="flex-1 truncate text-left">Search or jump to…</span>
        <span className="hidden items-center gap-0.5 sm:flex">
          <Kbd>Ctrl</Kbd>
          <Kbd>K</Kbd>
        </span>
      </button>

      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        <CheckInPill />
        <SessionRing {...session} />
        <NotificationsPopover />
        <UserMenu />
      </div>
    </header>
  );
}
