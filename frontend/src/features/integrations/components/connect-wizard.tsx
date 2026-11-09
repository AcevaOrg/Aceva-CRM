"use client";
import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Check, CircleAlert, CircleCheck, CircleX, KeyRound, Lock, Plug, ShieldCheck, UserPlus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SegmentedControl, Switch } from "@/components/ui/controls";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton, Table, TBody, TD, TH, THead, TR } from "@/components/ui/misc";
import { PageHeader } from "@/components/layout/page-header";
import { NotFoundBlock, RequireAccess } from "@/components/shared/can";
import { FreshnessStamp } from "@/components/shared/chips";
import { useStepUp } from "@/components/shared/dialogs";
import { EmployeeSelect } from "@/components/shared/pickers";
import { ErrorState } from "@/components/shared/states";
import { useUrlState } from "@/hooks/use-url-state";
import { useCan } from "@/lib/auth/viewer";
import { formatDateTime } from "@/lib/dates";
import { cn } from "@/lib/utils";
import { useLinkUser, useSaveKey, useTestConnection, useTool, useUpdateConnection } from "../hooks";
import { TOOL_META } from "../logic";
import type { TestResult, ToolConnection, ToolId, ToolUserLink } from "../types";
import { ConnectionBadge, KeyMask, ToolTile } from "./tool-ui";

const TOOLS: ToolId[] = ["apollo", "millionverifier", "mailboxes", "salesforce"];
type Step = "about" | "key" | "test" | "users" | "schedule";
const STEPS: { id: Step; label: string }[] = [
  { id: "about", label: "What it reads" },
  { id: "key", label: "Key" },
  { id: "test", label: "Test connection" },
  { id: "users", label: "Link users" },
  { id: "schedule", label: "Schedule and turn on" },
];

export function ConnectWizardScreen({ tool }: { tool: string }) {
  if (!TOOLS.includes(tool as ToolId)) return <NotFoundBlock />;
  return (
    <RequireAccess permission="integrations.view">
      <Wizard tool={tool as ToolId} />
    </RequireAccess>
  );
}

function Wizard({ tool }: { tool: ToolId }) {
  const m = TOOL_META[tool];
  const q = useTool(tool);
  const canManage = useCan("integrations.manage");
  const [step, setStep] = useUrlState<Step>("step", "about");
  const [test, setTest] = React.useState<TestResult | null>(null);

  if (q.isPending)
    return (
      <div className="grid gap-4 pt-6">
        <Skeleton className="h-24" />
        <Skeleton className="h-80" />
      </div>
    );
  if (q.isError)
    return (
      <>
        <PageHeader title={m.name} back={{ href: "/integrations", label: "Integrations" }} />
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      </>
    );
  const { connection: c, users } = q.data;
  const done: Record<Step, boolean> = {
    about: true,
    key: !!c.keyLast4,
    test: !!test?.ok || c.status === "working",
    users: !m.linksUsers || users.every((u) => u.empId || u.closedAt),
    schedule: c.status === "working",
  };
  const idx = STEPS.findIndex((s) => s.id === step);
  const next = () => setStep(STEPS[Math.min(STEPS.length - 1, idx + 1)].id);

  return (
    <>
      <PageHeader
        title={m.name}
        description={c.status === "not_connected" ? "Connect this tool in five steps. Every step is saved in the audit log." : "Manage the connection. Every change is saved in the audit log."}
        back={{ href: "/integrations", label: "Integrations" }}
        seal="highly"
        meta={
          <>
            <ToolTile tool={tool} size={22} />
            <ConnectionBadge status={c.status} />
            {c.lastSuccessAt && <FreshnessStamp source="Last sync" at={c.lastSuccessAt} />}
          </>
        }
      />
      {!canManage && (
        <p className="mb-5 flex items-center gap-2 rounded-lg border border-info/30 bg-info/10 px-3 py-2 text-[12.5px]">
          <Lock className="size-4 text-info" /> View only. The CTO and the Director add, test, change or remove a connection.
        </p>
      )}
      <div className="grid gap-5 lg:grid-cols-[240px_minmax(0,1fr)]">
        <ol className="flex gap-1 overflow-x-auto lg:flex-col lg:overflow-visible" aria-label="Steps">
          {STEPS.map((s, i) => (
            <li key={s.id}>
              <button
                onClick={() => setStep(s.id)}
                aria-current={s.id === step ? "step" : undefined}
                className={cn(
                  "flex w-full items-center gap-3 whitespace-nowrap rounded-lg px-3 py-2.5 text-left text-[13px] transition hover:bg-muted",
                  s.id === step && "bg-card font-semibold shadow-strata ring-1 ring-border",
                )}
              >
                <span
                  className={cn(
                    "grid size-6 shrink-0 place-content-center rounded-full text-[11px] font-bold",
                    done[s.id] ? "bg-success text-white" : s.id === step ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground",
                  )}
                >
                  {done[s.id] ? <Check className="size-3.5" strokeWidth={3} /> : i + 1}
                </span>
                {s.label}
              </button>
            </li>
          ))}
        </ol>
        <div className="min-w-0">
          {step === "about" && <AboutStep tool={tool} onNext={next} />}
          {step === "key" && <KeyStep c={c} canManage={canManage} onNext={() => { setTest(null); next(); }} />}
          {step === "test" && <TestStep c={c} canManage={canManage} result={test} setResult={setTest} onNext={next} />}
          {step === "users" && <UsersStep tool={tool} users={users} canManage={canManage} onNext={next} />}
          {step === "schedule" && <ScheduleStep c={c} canManage={canManage} />}
        </div>
      </div>
    </>
  );
}

