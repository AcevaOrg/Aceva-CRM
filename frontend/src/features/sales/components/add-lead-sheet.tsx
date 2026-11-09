"use client";
import * as React from "react";
import Link from "next/link";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import { ArrowRight, CircleCheck, LoaderCircle, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/controls";
import { Field } from "@/components/ui/field";
import { Input, Textarea } from "@/components/ui/input";
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { EmpChip } from "@/components/shared/emp-chip";
import { domainOf, EMAIL_RE, SOURCE_LABEL } from "../logic";
import { useCreateLead, useDuplicateCheck } from "../hooks";
import type { LeadSource } from "../types";

export const COUNTRIES = ["United Kingdom", "United States", "United Arab Emirates", "Pakistan", "Canada", "Australia", "Saudi Arabia", "Other"];

const schema = z.object({
  name: z.string().trim().min(2, "Enter the person's name."),
  title: z.string().optional(),
  companyName: z.string().trim().min(2, "Enter the company name."),
  website: z.string().optional(),
  email: z.string().trim().refine((v) => !v || EMAIL_RE.test(v), "Enter a valid email address.").optional(),
  phone: z.string().optional(),
  linkedinUrl: z.string().optional(),
  country: z.string().optional(),
  industry: z.string().optional(),
  source: z.enum(["apollo", "fiverr", "linkedin", "referral", "website", "field", "walk_in"]),
  notes: z.string().optional(),
});
type FormValues = z.infer<typeof schema>;

function useDebounced<T>(value: T, ms = 400) {
  const [v, setV] = React.useState(value);
  React.useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function AddLeadSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const form = useForm<FormValues>({ resolver: zodResolver(schema), defaultValues: { source: "apollo", country: "United Kingdom" } });
  const { register, handleSubmit, formState, reset, control } = form;
  const create = useCreateLead();
  const email = useWatch({ control, name: "email" }) ?? "";
  const website = useWatch({ control, name: "website" }) ?? "";
  const debounced = useDebounced({ email: email.trim(), website: website.trim() });
  const checkable = EMAIL_RE.test(debounced.email) || domainOf(debounced.website).includes(".");
  const dup = useDuplicateCheck(debounced, open && checkable);
  const duplicate = checkable && dup.data?.duplicate ? dup.data : null;

  React.useEffect(() => {
    if (!open) reset({ source: "apollo", country: "United Kingdom" });
  }, [open, reset]);

  const onSubmit = (v: FormValues) =>
    create.mutate(
      { ...v, source: v.source as LeadSource },
      {
        onSuccess: (lead) => {
          toast.success(`${lead.name} added`, { description: lead.doNotContact ? "This email is on the do-not-contact list, so it is blocked from sequences." : "Owner: you. Verify the email before adding it to a sequence." });
          onOpenChange(false);
        },
        onError: (e) => toast.error(e instanceof Error ? e.message : "Couldn't add the lead."),
      },
    );

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent size="lg">
        <SheetHeader>
          <SheetTitle>Add a lead</SheetTitle>
          <SheetDescription>One owner, no duplicates: the email and the company&apos;s website are checked against every lead as you type.</SheetDescription>
        </SheetHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="flex min-h-0 flex-1 flex-col">
          <SheetBody className="grid content-start gap-4">
            <DuplicateBanner checking={checkable && dup.isFetching} duplicate={duplicate} checked={checkable && !!dup.data && !dup.data.duplicate} />
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Name" htmlFor="ld-name" required error={formState.errors.name?.message}>
                <Input id="ld-name" autoFocus {...register("name")} aria-invalid={!!formState.errors.name} />
              </Field>
              <Field label="Job title" htmlFor="ld-title">
                <Input id="ld-title" {...register("title")} />
              </Field>
              <Field label="Email" htmlFor="ld-email" error={formState.errors.email?.message}>
                <Input id="ld-email" type="email" placeholder="name@company.com" {...register("email")} aria-invalid={!!formState.errors.email} />
              </Field>
              <Field label="Company website" htmlFor="ld-web" hint="Used for the duplicate check.">
                <Input id="ld-web" placeholder="company.com" {...register("website")} />
              </Field>
              <Field label="Company" htmlFor="ld-company" required error={formState.errors.companyName?.message}>
                <Input id="ld-company" {...register("companyName")} aria-invalid={!!formState.errors.companyName} />
              </Field>
              <Field label="Where the lead came from" htmlFor="ld-source" required>
                <NativeSelect id="ld-source" {...register("source")}>
                  {(Object.keys(SOURCE_LABEL) as LeadSource[]).map((s) => (
                    <option key={s} value={s}>
                      {SOURCE_LABEL[s]}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
              <Field label="Country" htmlFor="ld-country">
                <NativeSelect id="ld-country" {...register("country")}>
                  {COUNTRIES.map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </NativeSelect>
              </Field>
              <Field label="Industry" htmlFor="ld-industry">
                <Input id="ld-industry" placeholder="For example: Healthcare" {...register("industry")} />
              </Field>
              <Field label="Phone" htmlFor="ld-phone">
                <Input id="ld-phone" type="tel" {...register("phone")} />
              </Field>
              <Field label="LinkedIn profile" htmlFor="ld-li">
                <Input id="ld-li" placeholder="linkedin.com/in/…" {...register("linkedinUrl")} />
              </Field>
            </div>
            <Field label="Notes" htmlFor="ld-notes" hint="Only you and the sales manager can read notes.">
              <Textarea id="ld-notes" {...register("notes")} />
            </Field>
          </SheetBody>
          <SheetFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            {duplicate ? (
              <Button asChild>
                <Link href={`/sales/leads/${duplicate.leadId}`} onClick={() => onOpenChange(false)}>
                  View existing <ArrowRight />
                </Link>
              </Button>
            ) : (
              <Button type="submit" loading={create.isPending}>
                Add lead
              </Button>
            )}
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}

function DuplicateBanner({ checking, duplicate, checked }: { checking: boolean; duplicate: { ownerEmpId?: string; leadName?: string; companyName?: string; matchedOn?: string } | null; checked: boolean }) {
  if (duplicate)
    return (
      <div role="alert" className="grid gap-2 rounded-xl border border-danger/35 bg-danger/8 p-3">
        <p className="flex items-center gap-2 text-[13.5px] font-semibold">
          <TriangleAlert className="size-4 text-danger" /> This lead already exists.
        </p>
        <p className="text-[12.5px] text-muted-foreground">
          {duplicate.leadName} at {duplicate.companyName} (matched on {duplicate.matchedOn === "email" ? "the email" : "the website domain"}). Leads belong to one owner.
        </p>
        <div className="flex items-center gap-2 text-[12.5px]">
          <span className="text-muted-foreground">Owner:</span>
          <EmpChip empId={duplicate.ownerEmpId} size="sm" />
        </div>
      </div>
    );
  if (checking)
    return (
      <p className="flex items-center gap-2 text-[12.5px] text-muted-foreground">
        <LoaderCircle className="size-3.5 animate-spin" /> Checking for duplicates…
      </p>
    );
  if (checked)
    return (
      <p className="flex items-center gap-2 text-[12.5px] text-success">
        <CircleCheck className="size-3.5" /> No duplicate found.
      </p>
    );
  return null;
}
