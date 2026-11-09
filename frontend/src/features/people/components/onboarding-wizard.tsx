"use client";
import * as React from "react";
import Link from "next/link";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import { ArrowLeft, ArrowRight, Check, MailCheck, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { NativeSelect } from "@/components/ui/controls";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/layout/page-header";
import { RequireAccess } from "@/components/shared/can";
import { LevelMark } from "@/components/shared/level-mark";
import { Money } from "@/components/shared/money";
import { DetailList, EmployeeSelect } from "@/components/shared/pickers";
import { useLookup } from "@/hooks/use-directory";
import { LEVEL_LABEL } from "@/lib/auth/permissions";
import { useCan } from "@/lib/auth/viewer";
import { formatDate, isoDay } from "@/lib/dates";
import { maskTail } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { Level } from "@/types";
import { useCreateEmployee } from "../hooks";
import { capacityFor, suggestEmail, TYPE_LABEL } from "../logic";

const schema = z.object({
  name: z.string().trim().min(3, "Enter the full name."),
  designation: z.string().trim().min(2, "Enter a designation."),
  departmentId: z.string().min(1, "Choose a department."),
  officeId: z.string().min(1, "Choose an office."),
  officialEmail: z.string().trim().email("Enter a valid email.").refine((v) => v.endsWith("@acevatech.com"), "Use an @acevatech.com address."),
  level: z.number().int().min(2).max(5),
  reportsTo: z.string().min(1, "Choose who they report to."),
  joiningDate: z.string().min(1, "Choose a date."),
  type: z.enum(["full_time", "part_time", "intern"]),
  addPay: z.boolean(),
  baseSalary: z.number().optional(),
  allowanceName: z.string().optional(),
  allowanceAmount: z.number().optional(),
  bankName: z.string().optional(),
  accountNumber: z.string().optional(),
});
type Values = z.infer<typeof schema>;

const STEPS = ["Basic", "Job", "Pay", "Review"] as const;
const STEP_FIELDS: (keyof Values)[][] = [
  ["name", "designation", "departmentId", "officeId", "officialEmail"],
  ["level", "reportsTo", "joiningDate", "type"],
  ["baseSalary", "bankName", "accountNumber"],
  [],
];

/** /people/new: 4-step onboarding (spec §9.3). */
export function OnboardingWizard() {
  return (
    <RequireAccess permission="people.manage">
      <PageHeader zone="work" eyebrow="People" title="Add an employee" description="The system creates the Emp-ID and emails a welcome message with a temporary password." back={{ href: "/people", label: "People" }} seal="confidential" />
      <Wizard />
    </RequireAccess>
  );
}

function Wizard() {
  const lookup = useLookup();
  const canPay = useCan("people.manage_pay");
  const create = useCreateEmployee();
  const [step, setStep] = React.useState(0);
  const [done, setDone] = React.useState<{ empId: string; email: string; name: string; payPending: boolean } | null>(null);
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: "", designation: "", departmentId: "", officeId: "", officialEmail: "", level: 5, reportsTo: "", joiningDate: isoDay(new Date()), type: "full_time",
      addPay: canPay, bankName: "", accountNumber: "", allowanceName: "Internet",
    },
  });
  const { register, watch, setValue, formState } = form;
  const errors = formState.errors;
  const v = watch();

  // Suggest the official email from the name until the user edits it.
  const emailTouched = React.useRef(false);
  React.useEffect(() => {
    if (!emailTouched.current) setValue("officialEmail", suggestEmail(v.name, lookup.employees.map((e) => e.officialEmail)));
  }, [v.name, lookup.employees, setValue]);

  const next = async () => {
    if (step === 2 && v.addPay) {
      const missing: [keyof Values, string][] = [];
      if (!v.baseSalary || v.baseSalary <= 0) missing.push(["baseSalary", "Enter the monthly base salary."]);
      if (!v.bankName?.trim()) missing.push(["bankName", "Enter the bank."]);
      if (!v.accountNumber || v.accountNumber.trim().length < 8) missing.push(["accountNumber", "Enter the account number."]);
      missing.forEach(([k, message]) => form.setError(k, { message }));
      if (missing.length) return;
    } else if (!(await form.trigger(STEP_FIELDS[step]))) return;
    setStep((s) => s + 1);
  };

  const submit = form.handleSubmit(async (values) => {
    try {
      const res = await create.mutateAsync({
        name: values.name,
        designation: values.designation,
        departmentId: values.departmentId,
        officeId: values.officeId,
        officialEmail: values.officialEmail,
        level: values.level as Level,
        reportsTo: values.reportsTo,
        joiningDate: new Date(`${values.joiningDate}T09:00`).toISOString(),
        type: values.type,
        pay: values.addPay && values.baseSalary
          ? { baseSalary: values.baseSalary, allowanceName: values.allowanceName || undefined, allowanceAmount: values.allowanceAmount || undefined, bankName: values.bankName ?? "", accountNumber: values.accountNumber ?? "" }
          : undefined,
      });
      setDone({ empId: res.empId, email: values.officialEmail, name: values.name, payPending: res.payPending });
      toast.success(`${res.empId} created`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't create the employee.");
    }
  });

  if (done) {
    return (
      <Card className="mx-auto max-w-xl">
        <CardContent className="grid justify-items-center gap-3 py-10 text-center">
          <span className="grid size-14 place-content-center rounded-2xl bg-success/12 text-success">
            <MailCheck className="size-7" />
          </span>
          <p className="text-xl font-semibold tracking-tight">Emp-ID <span className="font-mono">{done.empId}</span> created</p>
          <p className="max-w-md text-[13.5px] text-muted-foreground">
            A welcome email with a temporary password was sent to <span className="font-medium text-foreground">{done.email}</span>. {done.name.split(" ")[0]} sets a new password and accepts the tracking policy at first login.
          </p>
          {done.payPending && <p className="rounded-lg bg-warning/12 px-3 py-2 text-[12.5px]">Pay details are still missing. The Director adds them on the profile&apos;s Pay tab.</p>}
          <div className="mt-3 flex flex-wrap justify-center gap-2">
            <Button asChild>
              <Link href={`/people/${done.empId}`}>Open profile</Link>
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                form.reset();
                emailTouched.current = false;
                setStep(0);
                setDone(null);
              }}
            >
              <UserPlus /> Add another
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  const level = v.level as Level;

  return (
    <div className="mx-auto grid max-w-3xl gap-6">
      <ol className="flex items-center gap-2" aria-label="Steps">
        {STEPS.map((s, i) => (
          <li key={s} className="flex flex-1 items-center gap-2">
            <span className={cn("grid size-7 shrink-0 place-content-center rounded-full text-[12px] font-bold", i < step ? "bg-success text-white" : i === step ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground")}>
              {i < step ? <Check className="size-4" strokeWidth={3} /> : i + 1}
            </span>
            <span className={cn("hidden truncate text-[13px] font-medium sm:inline", i === step ? "text-foreground" : "text-muted-foreground")}>{s}</span>
            {i < STEPS.length - 1 && <span className="h-px flex-1 bg-border" />}
          </li>
        ))}
      </ol>

      <Card>
        <CardContent className="pt-6">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (step < 3) next();
              else submit();
            }}
          >
            {step === 0 && (
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Full name" htmlFor="o-name" error={errors.name?.message} required>
                  <Input id="o-name" autoFocus {...register("name")} />
                </Field>
                <Field label="Designation" htmlFor="o-des" error={errors.designation?.message} required>
                  <Input id="o-des" placeholder="Software Developer" {...register("designation")} />
                </Field>
                <Field label="Department" htmlFor="o-dep" error={errors.departmentId?.message} required>
                  <NativeSelect id="o-dep" {...register("departmentId")}>
                    <option value="">Choose a department</option>
                    {lookup.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                  </NativeSelect>
                </Field>
                <Field label="Office" htmlFor="o-off" error={errors.officeId?.message} required>
                  <NativeSelect id="o-off" {...register("officeId")}>
                    <option value="">Choose an office</option>
                    {lookup.offices.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                  </NativeSelect>
                </Field>
                <Field label="Official email" htmlFor="o-mail" error={errors.officialEmail?.message} hint="Suggested from the name. The welcome email goes here." required className="sm:col-span-2">
                  <Input id="o-mail" {...register("officialEmail", { onChange: () => (emailTouched.current = true) })} />
                </Field>
                <p className="text-[12.5px] text-muted-foreground sm:col-span-2">The Emp-ID is assigned on save, in order (for example ACV-0015). It never changes and is never reused.</p>
              </div>
            )}

            {step === 1 && (
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Level" htmlFor="o-level" required>
                  <NativeSelect id="o-level" {...register("level", { valueAsNumber: true, onChange: () => setValue("reportsTo", "") })}>
                    {[2, 3, 4, 5].map((l) => <option key={l} value={l}>Level {l} · {LEVEL_LABEL[l]}</option>)}
                  </NativeSelect>
                </Field>
                <Field label="Reports to" htmlFor="o-boss" error={errors.reportsTo?.message} required hint="Someone at a higher level.">
                  <EmployeeSelect id="o-boss" value={v.reportsTo} onChange={(x) => setValue("reportsTo", x, { shouldValidate: true })} filter={(e) => e.level < level} invalid={!!errors.reportsTo} />
                </Field>
                <Field label="Joining date" htmlFor="o-join" error={errors.joiningDate?.message} required>
                  <Input id="o-join" type="date" {...register("joiningDate")} />
                </Field>
                <Field label="Type" htmlFor="o-type" hint={`Weekly capacity: ${capacityFor(v.type)} hours.`}>
                  <NativeSelect id="o-type" {...register("type")}>
                    {Object.entries(TYPE_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                  </NativeSelect>
                </Field>
              </div>
            )}

            {step === 2 &&
              (canPay ? (
                <div className="grid gap-4">
                  <label className="flex items-center gap-2 text-[13px]">
                    <input type="checkbox" className="size-4 accent-[var(--primary)]" {...register("addPay")} /> Add pay details now
                  </label>
                  {v.addPay && (
                    <div className="grid gap-4 sm:grid-cols-2">
                      <Field label="Base salary (PKR / month)" htmlFor="o-base" error={errors.baseSalary?.message} required>
                        <Input id="o-base" type="number" className="font-mono" {...register("baseSalary", { setValueAs: (x) => (x === "" ? undefined : Number(x)) })} />
                      </Field>
                      <div className="grid grid-cols-[1fr_8rem] gap-2">
                        <Field label="Allowance" htmlFor="o-alw">
                          <Input id="o-alw" {...register("allowanceName")} />
                        </Field>
                        <Field label="Amount" htmlFor="o-alwa">
                          <Input id="o-alwa" type="number" className="font-mono" {...register("allowanceAmount", { setValueAs: (x) => (x === "" ? undefined : Number(x)) })} />
                        </Field>
                      </div>
                      <Field label="Bank" htmlFor="o-bank" error={errors.bankName?.message} required>
                        <Input id="o-bank" {...register("bankName")} />
                      </Field>
                      <Field label="Account number" htmlFor="o-acc" error={errors.accountNumber?.message} required>
                        <Input id="o-acc" className="font-mono" {...register("accountNumber")} />
                      </Field>
                    </div>
                  )}
                </div>
              ) : (
                <div className="rounded-xl border border-dashed border-border bg-muted/40 p-5 text-[13.5px]">
                  <p className="font-medium">Pay details are added by the Director.</p>
                  <p className="mt-1 text-muted-foreground">You can finish onboarding now. The Director will see “Pay details missing” on the profile and add them before the next payroll run.</p>
                </div>
              ))}

            {step === 3 && (
              <div className="grid gap-6">
                <DetailList
                  columns={2}
                  items={[
                    ["Name", v.name],
                    ["Designation", v.designation],
                    ["Department", lookup.department(v.departmentId)?.name],
                    ["Office", lookup.office(v.officeId)?.name],
                    ["Official email", v.officialEmail],
                    ["Level", <LevelMark key="l" level={level} showLabel />],
                    ["Reports to", lookup.employee(v.reportsTo)?.name],
                    ["Joining date", formatDate(`${v.joiningDate}T09:00`)],
                    ["Type", `${TYPE_LABEL[v.type]} · ${capacityFor(v.type)} h / week`],
                    ["Pay", v.addPay && v.baseSalary ? <span key="p"><Money value={v.baseSalary} /> · {v.bankName} {v.accountNumber ? maskTail(v.accountNumber) : ""}</span> : "Added later by the Director"],
                    ["Emp-ID", <span key="e" className="text-muted-foreground">Assigned on save</span>],
                  ]}
                />
                <p className="rounded-lg bg-muted px-3 py-2 text-[12.5px] text-muted-foreground">On save: the Emp-ID is created, a welcome email with a temporary password is sent, and the change is saved in the audit log.</p>
              </div>
            )}

            <div className="mt-6 flex items-center justify-between gap-2 border-t border-border pt-4">
              <Button type="button" variant="ghost" onClick={() => setStep((s) => s - 1)} disabled={step === 0}>
                <ArrowLeft /> Back
              </Button>
              {step < 3 ? (
                <Button type="submit">
                  Continue <ArrowRight />
                </Button>
              ) : (
                <Button type="submit" loading={create.isPending}>
                  <UserPlus /> Create employee
                </Button>
              )}
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
