"use client";
import * as React from "react";
import { toast } from "sonner";
import { Info, Lock } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Checkbox, NativeSelect } from "@/components/ui/controls";
import { Tip } from "@/components/ui/overlays";
import { useReason } from "@/components/shared/dialogs";
import { LevelMark } from "@/components/shared/level-mark";
import { QueryState } from "@/components/shared/states";
import { permissionGroups, type Permission } from "@/lib/auth/permissions";
import { useCan } from "@/lib/auth/viewer";
import { cn } from "@/lib/utils";
import { useRoles, useUpdateRole } from "../hooks";
import { groupLabel, permissionLabel } from "../logic";
import type { Role } from "../types";

/** Roles × permissions matrix grouped by module, with duty add-ons (spec §9.1). */
export function RolesMatrix() {
  const query = useRoles();
  const canEdit = useCan("roles.manage");
  const update = useUpdateRole();
  const askReason = useReason();
  const groups = permissionGroups();
  const [group, setGroup] = React.useState<string>("all");

  const toggle = async (role: Role, p: Permission, on: boolean) => {
    const reason = await askReason({
      title: `${on ? "Give" : "Remove"} “${permissionLabel(p)}” ${on ? "to" : "from"} ${role.name}`,
      description: "Changing a permission changes access in every module at once. A reason is required and saved in the audit log.",
      confirmLabel: on ? "Give permission" : "Remove permission",
      destructive: !on,
    });
    if (!reason) return;
    const permissions = on ? [...role.permissions, p] : role.permissions.filter((x) => x !== p);
    try {
      await update.mutateAsync({ roleId: role.id, permissions, reason, summary: `${on ? "added" : "removed"} ${p}` });
      toast.success("Permission updated", { description: `${role.name} · ${p}. Logged.` });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't update the role.");
    }
  };

  const shown = Object.entries(groups).filter(([g]) => group === "all" || g === group);

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <NativeSelect value={group} onChange={(e) => setGroup(e.target.value)} className="w-56" aria-label="Filter by module">
          <option value="all">All modules</option>
          {Object.keys(groups).map((g) => (
            <option key={g} value={g}>
              {groupLabel(g)}
            </option>
          ))}
        </NativeSelect>
        <p className="flex items-center gap-1.5 text-[12.5px] text-muted-foreground">
          <Info className="size-3.5" />
          {canEdit ? "Click a box to change it. Every change asks for a reason." : "Read-only. Only levels 1 to 3 can change roles."}
        </p>
      </div>

      <QueryState query={query}>
        {(roles) => {
          const levelRoles = roles.filter((r) => !r.isDuty);
          const duties = roles.filter((r) => r.isDuty);
          const cols = [...levelRoles, ...duties];
          return (
            <Card className="overflow-hidden">
              <div className="max-h-[calc(100dvh-280px)] overflow-auto scrollbar-thin">
                <table className="w-full border-separate border-spacing-0 text-[12.5px]">
                  <thead>
                    <tr>
                      <th scope="col" className="sticky left-0 top-0 z-20 min-w-64 border-b border-r border-border bg-card px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                        Permission
                      </th>
                      {cols.map((r) => (
                        <th
                          key={r.id}
                          scope="col"
                          className={cn(
                            "sticky top-0 z-10 min-w-24 border-b border-border px-2 py-2.5 text-center align-bottom",
                            r.isDuty ? "bg-primary/[0.06]" : "bg-card",
                            r === duties[0] && "border-l-2 border-l-primary/30",
                          )}
                        >
                          <Tip content={r.description}>
                            <span tabIndex={0} className="grid cursor-help justify-items-center gap-1 outline-none">
                              {r.isDuty ? (
                                <span className="rounded-full bg-primary/12 px-1.5 text-[9.5px] font-bold uppercase tracking-wider text-primary">Duty</span>
                              ) : (
                                r.level && <LevelMark level={r.level} />
                              )}
                              <span className="text-[12px] font-semibold leading-tight">{r.name}</span>
                              <span className="text-[10.5px] font-normal text-muted-foreground tabular">{r.permissions.length}</span>
                            </span>
                          </Tip>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map(([g, perms]) => (
                      <React.Fragment key={g}>
                        <tr>
                          <th colSpan={cols.length + 1} scope="colgroup" className="sticky left-0 border-b border-border bg-muted/70 px-4 py-1.5 text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                            {groupLabel(g)}
                          </th>
                        </tr>
                        {perms.map((p) => (
                          <tr key={p} className="hover:bg-muted/40">
                            <th scope="row" className="sticky left-0 z-[1] border-b border-r border-border bg-card px-4 py-1.5 text-left font-normal">
                              <span className="block text-[12.5px]">{permissionLabel(p)}</span>
                              <span className="font-mono text-[10.5px] text-muted-foreground">{p}</span>
                            </th>
                            {cols.map((r) => {
                              const has = r.permissions.includes(p);
                              const locked = r.key === "owner";
                              return (
                                <td key={r.id} className={cn("border-b border-border text-center", r.isDuty && "bg-primary/[0.03]", r === duties[0] && "border-l-2 border-l-primary/30")}>
                                  {locked ? (
                                    <Tip content="The Owner always has every permission.">
                                      <span className="inline-grid size-4 place-content-center text-muted-foreground">
                                        <Lock className="size-3" />
                                      </span>
                                    </Tip>
                                  ) : (
                                    <Checkbox
                                      className="mx-auto"
                                      checked={has}
                                      disabled={!canEdit || update.isPending}
                                      onCheckedChange={(v) => toggle(r, p, v === true)}
                                      aria-label={`${r.name}: ${permissionLabel(p)}`}
                                    />
                                  )}
                                </td>
                              );
                            })}
                          </tr>
                        ))}
                      </React.Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          );
        }}
      </QueryState>
    </div>
  );
}
