"use client";
/** Shared small inputs: StarRating, EmployeeSelect, DetailList. */
import * as React from "react";
import { Star } from "lucide-react";
import { NativeSelect } from "@/components/ui/controls";
import { useLookup } from "@/hooks/use-directory";
import { cn } from "@/lib/utils";
import type { Employee } from "@/types";

/** 1–5 stars (task reviews, plan §10). Read-only when onChange is omitted. */
export function StarRating({ value, onChange, size = 20, className }: { value: number; onChange?: (v: number) => void; size?: number; className?: string }) {
  const [hover, setHover] = React.useState(0);
  const shown = hover || value;
  const labels = ["", "Poor", "Below expectations", "Meets expectations", "Good", "Excellent"];
  return (
    <div className={cn("inline-flex items-center gap-2", className)}>
      <div role={onChange ? "radiogroup" : "img"} aria-label={onChange ? "Rating" : `${value} of 5 stars`} className="flex" onMouseLeave={() => setHover(0)}>
        {[1, 2, 3, 4, 5].map((n) =>
          onChange ? (
            <button
              key={n}
              type="button"
              role="radio"
              aria-checked={value === n}
              aria-label={`${n} star${n > 1 ? "s" : ""}, ${labels[n]}`}
              onMouseEnter={() => setHover(n)}
              onClick={() => onChange(n)}
              className="p-0.5"
            >
              <Star style={{ width: size, height: size }} className={cn("transition", n <= shown ? "fill-warning text-warning" : "text-muted-foreground/40")} />
            </button>
          ) : (
            <Star key={n} style={{ width: size, height: size }} className={cn(n <= value ? "fill-warning text-warning" : "text-muted-foreground/30")} />
          ),
        )}
      </div>
      {onChange && shown > 0 && <span className="text-[12.5px] text-muted-foreground">{labels[shown]}</span>}
    </div>
  );
}

/**
 * Pick an employee from the directory. `filter` limits the list (e.g. only people below you).
 */
export function EmployeeSelect({
  value,
  onChange,
  filter,
  placeholder = "Choose a person",
  id,
  className,
  invalid,
}: {
  value: string;
  onChange: (empId: string) => void;
  filter?: (e: Employee) => boolean;
  placeholder?: string;
  id?: string;
  className?: string;
  invalid?: boolean;
}) {
  const { employees, department } = useLookup();
  const list = employees.filter((e) => e.status !== "left" && (!filter || filter(e)));
  return (
    <NativeSelect id={id} value={value} onChange={(e) => onChange(e.target.value)} className={className} aria-invalid={invalid || undefined}>
      <option value="">{placeholder}</option>
      {list.map((e) => (
        <option key={e.empId} value={e.empId}>
          {e.name} · {e.empId} · {department(e.departmentId)?.name ?? ""}
        </option>
      ))}
    </NativeSelect>
  );
}

/** Label/value pairs for detail panels. */
export function DetailList({ items, className, columns = 1 }: { items: [React.ReactNode, React.ReactNode][]; className?: string; columns?: 1 | 2 }) {
  return (
    <dl className={cn("grid gap-x-6 gap-y-3 text-[13px]", columns === 2 && "sm:grid-cols-2", className)}>
      {items.map(([k, v], i) => (
        <div key={i} className="grid gap-0.5">
          <dt className="text-[11.5px] font-medium uppercase tracking-wider text-muted-foreground">{k}</dt>
          <dd className="min-w-0">{v ?? "—"}</dd>
        </div>
      ))}
    </dl>
  );
}
