"use client";
/**
 * Home dashboards by level (plan §17, spec §9.12).
 * Each persona gets the widgets for their day; module widgets come from each module's hooks.
 */
import { PartyPopper } from "lucide-react";
import { useNow } from "@/hooks/use-now";
import { PageHeader } from "@/components/layout/page-header";
import { LevelMark } from "@/components/shared/level-mark";
import { useViewer, type Viewer } from "@/lib/auth/viewer";
import { formatWeekdayLong, greeting, isoDay } from "@/lib/dates";
import { HOLIDAYS } from "@/mocks/seed/calendar";
import { HomeLayout } from "./home-layouts";

/** One home layout per role in the structure: CEO / Founder / Owner, Director, CTO, Sales, Finance, Development. */
export type HomeVariant = "executive" | "director" | "cto" | "sales" | "finance" | "employee";

export function homeVariant(v: Viewer): HomeVariant {
  switch (v.employee.role) {
    case "ceo":
      return "executive";
    case "director":
      return "director";
    case "cto":
      return "cto";
    case "sales":
      return "sales";
    case "finance":
      return "finance";
    default:
      return "employee";
  }
}

const SUBTITLE: Record<HomeVariant, string> = {
  executive: "The whole company at a glance. You see every activity; the Director approves.",
  director: "Everything waiting for your approval, plus finance, payroll and the sales team.",
  cto: "Development today: who's in, workload, reviews and security alerts.",
  sales: "Your sales day: targets, follow-ups and new replies.",
  finance: "Entries to finish, payroll to prepare, bills and invoices. The Director approves what you prepare.",
  employee: "Your tasks, attendance and leave for today.",
};

export function HomeScreen() {
  const viewer = useViewer();
  const nowMs = useNow(60_000);
  const now = nowMs ? new Date(nowMs) : null;
  if (!viewer) return null;
  const variant = homeVariant(viewer);
  const holiday = now ? HOLIDAYS.find((h) => h.date === isoDay(now)) : undefined;
  const e = viewer.employee;

  return (
    <>
      <PageHeader
        eyebrow={now ? formatWeekdayLong(now) : "Today"}
        title={`${now ? greeting(now) : "Hello"}, ${e.name.split(" ")[0]}`}
        description={SUBTITLE[variant]}
        meta={
          <>
            <span className="inline-flex items-center gap-1.5 text-[12.5px] text-muted-foreground">
              <LevelMark level={e.level} /> {e.designation} · <span className="font-mono">{e.empId}</span>
            </span>
            {holiday && (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-signal/60 bg-signal/30 px-2.5 py-0.5 text-[12px] font-medium text-signal-foreground">
                <PartyPopper className="size-3.5" /> Today is {holiday.name}, a public holiday
              </span>
            )}
          </>
        }
      />
      <HomeLayout variant={variant} />
    </>
  );
}
