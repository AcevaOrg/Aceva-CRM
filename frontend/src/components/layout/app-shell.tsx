"use client";
/**
 * The signed-in frame: ink spine + topbar + page (spec §4.1).
 * Also hosts the command palette, promise dialogs, idle warning and shortcuts sheet.
 */
import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/misc";
import { DialogsHost } from "@/components/shared/dialogs";
import { useHotkeys } from "@/hooks/use-hotkeys";
import { useHydrated } from "@/hooks/use-hydrated";
import { useSessionTimers } from "@/hooks/use-session-timers";
import { useDirectory } from "@/hooks/use-directory";
import { API_MODE, isLive } from "@/lib/api/http";
import { authApi } from "@/features/auth/api";
import { useSession } from "@/lib/auth/session";
import { useUi } from "@/lib/ui-store";
import { EMPLOYEES } from "@/mocks/seed/people";
import { AcevaMark } from "./logo";
import { CommandPalette } from "./command-palette";
import { MobileSidebar, Sidebar } from "./sidebar";
import { Topbar } from "./topbar";

const SHORTCUTS: [string[], string][] = [
  [["Ctrl", "K"], "Open the command palette"],
  [["g", "h"], "Go to Home"],
  [["g", "t"], "Go to Tasks"],
  [["g", "a"], "Go to Approvals"],
  [["g", "m"], "Go to Messages"],
  [["g", "l"], "Go to Leave"],
  [["?"], "Show this list"],
  [["Esc"], "Close any dialog or sheet"],
];

function ShortcutsDialog() {
  const open = useUi((s) => s.shortcutsOpen);
  const setOpen = useUi((s) => s.setShortcuts);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>Every action is also a visible button.</DialogDescription>
        </DialogHeader>
        <ul className="grid gap-2">
          {SHORTCUTS.map(([keys, label]) => (
            <li key={label} className="flex items-center justify-between text-[13px]">
              {label}
              <span className="flex gap-1">
                {keys.map((k) => (
                  <Kbd key={k}>{k}</Kbd>
                ))}
              </span>
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}

function IdleDialog({ secondsLeft, onStay }: { secondsLeft: number; onStay: () => void }) {
  const signOut = useSession((s) => s.signOut);
  return (
    <Dialog open onOpenChange={(o) => !o && onStay()}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Still there?</DialogTitle>
          <DialogDescription>
            You&apos;ll be signed out in <span className="font-mono font-semibold text-foreground tabular">0:{String(secondsLeft).padStart(2, "0")}</span> because there
            was no activity. This keeps company data safe on shared or unattended computers.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={signOut}>
            Sign out
          </Button>
          <Button onClick={onStay}>Stay signed in</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const hydrated = useHydrated();
  const stage = useSession((s) => s.stage);
  const router = useRouter();
  const setPalette = useUi((s) => s.setPalette);
  const setShortcuts = useUi((s) => s.setShortcuts);
  const timers = useSessionTimers();
  useDirectory(); // warm the directory cache for EmpChips

  const viewAs = useSession((s) => s.viewAs);
  React.useEffect(() => {
    if (!hydrated) return;
    // Mock mode only: ?as=ACV-0007 opens the page as that persona (demos, screenshots).
    const as = API_MODE === "mock" && !isLive("m2") ? new URLSearchParams(window.location.search).get("as") : null;
    if (as && EMPLOYEES.some((e) => e.empId === as)) {
      if (useSession.getState().empId !== as) viewAs(as);
      return;
    }
    if (stage !== "signed_in") router.replace("/login");
  }, [hydrated, stage, router, viewAs]);

  // Live login: ask the server who this really is (the cookie, not this screen's memory, is the truth).
  const applyServerStage = useSession((s) => s.applyServerStage);
  const signOutLocal = useSession((s) => s.signOutLocal);
  React.useEffect(() => {
    if (!hydrated || !isLive("m2") || stage !== "signed_in") return;
    authApi
      .me()
      .then((me) => {
        if (me.stage !== "ok") {
          applyServerStage(me.empId, me.stage);
          router.replace(me.stage === "password_change_required" ? "/first-login" : me.stage === "2fa_required" ? "/login/verify" : "/login/setup");
        } else if (useSession.getState().empId !== me.empId) {
          applyServerStage(me.empId, "ok");
        }
      })
      .catch(() => {
        signOutLocal();
        router.replace("/login?expired=1");
      });
  }, [hydrated, stage, router, applyServerStage, signOutLocal]);

  useHotkeys({
    "mod+k": () => setPalette(true),
    "?": () => setShortcuts(true),
    "g h": () => router.push("/"),
    "g t": () => router.push("/tasks"),
    "g a": () => router.push("/approvals"),
    "g m": () => router.push("/messages"),
    "g l": () => router.push("/leave"),
  });

  if (!hydrated || stage !== "signed_in") {
    return (
      <div className="grid min-h-dvh place-content-center">
        <AcevaMark size={40} className="animate-pulse" />
      </div>
    );
  }

  return (
    <div className="flex min-h-dvh">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[100] focus:rounded-lg focus:bg-card focus:px-3 focus:py-2 focus:shadow-float">
        Skip to content
      </a>
      <Sidebar />
      <MobileSidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar session={timers} />
        <main id="main" className="flex-1 px-4 pb-16 sm:px-6 lg:px-8">
          <React.Suspense fallback={null}>{children}</React.Suspense>
        </main>
      </div>
      <CommandPalette />
      <DialogsHost />
      <ShortcutsDialog />
      {timers.warn && <IdleDialog secondsLeft={timers.secondsLeft} onStay={timers.stay} />}
    </div>
  );
}
