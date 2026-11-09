"use client";
/**
 * Home dashboards by level (plan §17, spec §9.12).
 * Each persona gets the widgets for their day; module widgets come from each module's hooks.
 */
import { PartyPopper } from "lucide-react";
import { useNow } from "@/hooks/use-now";
import { PageHeader } from "@/components/layout/page-header";
import { LevelMark } from "@/components/shared/level-mark";
import { ROLE_LABEL } from "@/lib/auth/permissions";
import { useViewer, type Viewer } from "@/lib/auth/viewer";
import { formatWeekdayLong, greeting, isoDay } from "@/lib/dates";
import { HOLIDAYS } from "@/mocks/seed/calendar";
import { HomeLayout } from "./home-layouts";

export type HomeVariant = "employee" | "sales" | "finance" | "lead" | "sales_lead" | "director" | "cto" | "executive";

export function homeVariant(v: Viewer): HomeVariant {
  const e = v.employee;
  if (e.level <= 2) return "executive";
  if (e.role === "cto") return "cto";
  if (e.level === 3) return "director";
  if (e.role === "sales_lead") return "sales_lead";
  if (e.level === 4) return "lead";
  if (v.isSales) return "sales";
  if (v.hasFinanceDuty) return "finance";
  return "employee";
}

const SUBTITLE: Record<HomeVariant, string> = {
  employee: "Your tasks, attendance and leave for today.",
  sales: "Your sales day: targets, follow-ups and new replies.",
  finance: "Entries to finish, bills due and where payroll stands.",
  lead: "Your team today: workload, reviews and requests.",
  sales_lead: "Your sales team today, plus approvals waiting for you.",
  director: "Your department, approvals waiting and the finance summary.",
  cto: "Engineering today, approvals and security alerts.",
  executive: "The company at a glance.",
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
              <LevelMark level={e.level} /> {ROLE_LABEL[e.role]} · <span className="font-mono">{e.empId}</span>
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
