"use client";
import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import {
  ArrowRight, Clock, Fingerprint, History, KeyRound, Laptop, LogOut, MapPin, ShieldCheck, Smartphone, UserRound,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/controls";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Avatar } from "@/components/ui/misc";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageHeader } from "@/components/layout/page-header";
import { StatusBadge } from "@/components/shared/chips";
import { DataTable } from "@/components/shared/data-table";
import { EmpChip } from "@/components/shared/emp-chip";
import { LevelMark } from "@/components/shared/level-mark";
import { DetailList } from "@/components/shared/pickers";
import { CardsSkeleton, EmptyState, QueryState } from "@/components/shared/states";
import { useLookup } from "@/hooks/use-directory";
import { useUrlState } from "@/hooks/use-url-state";
import { DUTY_LABEL, ROLE_LABEL } from "@/lib/auth/permissions";
import { useViewer } from "@/lib/auth/viewer";
import { formatDate, formatDateTime, formatRelative, formatTime } from "@/lib/dates";
import { useChangePassword, useEndSession, useLoginHistory, useMySessions, useSetTwoFactor, useTwoFactorStatus } from "../hooks";
import type { LoginHistoryItem, LogoutReason } from "../types";
import { PasswordFields } from "./password-fields";

type Tab = "overview" | "security" | "devices" | "history";

/** /account: the signed-in part of Module 2 (spec §9.2). */
export function AccountScreen() {
  const [tab, setTab] = useUrlState<Tab>("tab", "overview");
  return (
    <>
      <PageHeader zone="control" eyebrow="My account" title="My account" description="Your profile, password, two-step login and where you're signed in." seal="own" />
      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
        <TabsList>
          <TabsTrigger value="overview"><UserRound /> Overview</TabsTrigger>
          <TabsTrigger value="security"><ShieldCheck /> Security</TabsTrigger>
          <TabsTrigger value="devices"><Laptop /> My devices</TabsTrigger>
          <TabsTrigger value="history"><History /> Login history</TabsTrigger>
        </TabsList>
        <TabsContent value="overview"><Overview /></TabsContent>
        <TabsContent value="security"><Security /></TabsContent>
        <TabsContent value="devices"><Devices /></TabsContent>
        <TabsContent value="history"><LoginHistory /></TabsContent>
      </Tabs>
    </>
  );
}

function Overview() {
  const viewer = useViewer();
  const lookup = useLookup();
  if (!viewer) return null;
  const e = viewer.employee;
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
      <Card>
        <CardContent className="pt-5">
          <div className="flex flex-wrap items-center gap-4">
            <Avatar name={e.name} hue={e.avatarHue} size={64} />
            <div className="min-w-0">
              <p className="text-xl font-semibold tracking-tight">{e.name}</p>
              <p className="text-[13px] text-muted-foreground">{e.designation}</p>
              <p className="mt-1 flex flex-wrap items-center gap-2">
                <span className="font-mono text-[13px] font-semibold">{e.empId}</span>
                <LevelMark level={e.level} showLabel />
              </p>
            </div>
          </div>
          <DetailList
            columns={2}
            className="mt-6"
            items={[
              ["Role", ROLE_LABEL[e.role]],
              ["Duties", e.duties.length ? <span className="flex flex-wrap gap-1">{e.duties.map((d) => <Badge key={d} tone="primary">{DUTY_LABEL[d]}</Badge>)}</span> : "None"],
              ["Official email", e.officialEmail],
              ["Department", lookup.department(e.departmentId)?.name],
              ["Office", lookup.office(e.officeId)?.name],
              ["Reports to", e.reportsTo ? <EmpChip empId={e.reportsTo} size="sm" /> : "Nobody (top of the company)"],
              ["Joined", formatDate(e.joiningDate)],
              ["Emp-ID", <span key="id" className="text-muted-foreground">Never changes and is never reused.</span>],
            ]}
          />
        </CardContent>
      </Card>
      <div className="grid content-start gap-4">
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Your full profile</CardTitle>
              <CardDescription>Phone, address, emergency contact, documents and pay.</CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            <Button asChild variant="outline">
              <Link href={`/people/${e.empId}`}>
                Open my profile <ArrowRight />
              </Link>
            </Button>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Session rules</CardTitle>
              <CardDescription>Applied to everyone to keep company data safe.</CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            <ul className="grid gap-2 text-[13px]">
              <li className="flex gap-2"><Clock className="mt-0.5 size-4 shrink-0 text-muted-foreground" /> Signed out after 30 minutes without activity (10 minutes on finance screens).</li>
              <li className="flex gap-2"><Clock className="mt-0.5 size-4 shrink-0 text-muted-foreground" /> Signed out after 12 hours in any case.</li>
              <li className="flex gap-2"><KeyRound className="mt-0.5 size-4 shrink-0 text-muted-foreground" /> 5 wrong passwords lock the account until HR or a manager unlocks it.</li>
            </ul>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function Security() {
  const viewer = useViewer();
  const change = useChangePassword();
  const twoFactor = useTwoFactorStatus();
  const setTwoFactor = useSetTwoFactor();
  const [current, setCurrent] = React.useState("");
  const [next, setNext] = React.useState<string | null>(null);
  const [formKey, setFormKey] = React.useState(0);
  const onValid = React.useCallback((v: string | null) => setNext(v), []);
  if (!viewer) return null;

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <div>
            <CardTitle>Change password</CardTitle>
            <CardDescription>Changing it signs you out on every other device.</CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          <form
            key={formKey}
            className="grid gap-4"
            onSubmit={async (e) => {
              e.preventDefault();
              if (!next || !current) return;
              await change.mutateAsync(next);
              toast.success("Password changed", { description: "You were signed out on your other devices." });
              setCurrent("");
              setFormKey((k) => k + 1);
            }}
          >
            <Field label="Current password" htmlFor="cur-pw">
              <Input id="cur-pw" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} className="h-11" />
            </Field>
            <PasswordFields empId={viewer.employee.empId} onValid={onValid} />
            <Button type="submit" disabled={!next || !current} loading={change.isPending} className="w-fit">
              Save new password
            </Button>
          </form>
        </CardContent>
      </Card>

      <div className="grid content-start gap-6">
        <Card>
          <CardHeader>
            <div>
              <CardTitle className="flex items-center gap-2">
                <Fingerprint className="size-4 text-primary" /> Two-step login
              </CardTitle>
              <CardDescription>A 6-digit code from Google or Microsoft Authenticator after your password.</CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            <QueryState query={twoFactor} skeleton={<CardsSkeleton count={1} className="sm:grid-cols-1 xl:grid-cols-1" />}>
              {(s) => (
                <div className="grid gap-3">
                  <div className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2.5">
                    <div>
                      <p className="text-[13px] font-medium">{s.enabled ? "On" : "Off"}</p>
                      <p className="text-[12px] text-muted-foreground">
                        {s.required
                          ? "Required for your level or finance duty, so it can't be turned off."
                          : s.enabled
                            ? `Turned on ${s.enabledAt ? formatDate(s.enabledAt) : ""}. Optional for your level.`
                            : "Optional for your level. We recommend turning it on."}
                      </p>
                    </div>
                    <Switch
                      checked={s.enabled}
                      disabled={s.required || setTwoFactor.isPending}
                      onCheckedChange={async (v) => {
                        await setTwoFactor.mutateAsync(v);
                        toast.success(v ? "Two-step login turned on" : "Two-step login turned off", { description: "Security events are logged." });
                      }}
                      aria-label="Two-step login"
                    />
                  </div>
                  {s.required && <Badge tone="info" className="w-fit"><ShieldCheck /> Locked on by company policy</Badge>}
                  <p className="text-[12.5px] text-muted-foreground">Lost your phone? Ask the Director or HR to reset two-step login. They will check your identity first.</p>
                </div>
              )}
            </QueryState>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function Devices() {
  const query = useMySessions();
  const end = useEndSession();
  return (
    <QueryState query={query} skeleton={<CardsSkeleton count={2} className="xl:grid-cols-2" />}>
      {(sessions) => (
        <div className="grid gap-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-[13px] text-muted-foreground">You&apos;re signed in on {sessions.length} device{sessions.length === 1 ? "" : "s"}. Sign out anything you don&apos;t recognise.</p>
            <Button
              variant="outline"
              disabled={sessions.filter((s) => !s.current).length === 0}
              loading={end.isPending}
              onClick={async () => {
                await end.mutateAsync(undefined);
                toast.success("Signed out on all other devices");
              }}
            >
              <LogOut /> Sign out all other devices
            </Button>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            {sessions.map((s) => {
              const phone = /phone|android|ios/i.test(s.device);
              return (
                <Card key={s.id} className="flex items-start gap-4 p-5">
                  <span className="grid size-11 shrink-0 place-content-center rounded-xl bg-muted text-muted-foreground">
                    {phone ? <Smartphone className="size-5" /> : <Laptop className="size-5" />}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="font-semibold">{s.device}</p>
                      {s.current && <Badge tone="signal">This device</Badge>}
                    </div>
                    <p className="text-[12.5px] text-muted-foreground">
                      {s.browser} · {s.os}
                    </p>
                    <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[12.5px] text-muted-foreground">
                      <span className="inline-flex items-center gap-1"><MapPin className="size-3.5" /> {s.city} (approximate)</span>
                      <span className="font-mono">{s.ip}</span>
                    </p>
                    <p className="mt-1 text-[12.5px] text-muted-foreground">
                      Signed in {formatDateTime(s.startedAt)} · last active {s.current ? "now" : formatRelative(s.lastActiveAt)}
                    </p>
                  </div>
                  {!s.current && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={async () => {
                        await end.mutateAsync(s.id);
                        toast.success(`Signed out on ${s.device}`);
                      }}
                    >
                      Sign out
                    </Button>
                  )}
                </Card>
              );
            })}
          </div>
        </div>
      )}
    </QueryState>
  );
}

const END_LABEL: Record<LogoutReason, string> = {
  clicked: "Signed out",
  timed_out: "Timed out",
  forced: "Signed out by an admin",
  password_changed: "Password changed",
};

function LoginHistory() {
  const query = useLoginHistory();
  return (
    <DataTable<LoginHistoryItem>
      rows={query.data}
      loading={query.isPending}
      rowKey={(h) => h.id}
      initialSort={{ key: "at", dir: "desc" }}
      empty={<EmptyState icon={<History />} title="No logins yet" />}
      columns={[
        { key: "at", header: "Signed in", cell: (h) => <span className="tabular">{formatDateTime(h.at)}</span>, sortValue: (h) => h.at },
        { key: "result", header: "Result", cell: (h) => (h.success ? <StatusBadge label="Success" tone="success" /> : <StatusBadge label="Wrong password" tone="danger" />) },
        { key: "2fa", header: "2FA", cell: (h) => (h.twoFactor ? "Used" : "—"), hideOnMobile: true },
        { key: "device", header: "Device", cell: (h) => h.device },
        { key: "city", header: "City", cell: (h) => h.city, hideOnMobile: true },
        { key: "ip", header: "Address", cell: (h) => <span className="font-mono text-[12px] text-muted-foreground">{h.ip}</span>, hideOnMobile: true },
        {
          key: "ended",
          header: "Ended",
          cell: (h) =>
            !h.success ? "—" : h.endedAt ? (
              <span className="text-muted-foreground">
                {formatTime(h.endedAt)} · {END_LABEL[h.endReason ?? "clicked"]}
              </span>
            ) : (
              <Badge tone="signal">Still signed in</Badge>
            ),
        },
      ]}
    />
  );
}
