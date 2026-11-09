"use client";
/**
 * Widget arrangement per persona (plan §17 "Home dashboards by level").
 * Widgets hide themselves when the viewer lacks access, so each layout stays safe.
 */
import type { HomeVariant } from "./home-screen";
import { ApprovalsWidget, MyTasksWidget, ReviewQueueWidget, TeamOverdueWidget, TeamWorkloadWidget } from "./core-widgets";
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

    case "finance":
      return (
        <Stack>
          <CheckInCard compact />
          <FinanceKpiRow />
          <Grid>
            <MyTasksWidget />
            <PayrollStageWidget />
            <BillingWidget />
            <AnnouncementsWidget />
            <LeaveBalanceWidget />
            <MeetingsWidget />
          </Grid>
        </Stack>
      );

    case "lead":
      return (
        <Stack>
          <CheckInCard compact />
          <TeamKpiRow />
          <Grid>
            <TeamTodayCard />
            <TeamWorkloadWidget />
            <ReviewQueueWidget />
            <ApprovalsWidget />
            <TeamOverdueWidget />
            <AnnouncementsWidget />
          </Grid>
        </Stack>
      );

    case "sales_lead":
      return (
        <Stack>
          <CheckInCard compact />
          <TeamKpiRow />
          <MySalesDayWidget />
          <Grid>
            <PipelineWidget />
            <ApprovalsWidget />
            <TeamTodayCard />
            <AnnouncementsWidget />
          </Grid>
        </Stack>
      );

    case "cto":
      return (
        <Stack>
          <TeamKpiRow scopeLabel="department" />
          <Grid>
            <ApprovalsWidget />
            <SecurityAlertsWidget />
            <OnlineNowWidget />
            <TeamWorkloadWidget />
            <TeamOverdueWidget />
            <BackupWidget />
          </Grid>
        </Stack>
      );

    case "director":
      return (
        <Stack>
          <TeamKpiRow scopeLabel="department" />
          <FinanceKpiRow />
          <Grid>
            <ApprovalsWidget />
            <RevenueExpenseWidget />
            <PayrollStageWidget />
            <PipelineWidget />
            <BillingWidget />
            <TeamOverdueWidget />
          </Grid>
        </Stack>
      );

    case "executive":
    default:
      return (
        <Stack>
          <FinanceKpiRow />
          <Grid>
            <RevenueExpenseWidget />
            <ApprovalsWidget />
            <SecurityAlertsWidget />
            <PipelineWidget />
            <PayrollStageWidget />
            <OnlineNowWidget />
            <BillingWidget />
            <BackupWidget />
          </Grid>
        </Stack>
      );
  }
}
