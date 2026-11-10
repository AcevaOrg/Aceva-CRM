"use client";
import * as React from "react";
import { toast } from "sonner";
import { Building, MapPin, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/controls";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input, Textarea } from "@/components/ui/input";
import { SectionTitle } from "@/components/layout/page-header";
import { AvatarStack, EmpChip } from "@/components/shared/emp-chip";
import { EmployeeSelect } from "@/components/shared/pickers";
import { CardsSkeleton, QueryState } from "@/components/shared/states";
import { useLookup } from "@/hooks/use-directory";
import { useCan } from "@/lib/auth/viewer";
import { useAddOffice, useCreateDepartment, useDepartments } from "../hooks";
import { isLive } from "@/lib/api/http";
import { isManager } from "../logic";

export function DepartmentsPanel() {
  const query = useDepartments();
  const lookup = useLookup();
  // Adding departments and offices is not part of Module 1 yet, so it is switched off while the real server is connected.
  const canManage = useCan("org.manage") && !isLive("m1");
  const [newDept, setNewDept] = React.useState(false);
  const [newOffice, setNewOffice] = React.useState(false);

  return (
    <div className="grid gap-8">
      <section>
        <SectionTitle
          title="Departments"
          description={`Each department has a head. Headcount counts active staff and people on notice.${canManage ? "" : " View only: the Owner and the CEO add departments and offices."}`}
          actions={
            canManage && (
              <Button size="sm" onClick={() => setNewDept(true)}>
                <Plus /> Add department
              </Button>
            )
          }
        />
        <QueryState query={query} skeleton={<CardsSkeleton count={4} />}>
          {(d) => (
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {d.departments.map((dep) => {
                const members = lookup.employees.filter((e) => e.departmentId === dep.id && e.status !== "left");
                return (
                  <Card key={dep.id} className="relative overflow-hidden p-5">
                    <span className="absolute inset-y-0 left-0 w-1" style={{ background: dep.color }} aria-hidden />
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-[15px] font-semibold tracking-tight">{dep.name}</p>
                        <p className="text-[12.5px] text-muted-foreground">{d.headcount[dep.id] ?? 0} people</p>
                      </div>
                      <AvatarStack empIds={members.map((m) => m.empId)} max={4} />
                    </div>
                    <div className="mt-4">
                      <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Head</p>
                      <EmpChip empId={dep.headEmpId} subtitle={lookup.employee(dep.headEmpId)?.designation} />
                    </div>
                    <div className="mt-4 flex flex-wrap gap-1.5">
                      {dep.officeIds.map((o) => (
                        <span key={o} className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-[11.5px] text-muted-foreground">
                          <MapPin className="size-3" /> {lookup.office(o)?.name ?? o}
                        </span>
                      ))}
                    </div>
                  </Card>
                );
              })}
            </div>
          )}
        </QueryState>
      </section>

      <section>
        <SectionTitle
          title="Offices"
          description="Office networks are used for optional office-only check-in (Settings)."
          actions={
            canManage && (
              <Button size="sm" variant="outline" onClick={() => setNewOffice(true)}>
                <Plus /> Add office
              </Button>
            )
          }
        />
        <QueryState query={query} skeleton={<CardsSkeleton count={3} />}>
          {(d) => (
            <div className="grid gap-3 sm:grid-cols-3">
              {d.offices.map((o) => (
                <Card key={o.id} className="flex items-center gap-3 p-4">
                  <span className="grid size-10 place-content-center rounded-xl bg-zone-control/12 text-zone-control">
                    <Building className="size-5" />
                  </span>
                  <div>
                    <p className="font-semibold">{o.name}</p>
                    <p className="text-[12.5px] text-muted-foreground">
                      {o.city} · {d.officeHeadcount[o.id] ?? 0} people
                    </p>
                  </div>
                </Card>
              ))}
            </div>
          )}
        </QueryState>
      </section>

      {newDept && <NewDepartmentDialog onClose={() => setNewDept(false)} />}
      {newOffice && <NewOfficeDialog onClose={() => setNewOffice(false)} />}
    </div>
  );
}

function NewDepartmentDialog({ onClose }: { onClose: () => void }) {
  const lookup = useLookup();
  const create = useCreateDepartment();
  const [name, setName] = React.useState("");
  const [head, setHead] = React.useState("");
  const [offices, setOffices] = React.useState<string[]>([]);
  const [reason, setReason] = React.useState("");
  const ok = name.trim().length >= 2 && head && offices.length > 0 && reason.trim().length >= 3;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a department</DialogTitle>
          <DialogDescription>The change is saved in the audit log with your reason.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <Field label="Name" htmlFor="dep-name" required>
            <Input id="dep-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="For example: Mobile" />
          </Field>
          <Field label="Head of department" htmlFor="dep-head" required hint="A manager: the Director or the CTO.">
            <EmployeeSelect id="dep-head" value={head} onChange={setHead} filter={(e) => e.status !== "left" && isManager(e)} />
          </Field>
          <Field label="Offices" required>
            <div className="grid gap-2 sm:grid-cols-3">
              {lookup.offices.map((o) => (
                <label key={o.id} className="flex cursor-pointer items-center gap-2 rounded-lg border border-border px-3 py-2 text-[13px]">
                  <Checkbox
                    checked={offices.includes(o.id)}
                    onCheckedChange={(v) => setOffices((s) => (v === true ? [...s, o.id] : s.filter((x) => x !== o.id)))}
                  />
                  {o.name}
                </label>
              ))}
            </div>
          </Field>
          <Field label="Reason" htmlFor="dep-reason" required>
            <Textarea id="dep-reason" value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!ok}
            loading={create.isPending}
            onClick={async () => {
              await create.mutateAsync({ name: name.trim(), headEmpId: head, officeIds: offices, reason: reason.trim() });
              toast.success(`Department “${name.trim()}” added`);
              onClose();
            }}
          >
            Add department
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function NewOfficeDialog({ onClose }: { onClose: () => void }) {
  const add = useAddOffice();
  const [name, setName] = React.useState("");
  const [city, setCity] = React.useState("");
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Add an office</DialogTitle>
        </DialogHeader>
        <div className="grid gap-4">
          <Field label="Office name" htmlFor="off-name" required>
            <Input id="off-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Hyderabad Hub" />
          </Field>
          <Field label="City" htmlFor="off-city" required>
            <Input id="off-city" value={city} onChange={(e) => setCity(e.target.value)} />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={name.trim().length < 2 || city.trim().length < 2}
            loading={add.isPending}
            onClick={async () => {
              await add.mutateAsync({ name: name.trim(), city: city.trim() });
              toast.success(`Office “${name.trim()}” added`);
              onClose();
            }}
          >
            Add office
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
