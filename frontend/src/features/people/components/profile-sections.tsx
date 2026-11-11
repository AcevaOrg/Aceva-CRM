"use client";
import * as React from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import { FileUp, History, Plus, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/controls";
import { Field } from "@/components/ui/field";
import { Input, Textarea } from "@/components/ui/input";
import { useReason, useStepUp } from "@/components/shared/dialogs";
import { EmpChip } from "@/components/shared/emp-chip";
import { LevelMark } from "@/components/shared/level-mark";
import { Money } from "@/components/shared/money";
import { DetailList, EmployeeSelect } from "@/components/shared/pickers";
import { StatusBadge } from "@/components/shared/chips";
import { EmptyState } from "@/components/shared/states";
import { FileCard, Timeline } from "@/components/shared/timeline";
import { REPORTS_TO_HINT, reportsToLevel } from "@/features/access/logic";
import { useLookup } from "@/hooks/use-directory";
import { LEVEL_LABEL } from "@/lib/auth/permissions";
import { useCan, useViewer } from "@/lib/auth/viewer";
import { formatDate, formatDateTime, formatRelative, isoDay } from "@/lib/dates";
import { formatBytes, formatMoney, toNumber } from "@/lib/format";
import type { Employee, Level } from "@/types";
import { useRevealField, useUpdateBasic, useUpdateJob, useUpdatePay, useUpdatePersonal, useUploadDocument } from "../hooks";
import { DOC_LABEL, hireLevels, STATUS_INFO, TYPE_LABEL } from "../logic";
import type { DocumentKind, ProfileView } from "../types";
import { useQueryClient } from "@tanstack/react-query";
import { http, isLive } from "@/lib/api/http";
import { livePeopleApi } from "../live-api";
import { LoggedMaskedValue } from "./logged-masked-value";
import { FormActions, SectionCard } from "./section-card";

/** Shown on sections the viewer can see but not change (the CEO / Founder / Owner views every profile, edits none). */
const HR_EDITS = "View only. The Director (HR duty) edits.";

const err = (e: unknown) => toast.error(e instanceof Error ? e.message : "Couldn't save the change.");

/* ---------------- Basic ---------------- */

const basicSchema = z.object({
  name: z.string().trim().min(3, "Enter the full name."),
  designation: z.string().trim().min(2, "Enter a designation."),
  departmentId: z.string().min(1),
  officeId: z.string().min(1),
  officialEmail: z.string().trim().email("Enter a valid email.").refine((v) => v.endsWith("@acevatech.com"), "Use an @acevatech.com address."),
});

/** The profile photo (live): the employee, or the Director/HR for people below them, can change it. JPEG or PNG, 2 MB. */
function PhotoControl({ view }: { view: ProfileView }) {
  const empId = view.employee.empId;
  const qc = useQueryClient();
  const [src, setSrc] = React.useState<string | null>(null);
  const [version, setVersion] = React.useState(0);
  const [busy, setBusy] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const canChange = view.access.isSelf || view.access.edit.basic;

  React.useEffect(() => {
    if (!view.hasPhoto && version === 0) return;
    let url: string | null = null;
    let cancelled = false;
    http.blob(`/employees/${empId}/photo`).then((b) => {
      if (cancelled) return;
      url = URL.createObjectURL(b);
      setSrc(url);
    }).catch(() => setSrc(null));
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [empId, view.hasPhoto, version]);

  return (
    <div className="mb-4 flex items-center gap-3">
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element -- a private image fetched with the session, shown from a local blob
        <img src={src} alt="Profile photo" data-testid="profile-photo" className="size-16 rounded-full object-cover" />
      ) : (
        <span className="grid size-16 place-content-center rounded-full bg-muted text-[12px] text-muted-foreground" data-testid="no-photo">No photo</span>
      )}
      {canChange && (
        <>
          <Button size="sm" variant="outline" loading={busy} onClick={() => inputRef.current?.click()}>
            Change photo
          </Button>
          <input
            ref={inputRef}
            type="file"
            accept="image/png,image/jpeg"
            className="sr-only"
            data-testid="photo-input"
            onChange={async (ev) => {
              const f = ev.target.files?.[0];
              ev.target.value = "";
              if (!f) return;
              if (f.size > 2 * 1024 * 1024) return void toast.error("The photo must be 2 MB or smaller.");
              setBusy(true);
              try {
                const form = new FormData();
                form.set("file", f, f.name);
                await http.upload(`/employees/${empId}/photo`, form);
                setVersion((v) => v + 1);
                qc.invalidateQueries({ queryKey: ["people"] });
                toast.success("Photo updated");
              } catch (e) {
                toast.error(e instanceof Error ? e.message : "Couldn't upload the photo.");
              } finally {
                setBusy(false);
              }
            }}
          />
        </>
      )}
    </div>
  );
}

