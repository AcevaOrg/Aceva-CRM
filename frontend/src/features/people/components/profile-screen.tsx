"use client";
import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Activity, CalendarX, FileText, History, IdCard, LockOpen, Mail, MapPin, MessageSquare, MoreHorizontal, Plus, Briefcase, UserRound, Wallet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Avatar, Skeleton } from "@/components/ui/misc";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageHeader } from "@/components/layout/page-header";
import { NotFoundBlock } from "@/components/shared/can";
import { StatusBadge } from "@/components/shared/chips";
import { useStepUp } from "@/components/shared/dialogs";
import { EmpChip } from "@/components/shared/emp-chip";
import { LevelMark } from "@/components/shared/level-mark";
import { ErrorState } from "@/components/shared/states";
import { useAccountLocks, useUnlockAccount } from "@/features/activity/hooks";
import { useLookup } from "@/hooks/use-directory";
import { useUrlState } from "@/hooks/use-url-state";
import { ApiError } from "@/lib/api/mock";
import { descendantsOf } from "@/lib/auth/scope";
import { DUTY_LABEL, ROLE_LABEL } from "@/lib/auth/permissions";
import { useViewer } from "@/lib/auth/viewer";
import { formatDate } from "@/lib/dates";
import { useProfile } from "../hooks";
import { STATUS_INFO, TYPE_LABEL } from "../logic";
import type { ProfileSection } from "../types";
import { OffboardDialog } from "./offboard-dialog";
import { BasicSection, DocumentsSection, HistorySection, JobSection, PaySection, PersonalSection } from "./profile-sections";

const TABS: { key: ProfileSection; label: string; icon: React.ElementType }[] = [
  { key: "basic", label: "Basic", icon: IdCard },
  { key: "job", label: "Job", icon: Briefcase },
  { key: "personal", label: "Personal", icon: UserRound },
  { key: "pay", label: "Pay", icon: Wallet },
  { key: "documents", label: "Documents", icon: FileText },
  { key: "history", label: "History", icon: History },
];

