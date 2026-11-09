"use client";
/**
 * Home layout per role (plan §17 "Home dashboards by level", adapted to Aceva's structure):
 * CEO / Founder / Owner (sees everything, approves nothing) · Director (approves) · CTO · Sales · Finance · Engineering.
 * Widgets hide themselves when the viewer lacks access, so each layout stays safe.
 */
import type { HomeVariant } from "./home-screen";
import { ApprovalsWidget, MyTasksWidget, OversightWidget, ReviewQueueWidget, TeamOverdueWidget, TeamWorkloadWidget } from "./core-widgets";
import { AnnouncementsWidget, BillingWidget, MeetingsWidget } from "./billing-comms-widgets";
import { OnlineNowWidget, SecurityAlertsWidget } from "./control-widgets";
import { FinanceKpiRow, RevenueExpenseWidget } from "./finance-widgets";
import { BackupWidget, PayrollStageWidget } from "./payroll-widgets";
import { MySalesDayWidget, PipelineWidget } from "./sales-widgets";
import { TeamKpiRow } from "./summary-widgets";
import { CheckInCard, LeaveBalanceWidget, PerformanceWidget, TeamTodayCard } from "./work-widgets";

const Grid = ({ children }: { children: React.ReactNode }) => <div className="grid items-start gap-5 lg:grid-cols-2">{children}</div>;
const Stack = ({ children }: { children: React.ReactNode }) => <div className="grid gap-5">{children}</div>;

export function HomeLayout({ variant }: { variant: HomeVariant }) {
  switch (variant) {
    /* L5 Engineering and development */
    case "employee":
      return (
        <Stack>
          <CheckInCard />
          <Grid>
            <MyTasksWidget />
            <LeaveBalanceWidget />
            <PerformanceWidget />
            <AnnouncementsWidget />
          </Grid>
          <MeetingsWidget />
        </Stack>
      );

    /* L4 Sales */
    case "sales":
      return (
        <Stack>
          <CheckInCard compact />
          <MySalesDayWidget />
          <Grid>
            <MyTasksWidget />
            <AnnouncementsWidget />
            <LeaveBalanceWidget />
            <PerformanceWidget />
          </Grid>
        </Stack>
      );

    /* L4 Finance: prepares; the Director approves */
    case "finance":
      return (
        <Stack>
          <CheckInCard compact />
          <FinanceKpiRow />
          <Grid>
            <MyTasksWidget />
            <PayrollStageWidget />
            <BillingWidget />
            <RevenueExpenseWidget />
            <LeaveBalanceWidget />
            <AnnouncementsWidget />
          </Grid>
        </Stack>
      );

    /* L3 CTO: runs engineering */
    case "cto":
      return (
        <Stack>
          <CheckInCard compact />
          <TeamKpiRow scopeLabel="team" />
          <Grid>
            <TeamTodayCard />
            <TeamWorkloadWidget />
            <ReviewQueueWidget />
            <ApprovalsWidget />
            <SecurityAlertsWidget />
            <TeamOverdueWidget />
            <OnlineNowWidget />
            <BackupWidget />
          </Grid>
        </Stack>
      );

    /* L2 Director: the approver for the company; HR duty and sales manager */
    case "director":
      return (
        <Stack>
          <CheckInCard compact />
          <TeamKpiRow scopeLabel="reporting line" />
          <FinanceKpiRow />
          <Grid>
            <ApprovalsWidget />
            <PayrollStageWidget />
            <RevenueExpenseWidget />
            <PipelineWidget />
            <BillingWidget />
            <TeamTodayCard />
          </Grid>
          <MySalesDayWidget />
        </Stack>
      );

    /* L1 CEO / Founder / Owner: sees every activity, approves nothing (the Director approves) */
    case "executive":
    default:
      return (
        <Stack>
          <FinanceKpiRow />
          <TeamKpiRow scopeLabel="company" />
          <Grid>
            <OversightWidget />
            <RevenueExpenseWidget />
            <PayrollStageWidget />
            <PipelineWidget />
            <SecurityAlertsWidget />
            <OnlineNowWidget />
            <BillingWidget />
            <BackupWidget />
          </Grid>
        </Stack>
      );
  }
}