export function BasicSection({ view }: { view: ProfileView }) {
  const e = view.employee;
  const lookup = useLookup();
  const update = useUpdateBasic();
  const [editing, setEditing] = React.useState(false);
  const form = useForm<z.infer<typeof basicSchema>>({ resolver: zodResolver(basicSchema), values: { name: e.name, designation: e.designation, departmentId: e.departmentId, officeId: e.officeId, officialEmail: e.officialEmail } });

  return (
    <SectionCard title="Basic" seal="internal" visibleTo="everyone in the company (staff directory)" canEdit={view.access.edit.basic} viewOnly={HR_EDITS} editing={editing} onEdit={() => setEditing(true)}>
      {isLive("m3") && <PhotoControl view={view} />}
      {!editing ? (
        <DetailList
          columns={2}
          items={[
            ["Full name", e.name],
            ["Emp-ID", <span key="i"><span className="font-mono font-semibold">{e.empId}</span> <span className="text-[12px] text-muted-foreground">· never changes</span></span>],
            ["Designation", e.designation],
            ["Department", lookup.department(e.departmentId)?.name],
            ["Office", lookup.office(e.officeId)?.name],
            ["Official email", <a key="m" href={`mailto:${e.officialEmail}`} className="text-primary hover:underline">{e.officialEmail}</a>],
          ]}
        />
      ) : (
        <form
          onSubmit={form.handleSubmit(async (values) => {
            try {
              await update.mutateAsync({ empId: e.empId, patch: values });
              toast.success("Basic details saved", { description: "The old values are kept in History." });
              setEditing(false);
            } catch (x) {
              err(x);
            }
          })}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Full name" htmlFor="b-name" error={form.formState.errors.name?.message} required>
              <Input id="b-name" {...form.register("name")} aria-invalid={!!form.formState.errors.name} />
            </Field>
            <Field label="Designation" htmlFor="b-des" error={form.formState.errors.designation?.message} required>
              <Input id="b-des" {...form.register("designation")} />
            </Field>
            <Field label="Department" htmlFor="b-dep">
              <NativeSelect id="b-dep" {...form.register("departmentId")}>
                {lookup.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </NativeSelect>
            </Field>
            <Field label="Office" htmlFor="b-off">
              <NativeSelect id="b-off" {...form.register("officeId")}>
                {lookup.offices.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
              </NativeSelect>
            </Field>
            <Field label="Official email" htmlFor="b-mail" error={form.formState.errors.officialEmail?.message} className="sm:col-span-2">
              <Input id="b-mail" {...form.register("officialEmail")} />
            </Field>
          </div>
          <FormActions onCancel={() => { form.reset(); setEditing(false); }} saving={update.isPending} />
        </form>
      )}
    </SectionCard>
  );
}

/* ---------------- Job ---------------- */

const jobSchema = z.object({
  level: z.number().int().min(1).max(5),
  reportsTo: z.string(),
  joiningDate: z.string().min(1, "Choose a date."),
  type: z.enum(["full_time", "part_time", "intern"]),
  status: z.enum(["active", "on_notice"]),
  weeklyCapacityHours: z.number({ message: "Enter hours." }).min(4, "At least 4 hours.").max(60, "At most 60 hours."),
});

export function JobSection({ view }: { view: ProfileView }) {
  const e = view.employee;
  const update = useUpdateJob();
  const askReason = useReason();
  // Levels and reporting lines follow the fixed structure and only the Director (org.manage) changes them (spec §2.1).
  const canMoveLevel = useCan("org.manage");
  const viewer = useViewer();
  const levelOptions = [...new Set([e.level, ...hireLevels(viewer?.employee.level ?? 5, e.departmentId)])].sort((a, b) => a - b) as Level[];
  const [editing, setEditing] = React.useState(false);
  const form = useForm<z.infer<typeof jobSchema>>({
    resolver: zodResolver(jobSchema),
    values: { level: e.level, reportsTo: e.reportsTo ?? "", joiningDate: isoDay(e.joiningDate), type: e.type, status: e.status === "left" ? "active" : e.status, weeklyCapacityHours: e.weeklyCapacityHours },
  });
  const level = form.watch("level") as Level;

  return (
    <SectionCard title="Job" seal="internal" visibleTo={`${view.access.isSelf ? "you" : e.name.split(" ")[0]}, the managers above in the reporting line, the Director (HR duty) and the CEO / Founder / Owner`} canEdit={view.access.edit.job && e.status !== "left"} viewOnly={HR_EDITS} editing={editing} onEdit={() => setEditing(true)}>
      {!editing ? (
        <DetailList
          columns={2}
          items={[
            ["Level", <LevelMark key="l" level={e.level} showLabel />],
            ["Reports to", e.reportsTo ? <EmpChip empId={e.reportsTo} size="sm" /> : "Nobody (top of the company)"],
            ["Joining date", formatDate(e.joiningDate)],
            ["Type", TYPE_LABEL[e.type]],
            ["Status", <StatusBadge key="s" {...STATUS_INFO[e.status]} />],
            ["Weekly capacity", `${e.weeklyCapacityHours} hours (used by task workload)`],
            ...(e.lastWorkingDay ? ([["Last working day", formatDate(e.lastWorkingDay)]] as [string, string][]) : []),
          ]}
        />
      ) : (
        <form
          onSubmit={form.handleSubmit(async (values) => {
            const reason = await askReason({ title: "Why are you changing job details?", description: "Every change keeps the old value in History, with your reason." });
            if (!reason) return;
            try {
              await update.mutateAsync({ empId: e.empId, patch: { ...values, level: values.level as Level, reportsTo: values.reportsTo || undefined, joiningDate: new Date(`${values.joiningDate}T09:00`).toISOString() }, reason });
              toast.success("Job details saved");
              setEditing(false);
            } catch (x) {
              err(x);
            }
          })}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Level" htmlFor="j-level" hint={canMoveLevel ? "The role follows the level and the department." : "Only the Director changes levels."}>
              {canMoveLevel ? (
                <NativeSelect id="j-level" {...form.register("level", { valueAsNumber: true, onChange: () => form.setValue("reportsTo", "", { shouldDirty: true }) })}>
                  {levelOptions.map((l) => <option key={l} value={l}>Level {l} · {LEVEL_LABEL[l]}</option>)}
                </NativeSelect>
              ) : (
                <div className="rounded-lg border border-border bg-muted/40 px-3 py-2">
                  <LevelMark level={e.level} showLabel />
                </div>
              )}
            </Field>
            <Field label="Reports to" htmlFor="j-boss" hint={canMoveLevel ? REPORTS_TO_HINT[level] : "Only the Director changes reporting lines."}>
              {canMoveLevel ? (
                <EmployeeSelect
                  id="j-boss"
                  value={form.watch("reportsTo")}
                  onChange={(v) => form.setValue("reportsTo", v, { shouldDirty: true })}
                  filter={(x) => x.level === reportsToLevel(level) && x.empId !== e.empId}
                />
              ) : (
                <div className="rounded-lg border border-border bg-muted/40 px-3 py-2">
                  {e.reportsTo ? <EmpChip empId={e.reportsTo} size="sm" link={false} /> : "Nobody"}
                </div>
              )}
            </Field>
            <Field label="Joining date" htmlFor="j-join" error={form.formState.errors.joiningDate?.message}>
              <Input id="j-join" type="date" {...form.register("joiningDate")} />
            </Field>
            <Field label="Type" htmlFor="j-type">
              <NativeSelect id="j-type" {...form.register("type")}>
                {Object.entries(TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </NativeSelect>
            </Field>
            <Field label="Status" htmlFor="j-status" hint="To record leaving, use “Set last working day”.">
              <NativeSelect id="j-status" {...form.register("status")}>
                <option value="active">Active</option>
                <option value="on_notice">On notice</option>
              </NativeSelect>
            </Field>
            <Field label="Weekly capacity (hours)" htmlFor="j-cap" error={form.formState.errors.weeklyCapacityHours?.message}>
              <Input id="j-cap" type="number" {...form.register("weeklyCapacityHours", { valueAsNumber: true })} />
            </Field>
          </div>
          <FormActions onCancel={() => { form.reset(); setEditing(false); }} saving={update.isPending} note="You'll be asked for a reason." />
        </form>
      )}
    </SectionCard>
  );
}

/* ---------------- Personal ---------------- */

const phoneRe = /^\+?[\d\s-]{10,16}$/;
const personalSchema = z.object({
  cnic: z.string().trim().regex(/^(\d{5}-\d{7}-\d)?$/, "Use the format 42101-1234567-1."),
  phone: z.string().trim().regex(phoneRe, "Enter a valid phone number."),
  address: z.string().trim().min(8, "Enter the full address."),
  ecName: z.string().trim().min(2, "Enter a name."),
  ecRelation: z.string().trim().min(2, "Enter the relation."),
  ecPhone: z.string().trim().regex(phoneRe, "Enter a valid phone number."),
});

export function PersonalSection({ view }: { view: ProfileView }) {
  const e = view.employee;
  const p = view.personal;
  const update = useUpdatePersonal();
  const reveal = useRevealField();
  const [editing, setEditing] = React.useState(false);
  const mode = view.access.edit.personal;
  const form = useForm<z.infer<typeof personalSchema>>({
    resolver: zodResolver(personalSchema),
    values: { cnic: p?.cnic?.includes("*") ? "" : p?.cnic || "00000-0000000-0", phone: p?.phone ?? "", address: p?.address ?? "", ecName: p?.emergencyContact.name ?? "", ecRelation: p?.emergencyContact.relation ?? "", ecPhone: p?.emergencyContact.phone ?? "" },
  });
  if (!p) return null;
  const fe = form.formState.errors;

  return (
    <SectionCard
      title="Personal"
      seal="confidential"
      visibleTo={`${view.access.isSelf ? "you" : e.name.split(" ")[0]}, the Director (HR duty) and the CEO / Founder / Owner`}
      canEdit={mode !== "none"}
      viewOnly={HR_EDITS}
      editLabel={mode === "contact" ? "Edit my contact details" : "Edit"}
      editing={editing}
      onEdit={() => setEditing(true)}
    >
      {!editing ? (
        <DetailList
          columns={2}
          items={[
            ["CNIC", <LoggedMaskedValue key="c" value={p.cnic} label="CNIC" canReveal={view.access.revealCnic} onReveal={() => reveal.mutateAsync({ empId: e.empId, field: "cnic" })} />],
            ["Phone", p.phone || "—"],
            ["Home address", p.address || "—"],
            ["Emergency contact", p.emergencyContact.name ? `${p.emergencyContact.name} (${p.emergencyContact.relation}) · ${p.emergencyContact.phone}` : "—"],
          ]}
        />
      ) : (
        <form
          onSubmit={form.handleSubmit(async (v) => {
            try {
              await update.mutateAsync({
                empId: e.empId,
                patch: { ...(mode === "all" && v.cnic ? { cnic: v.cnic } : {}), phone: v.phone, address: v.address, emergencyContact: { name: v.ecName, relation: v.ecRelation, phone: v.ecPhone } },
              });
              toast.success("Personal details saved", { description: "The old values are kept in History." });
              setEditing(false);
            } catch (x) {
              err(x);
            }
          })}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            {mode === "all" ? (
              <Field label="CNIC" htmlFor="p-cnic" error={fe.cnic?.message}>
                <Input id="p-cnic" className="font-mono" {...form.register("cnic")} />
              </Field>
            ) : (
              <p className="self-end text-[12.5px] text-muted-foreground sm:col-span-2">You can update your phone, address and emergency contact. Ask the Director (HR duty) to change your CNIC.</p>
            )}
            <Field label="Phone" htmlFor="p-phone" error={fe.phone?.message}>
              <Input id="p-phone" inputMode="tel" {...form.register("phone")} />
            </Field>
            <Field label="Home address" htmlFor="p-addr" error={fe.address?.message} className="sm:col-span-2">
              <Textarea id="p-addr" rows={2} {...form.register("address")} />
            </Field>
            <Field label="Emergency contact name" htmlFor="p-ecn" error={fe.ecName?.message}>
              <Input id="p-ecn" {...form.register("ecName")} />
            </Field>
            <Field label="Relation" htmlFor="p-ecr" error={fe.ecRelation?.message}>
              <Input id="p-ecr" {...form.register("ecRelation")} />
            </Field>
            <Field label="Emergency contact phone" htmlFor="p-ecp" error={fe.ecPhone?.message}>
              <Input id="p-ecp" inputMode="tel" {...form.register("ecPhone")} />
            </Field>
          </div>
          <FormActions onCancel={() => { form.reset(); setEditing(false); }} saving={update.isPending} />
        </form>
      )}
    </SectionCard>
  );
}

/* ---------------- Pay ---------------- */

const paySchema = z.object({
  baseSalary: z.number({ message: "Enter an amount." }).min(1, "Enter an amount."),
  allowances: z.array(z.object({ name: z.string().trim().min(2, "Name it."), amount: z.number({ message: "Amount" }).min(0) })),
  bankName: z.string().trim().min(2, "Enter the bank."),
  accountNumber: z.string().trim().min(8, "Enter the account number."),
});

export function PaySection({ view }: { view: ProfileView }) {
  const e = view.employee;
  const pay = view.pay;
  const update = useUpdatePay();
  const reveal = useRevealField();
  const stepUp = useStepUp();
  const askReason = useReason();
  const [editing, setEditing] = React.useState(false);
  const self = view.access.isSelf;
  const live = isLive("m3");
  // Live: salary amounts are not in the profile. They arrive only through the logged reveal (also to prefill this form).
  const [revealed, setRevealed] = React.useState<{ value: string; allowances: string } | null>(null);
  const form = useForm<z.infer<typeof paySchema>>({
    resolver: zodResolver(paySchema),
    values: {
      baseSalary: live ? Number(revealed?.value ?? 0) : pay ? toNumber(pay.baseSalary) : 0,
      allowances: live ? (Number(revealed?.allowances ?? 0) > 0 ? [{ name: "Allowances", amount: Number(revealed!.allowances) }] : []) : (pay?.allowances.map((a) => ({ name: a.name, amount: toNumber(a.amount) })) ?? []),
      bankName: pay?.bankName ?? "",
      accountNumber: pay?.accountNumber ?? "",
    },
  });
  const allowances = form.watch("allowances");

  const startEdit = async () => {
    if (!(await stepUp({ action: `Edit pay for ${e.name}`, detail: "Pay changes are highly confidential and logged." }))) return;
    if (live && pay?.salaryOnFile) {
      try {
        setRevealed(await livePeopleApi.revealSalary(e.empId)); // logged on the server
      } catch (err) {
        return void toast.error(err instanceof Error ? err.message : "Couldn't load the salary.");
      }
    }
    setEditing(true);
  };

  const total = pay ? toNumber(pay.baseSalary) + pay.allowances.reduce((s, a) => s + toNumber(a.amount), 0) : 0;
  const amount = (n: number, label: string, part: "base" | "allowances" | "gross" = "base") =>
    self && !live ? (
      <Money value={n} />
    ) : live ? (
      // Live: nothing is in the page until the person shows it; each showing is logged on the server.
      <LoggedMaskedValue
        value="hidden"
        display="PKR ••••••"
        label={label}
        canReveal={view.access.revealPay}
        stepUp
        onReveal={async () => {
          const r = await livePeopleApi.revealSalary(e.empId);
          return formatMoney(part === "base" ? Number(r.value) : part === "allowances" ? Number(r.allowances) : Number(r.value) + Number(r.allowances));
        }}
      />
    ) : (
      <LoggedMaskedValue value={formatMoney(n)} display="PKR ••••••" label={label} canReveal={view.access.revealPay} stepUp onReveal={() => reveal.mutateAsync({ empId: e.empId, field: "salary" }).then((v) => (typeof v === "string" ? formatMoney(Number(v)) : undefined))} />
    );

  return (
    <SectionCard
      title="Pay"
      seal="highly"
      visibleTo={self ? "you (your own only), the Director, Finance (for payroll) and the CEO / Founder / Owner" : "the employee, the Director, Finance (for payroll) and the CEO / Founder / Owner"}
      canEdit={view.access.edit.pay}
      viewOnly="View only. The Director edits pay."
      editing={editing}
      onEdit={startEdit}
      editLabel={pay ? "Edit pay" : "Add pay"}
    >
      {!editing ? (
        pay ? (
          <DetailList
            columns={2}
            items={[
              ["Base salary (monthly)", amount(toNumber(pay.baseSalary), "base salary")],
              ["Allowances", pay.allowances.length ? <span key="a" className="grid gap-0.5">{pay.allowances.map((a) => <span key={a.name}>{a.name}: {amount(toNumber(a.amount), `${a.name} allowance`, "allowances")}</span>)}</span> : "None"],
              ["Gross monthly", amount(total, "gross pay", "gross")],
              ["Bank", pay.bankName],
              ["Account number", <LoggedMaskedValue key="ac" value={pay.accountNumber} label="bank account" canReveal={view.access.revealPay} stepUp onReveal={() => reveal.mutateAsync({ empId: e.empId, field: "account" })} />],
            ]}
          />
        ) : (
          <EmptyState compact title="No pay details yet" description="The Director adds pay details. Payroll can't include this person until then." />
        )
      ) : (
        <form
          onSubmit={form.handleSubmit(async (v) => {
            const reason = await askReason({ title: "Why is pay changing?", description: "Saved with the change. Pay history is highly confidential." });
            if (!reason) return;
            try {
              await update.mutateAsync({ empId: e.empId, patch: v, reason });
              toast.success("Pay saved", { description: "Payroll uses the new values from the next run." });
              setEditing(false);
            } catch (x) {
              err(x);
            }
          })}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Base salary (PKR / month)" htmlFor="pay-base" error={form.formState.errors.baseSalary?.message}>
              <Input id="pay-base" type="number" className="font-mono" {...form.register("baseSalary", { valueAsNumber: true })} />
            </Field>
            <div className="grid gap-2 sm:col-span-2">
              <p className="text-[13px] font-medium">Allowances</p>
              {allowances.map((_, i) => (
                <div key={i} className="flex items-start gap-2">
                  <Input placeholder="Name" aria-label="Allowance name" {...form.register(`allowances.${i}.name`)} />
                  <Input placeholder="Amount" type="number" className="w-40 font-mono" aria-label="Allowance amount" {...form.register(`allowances.${i}.amount`, { valueAsNumber: true })} />
                  <Button type="button" size="icon" variant="ghost" aria-label="Remove allowance" onClick={() => form.setValue("allowances", allowances.filter((__, j) => j !== i))}>
                    <Trash2 />
                  </Button>
                </div>
              ))}
              <Button type="button" size="sm" variant="ghost" className="w-fit" onClick={() => form.setValue("allowances", [...allowances, { name: "", amount: 0 }])}>
                <Plus /> Add allowance
              </Button>
            </div>
            <Field label="Bank" htmlFor="pay-bank" error={form.formState.errors.bankName?.message}>
              <Input id="pay-bank" {...form.register("bankName")} />
            </Field>
            <Field label="Account number" htmlFor="pay-acc" error={form.formState.errors.accountNumber?.message}>
              <Input id="pay-acc" className="font-mono" {...form.register("accountNumber")} />
            </Field>
          </div>
          <FormActions onCancel={() => { form.reset(); setEditing(false); }} saving={update.isPending} label="Save pay" note="Encrypted at rest. You'll be asked for a reason." />
        </form>
      )}
    </SectionCard>
  );
}

/* ---------------- Documents ---------------- */

export function DocumentsSection({ view }: { view: ProfileView }) {
  const e = view.employee;
  const upload = useUploadDocument();
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [kind, setKind] = React.useState<DocumentKind>("certificate");
  const docs = view.documents ?? [];

  return (
    <SectionCard
      title="Documents"
      seal="confidential"
      visibleTo={`${view.access.isSelf ? "you" : e.name.split(" ")[0]}, the Director (HR duty) and the CEO / Founder / Owner. ${isLive("m3") ? "Files open through the server, which checks permission and logs each download" : "Files open through links that expire in minutes"}`}
      viewOnly={view.access.edit.documents ? undefined : "View only. The Director (HR duty) adds documents."}
      actions={
        view.access.edit.documents && (
          <div className="flex items-center gap-2">
            <NativeSelect value={kind} onChange={(ev) => setKind(ev.target.value as DocumentKind)} className="w-36" aria-label="Document type">
              {Object.entries(DOC_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </NativeSelect>
            <Button size="sm" onClick={() => inputRef.current?.click()} loading={upload.isPending}>
              <FileUp /> Upload
            </Button>
            <input
              ref={inputRef}
              type="file"
              accept=".pdf,.jpg,.jpeg,.png,.docx"
              className="sr-only"
              onChange={async (ev) => {
                const f = ev.target.files?.[0];
                ev.target.value = "";
                if (!f) return;
                if (f.size > 10 * 1024 * 1024) return toast.error("Files must be 10 MB or smaller.");
                try {
                  await upload.mutateAsync({ empId: e.empId, file: { kind, fileName: f.name, sizeBytes: f.size, blob: f } });
                  toast.success(`${f.name} uploaded`, { description: `${DOC_LABEL[kind]} · ${formatBytes(f.size)}. Stored in private file storage.` });
                } catch (err) {
                  toast.error(err instanceof Error ? err.message : "Couldn't upload the file.");
                }
              }}
            />
          </div>
        )
      }
    >
      {docs.length ? (
        <ul className="grid gap-3 sm:grid-cols-2">
          {docs.map((d) => (
            <li key={d.id} className="grid gap-1">
              <FileCard
                file={d}
                onOpen={() => {
                  if (!isLive("m3")) return toast("Opening a private link (demo)", { description: "Real links expire in a few minutes." });
                  livePeopleApi.downloadDocument(e.empId, d.id, d.fileName).catch((err) => toast.error(err instanceof Error ? err.message : "Couldn't open the file."));
                }}
              />
              <p className="flex items-center gap-2 px-1 text-[11.5px] text-muted-foreground">
                <Badge tone="outline">{DOC_LABEL[d.kind]}</Badge> Added {formatDate(d.uploadedAt)}
              </p>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState compact title="No documents yet" description="CV, contract, CNIC copy and certificates appear here." />
      )}
    </SectionCard>
  );
}

/* ---------------- History ---------------- */

export function HistorySection({ view, employee }: { view: ProfileView; employee: Employee }) {
  const list = view.history ?? [];
  return (
    <SectionCard title="Change history" visibleTo="the same people who can see each section. Nobody can edit or delete history">
      {list.length ? (
        <Timeline
          items={list.map((h) => ({
            id: h.id,
            icon: <History />,
            color: h.section === "pay" ? "var(--seal-highly)" : h.section === "personal" ? "var(--seal-confidential)" : "var(--zone-control)",
            title: (
              <span>
                {h.field}: <span className="text-muted-foreground line-through decoration-muted-foreground/50">{h.oldValue}</span> → <span>{h.newValue}</span>
              </span>
            ),
            meta: (
              <span className="inline-flex flex-wrap items-center gap-1.5">
                <Badge tone="outline" className="capitalize">{h.section}</Badge> by <EmpChip empId={h.changedBy} size="sm" showId={false} />
                {h.reason && <span>· “{h.reason}”</span>}
              </span>
            ),
            time: <span title={formatDateTime(h.changedAt)}>{formatRelative(h.changedAt)}</span>,
          }))}
        />
      ) : (
        <EmptyState compact title="No changes yet" description={`Changes to ${employee.name.split(" ")[0]}'s profile will appear here with the old and new values.`} />
      )}
    </SectionCard>
  );
}