/** /people/[empId]: one employee profile (spec §9.3). Tabs follow the visibility table. */
export function ProfileScreen({ empId }: { empId: string }) {
  const query = useProfile(empId);
  const viewer = useViewer();
  const lookup = useLookup();
  const [tab, setTab] = useUrlState<ProfileSection>("tab", "basic");
  const [offboarding, setOffboarding] = React.useState(false);
  const locks = useAccountLocks();
  const unlock = useUnlockAccount();
  const stepUp = useStepUp();

  if (query.isPending) {
    return (
      <div className="grid gap-6 pt-6">
        <Skeleton className="h-36 w-full rounded-xl" />
        <Skeleton className="h-10 w-96" />
        <Skeleton className="h-64 w-full rounded-xl" />
      </div>
    );
  }
  if (query.isError) {
    if (query.error instanceof ApiError && query.error.status === 404) return <div className="pt-8"><NotFoundBlock /></div>;
    return <div className="pt-8"><ErrorState error={query.error} onRetry={() => query.refetch()} /></div>;
  }
  if (!viewer) return null;

  const view = query.data;
  const e = view.employee;
  const visible = TABS.filter((t) => view.access.see[t.key]);
  const active = visible.some((t) => t.key === tab) ? tab : "basic";
  const below = descendantsOf(viewer.employee.empId, lookup.employees).includes(e.empId);
  const locked = locks.data?.some((l) => l.empId === e.empId);
  // Unlocking and offboarding only go downward: a manager for people below them in the reporting line.
  const canUnlock = viewer.can("auth.unlock_account") && below && !!locked;
  const canOffboard = viewer.can("people.manage") && view.access.edit.job;
  const dept = lookup.department(e.departmentId);
  const office = lookup.office(e.officeId);

  const actions = (
    <div className="flex flex-wrap items-center gap-2">
      {!view.access.isSelf && e.status !== "left" && (
        <Button variant="outline" asChild>
          <Link href={`/messages?to=${e.empId}`}>
            <MessageSquare /> Message
          </Link>
        </Button>
      )}
      {viewer.can("task.assign") && below && e.status !== "left" && (
        <Button variant="outline" asChild>
          <Link href={`/tasks?assign=1&to=${e.empId}`}>
            <Plus /> Assign task
          </Link>
        </Button>
      )}
      {viewer.can(["activity.view_all", "activity.view_team"]) && below && (
        <Button variant="ghost" asChild>
          <Link href={`/activity?tab=timeline&emp=${e.empId}`}>
            <Activity /> View activity
          </Link>
        </Button>
      )}
      {((canOffboard && e.status !== "left") || canUnlock) && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="icon" variant="ghost" aria-label="More actions">
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {canUnlock && (
              <DropdownMenuItem
                onSelect={async () => {
                  if (!(await stepUp({ action: `Unlock the account of ${e.name}` }))) return;
                  await unlock.mutateAsync(e.empId);
                  toast.success(`${e.name} can sign in again`);
                }}
              >
                <LockOpen /> Unlock account
              </DropdownMenuItem>
            )}
            {canOffboard && e.status !== "left" && (
              <DropdownMenuItem destructive onSelect={() => setOffboarding(true)}>
                <CalendarX /> Set last working day
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );

  return (
    <>
      <PageHeader zone="work" eyebrow="People" title={view.access.isSelf ? "My profile" : e.name} back={{ href: "/people", label: "People" }} seal={view.access.see.pay ? "highly" : view.access.see.personal ? "confidential" : "internal"} />

      <Card className="relative mb-6 overflow-hidden">
        <span className="absolute inset-x-0 top-0 h-1" style={{ background: dept?.color ?? "var(--muted)" }} aria-hidden />
        <div className="flex flex-wrap items-start gap-5 p-5 sm:p-6">
          <Avatar name={e.name} hue={e.avatarHue} size={76} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-xl font-semibold tracking-tight">{e.name}</h2>
              <StatusBadge {...STATUS_INFO[e.status]} />
              {locked && <StatusBadge label="Account locked" tone="danger" />}
            </div>
            <p className="text-[13.5px] text-muted-foreground">{e.designation}</p>
            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[12.5px] text-muted-foreground">
              <span className="font-mono font-semibold text-foreground">{e.empId}</span>
              <LevelMark level={e.level} showLabel />
              <span>{dept?.name}</span>
              <span className="inline-flex items-center gap-1"><MapPin className="size-3.5" /> {office?.name}</span>
              <a href={`mailto:${e.officialEmail}`} className="inline-flex items-center gap-1 hover:text-foreground"><Mail className="size-3.5" /> {e.officialEmail}</a>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-[12.5px]">
              <span className="flex items-center gap-2 text-muted-foreground">
                Reports to {e.reportsTo ? <EmpChip empId={e.reportsTo} size="sm" /> : <span className="text-foreground">nobody</span>}
              </span>
              <span className="text-muted-foreground">
                {ROLE_LABEL[e.role]}
                {e.duties.map((d) => ` · ${DUTY_LABEL[d]}`).join("")} · {TYPE_LABEL[e.type]} · joined {formatDate(e.joiningDate)}
              </span>
              {e.status === "on_notice" && e.lastWorkingDay && <span className="font-medium text-[oklch(0.55_0.13_70)]">Last working day {formatDate(e.lastWorkingDay)}</span>}
            </div>
          </div>
          <div className="w-full sm:w-auto">{actions}</div>
        </div>
      </Card>

      <Tabs value={active} onValueChange={(v) => setTab(v as ProfileSection)}>
        <TabsList>
          {visible.map((t) => (
            <TabsTrigger key={t.key} value={t.key}>
              <t.icon /> {t.label}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="basic"><BasicSection view={view} /></TabsContent>
        {view.access.see.job && <TabsContent value="job"><JobSection view={view} /></TabsContent>}
        {view.access.see.personal && <TabsContent value="personal"><PersonalSection view={view} /></TabsContent>}
        {view.access.see.pay && <TabsContent value="pay"><PaySection view={view} /></TabsContent>}
        {view.access.see.documents && <TabsContent value="documents"><DocumentsSection view={view} /></TabsContent>}
        {view.access.see.history && <TabsContent value="history"><HistorySection view={view} employee={e} /></TabsContent>}
      </Tabs>
      {visible.length < TABS.length && (
        <p className="mt-4 text-[12.5px] text-muted-foreground">
          Some parts of this profile are hidden. Personal, pay and document details follow the hierarchy and confidentiality rules.
        </p>
      )}

      {offboarding && <OffboardDialog employee={e} onClose={() => setOffboarding(false)} />}
    </>
  );
}