function StepCard({ title, description, children, footer }: { title: string; description?: string; children: React.ReactNode; footer?: React.ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>{title}</CardTitle>
          {description && <p className="text-[12.5px] text-muted-foreground">{description}</p>}
        </div>
      </CardHeader>
      <CardContent className="grid gap-4">
        {children}
        {footer && <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-4">{footer}</div>}
      </CardContent>
    </Card>
  );
}

function AboutStep({ tool, onNext }: { tool: ToolId; onNext: () => void }) {
  const m = TOOL_META[tool];
  return (
    <StepCard title="What this connection reads" description="Read only. In this phase Aceva never sends emails or changes anything inside the tool." footer={<Button onClick={onNext}>Continue</Button>}>
      {m.advice && (
        <p className="flex gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2.5 text-[13px]">
          <CircleAlert className="mt-0.5 size-4 shrink-0 text-[oklch(0.6_0.14_70)]" /> {m.advice}
        </p>
      )}
      <dl className="grid gap-3 text-[13px]">
        {[
          ["What the system reads", m.reads],
          ["How", m.how],
          ["Limits and notes", m.limits],
        ].map(([k, v]) => (
          <div key={k} className="grid gap-1 rounded-lg border border-border p-3 sm:grid-cols-[180px_1fr]">
            <dt className="text-[11.5px] font-semibold uppercase tracking-wider text-muted-foreground">{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      <p className="flex items-center gap-2 text-[12.5px] text-muted-foreground">
        <ShieldCheck className="size-4 text-seal-own" /> Email text, call recordings and private messages are never read or stored.
      </p>
    </StepCard>
  );
}

function KeyStep({ c, canManage, onNext }: { c: ToolConnection; canManage: boolean; onNext: () => void }) {
  const m = TOOL_META[c.tool];
  const [key, setKey] = React.useState("");
  const [host, setHost] = React.useState(c.imapHost ?? "imap.hostinger.com");
  const [changing, setChanging] = React.useState(!c.keyLast4);
  const save = useSaveKey();
  const stepUp = useStepUp();

  const submit = async () => {
    if (!(await stepUp({ action: `${c.keyLast4 ? "Change" : "Save"} the ${m.name} key`, detail: "API keys are highly confidential. This is a security event." }))) return;
    save.mutate(
      { tool: c.tool, key, imapHost: c.tool === "mailboxes" ? host : undefined },
      {
        onSuccess: (r) => {
          toast.success("Key encrypted and saved", { description: `Only ••••${r.keyLast4} is shown from now on.` });
          setKey("");
          setChanging(false);
          onNext();
        },
        onError: (e) => toast.error(e instanceof Error ? e.message : "Couldn't save the key."),
      },
    );
  };

  return (
    <StepCard
      title={m.keyLabel}
      description="Encrypted with AES-256 as soon as it's saved. It is never shown again and never sent to a browser; you'll only see the last 4 characters."
      footer={
        changing ? (
          <>
            {c.keyLast4 && (
              <Button variant="outline" onClick={() => setChanging(false)}>
                Cancel
              </Button>
            )}
            <Button disabled={!canManage || key.trim().length < 8} loading={save.isPending} onClick={submit}>
              <KeyRound /> Save key
            </Button>
          </>
        ) : (
          <Button onClick={onNext}>Continue</Button>
        )
      }
    >
      {c.keyLast4 && !changing ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-muted/40 p-4">
          <div className="flex items-center gap-3">
            <span className="grid size-9 place-content-center rounded-lg bg-card shadow-strata">
              <Lock className="size-4 text-muted-foreground" />
            </span>
            <div>
              <p className="text-[13px] font-medium">Saved key</p>
              <KeyMask last4={c.keyLast4} className="text-[14px]" />
            </div>
          </div>
          {canManage && (
            <Button variant="outline" onClick={() => setChanging(true)}>
              Change key
            </Button>
          )}
        </div>
      ) : (
        <div className="grid gap-4">
          {c.tool === "mailboxes" && (
            <Field label="IMAP server" htmlFor="imap-host">
              <Input id="imap-host" value={host} onChange={(e) => setHost(e.target.value)} disabled={!canManage} className="font-mono" />
            </Field>
          )}
          <Field label={m.keyLabel} htmlFor="tool-key" hint={c.tool === "apollo" ? "A master key can open the whole Apollo account. It's changed every 3 months and when anyone who saw it leaves." : "Paste it once. Demo: anything 8+ characters; a key containing “bad” fails the test."}>
            <Input id="tool-key" type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} disabled={!canManage} className="font-mono" placeholder="Paste the key" />
          </Field>
        </div>
      )}
    </StepCard>
  );
}

function TestStep({ c, canManage, result, setResult, onNext }: { c: ToolConnection; canManage: boolean; result: TestResult | null; setResult: (r: TestResult) => void; onNext: () => void }) {
  const test = useTestConnection();
  return (
    <StepCard
      title="Test connection"
      description="Checks the key works and shows what it can read."
      footer={
        <>
          {canManage && (
            <Button variant="outline" loading={test.isPending} disabled={!c.keyLast4} onClick={() => test.mutate(c.tool, { onSuccess: setResult })}>
              <Plug /> Test connection
            </Button>
          )}
          <Button disabled={canManage && !result?.ok && c.status !== "working"} onClick={onNext}>
            Continue
          </Button>
        </>
      }
    >
      {!c.keyLast4 && <p className="text-[13px] text-muted-foreground">Save a key first.</p>}
      {result &&
        (result.ok ? (
          <div className="rounded-xl border border-success/30 bg-success/8 p-4">
            <p className="flex items-center gap-2 text-[13.5px] font-semibold">
              <CircleCheck className="size-4 text-success" /> The key works. It can read:
            </p>
            <ul className="mt-2 grid gap-1 pl-6 text-[13px]">
              {result.canRead.map((r) => (
                <li key={r} className="list-disc">
                  {r}
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="flex items-center gap-2 rounded-xl border border-danger/35 bg-danger/8 p-4 text-[13.5px]">
            <CircleX className="size-4 text-danger" /> {result.error}
          </p>
        ))}
      {!result && c.status === "working" && <p className="text-[13px] text-muted-foreground">The connection is working. Run a test after changing the key.</p>}
    </StepCard>
  );
}

function UsersStep({ tool, users, canManage, onNext }: { tool: ToolId; users: ToolUserLink[]; canManage: boolean; onNext: () => void }) {
  const link = useLinkUser();
  const m = TOOL_META[tool];
  if (!m.linksUsers)
    return (
      <StepCard title="Link users" footer={<Button onClick={onNext}>Continue</Button>}>
        <p className="text-[13px] text-muted-foreground">
          MillionVerifier can&apos;t tell who checked a list, so lists are sent through Aceva (Leads → Verify emails). Each check is recorded against the person who asked for it. There are no users to link.
        </p>
      </StepCard>
    );
  const unmatched = users.filter((u) => !u.empId && !u.closedAt).length;
  return (
    <StepCard
      title="Link users to Emp-IDs"
      description="Link each tool user to a salesperson (Sales only). Activity from an unlinked user waits in the unmatched list and isn't counted for anyone."
      footer={<Button onClick={onNext}>Continue</Button>}
    >
      {unmatched > 0 && (
        <p className="flex items-center gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-[12.5px]">
          <UserPlus className="size-4" /> {unmatched} user{unmatched === 1 ? "" : "s"} not linked yet.
        </p>
      )}
      <div className="overflow-hidden rounded-xl border border-border">
        <Table>
          <THead>
            <tr>
              <TH>{tool === "mailboxes" ? "Mailbox" : "Tool user"}</TH>
              <TH>Emp-ID</TH>
              <TH className="w-24">Status</TH>
            </tr>
          </THead>
          <TBody>
            {users.map((u) => (
              <TR key={u.externalUserId}>
                <TD>
                  <span className="grid">
                    <span className="font-medium">{u.name}</span>
                    {u.email !== u.name && <span className="font-mono text-[11.5px] text-muted-foreground">{u.email}</span>}
                  </span>
                </TD>
                <TD className="min-w-56">
                  {canManage ? (
                    <EmployeeSelect
                      value={u.empId ?? ""}
                      placeholder="Not linked"
                      filter={(e) => e.role === "sales"}
                      onChange={(empId) =>
                        link.mutate(
                          { tool, externalUserId: u.externalUserId, empId: empId || null },
                          { onSuccess: () => toast.success(empId ? `${u.name} linked to ${empId}` : `${u.name} unlinked`, { description: empId ? "Waiting items are now counted for them." : undefined }) },
                        )
                      }
                    />
                  ) : (
                    <span className="font-mono text-[12.5px]">{u.empId ?? "Not linked"}</span>
                  )}
                </TD>
                <TD>{u.empId ? <Badge tone="success">Linked</Badge> : <Badge tone="warning">Unmatched</Badge>}</TD>
              </TR>
            ))}
          </TBody>
        </Table>
      </div>
    </StepCard>
  );
}

function ScheduleStep({ c, canManage }: { c: ToolConnection; canManage: boolean }) {
  const update = useUpdateConnection();
  const stepUp = useStepUp();
  const m = TOOL_META[c.tool];
  const on = c.status === "working" || c.status === "failing";

  const toggle = async (value: boolean) => {
    if (!value && !(await stepUp({ action: `Turn off ${m.name}`, detail: "Numbers from this tool stop updating. This is a security event." }))) return;
    update.mutate(
      { tool: c.tool, patch: { status: value ? "working" : "paused" } },
      {
        onSuccess: () => toast.success(value ? `${m.name} is on` : `${m.name} is off`, { description: value ? `First sync within ${c.syncEveryMin} minutes.` : undefined }),
        onError: (e) => toast.error(e instanceof Error ? e.message : "Couldn't change the connection."),
      },
    );
  };

  return (
    <StepCard title="Schedule and turn on" description="A scheduled job asks the tool only for what changed since the last successful sync, so it stays within the tool's limits.">
      <Field label="Sync every">
        <SegmentedControl
          value={String(c.syncEveryMin) as "15" | "30"}
          onChange={(v) => canManage && update.mutate({ tool: c.tool, patch: { syncEveryMin: Number(v) as 15 | 30 } }, { onSuccess: () => toast.success(`Syncs every ${v} minutes`) })}
          options={[
            { value: "15", label: "15 minutes", disabled: !canManage },
            { value: "30", label: "30 minutes", disabled: !canManage },
          ]}
          className="w-fit"
        />
      </Field>
      <label className="flex items-center justify-between gap-4 rounded-xl border border-border p-4">
        <span>
          <span className="block text-[13.5px] font-medium">Connection on</span>
          <span className="text-[12.5px] text-muted-foreground">
            {c.connectedBy ? `Connected by ${c.connectedBy}${c.connectedAt ? ` on ${formatDateTime(c.connectedAt)}` : ""}.` : "Not connected yet."} Turning it off needs your password and 2FA code.
          </span>
        </span>
        <Switch checked={on} disabled={!canManage || (!c.keyLast4 && !on) || update.isPending} onCheckedChange={toggle} aria-label="Connection on" />
      </label>
      <Button asChild variant="outline" className="w-fit">
        <Link href="/integrations">Back to connection health</Link>
      </Button>
    </StepCard>
  );
}
