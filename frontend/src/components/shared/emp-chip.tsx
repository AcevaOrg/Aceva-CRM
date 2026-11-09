"use client";
import Link from "next/link";
import { Avatar } from "@/components/ui/misc";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/overlays";
import { useLookup } from "@/hooks/use-directory";
import { cn } from "@/lib/utils";
import { LevelMark } from "./level-mark";

/**
 * Avatar + name + Emp-ID (spec §3.5.4). Hover shows designation, department and reports-to.
 * Pass `empId`; the directory resolves the rest.
 */
export function EmpChip({
  empId,
  size = "md",
  showId = true,
  subtitle,
  link = true,
  className,
}: {
  empId?: string | null;
  size?: "sm" | "md" | "lg";
  showId?: boolean;
  subtitle?: React.ReactNode;
  link?: boolean;
  className?: string;
}) {
  const lookup = useLookup();
  const e = lookup.employee(empId);
  if (!empId) return <span className="text-muted-foreground">—</span>;
  const avatarSize = { sm: 22, md: 28, lg: 36 }[size];
  const name = e?.name ?? empId;

  const body = (
    <span className={cn("inline-flex min-w-0 items-center gap-2 align-middle", className)}>
      <Avatar name={name} hue={e?.avatarHue} size={avatarSize} />
      <span className="grid min-w-0 leading-tight">
        <span className={cn("truncate font-medium", size === "sm" ? "text-[12.5px]" : "text-[13px]")}>{name}</span>
        {(showId || subtitle) && (
          <span className="truncate text-[11.5px] text-muted-foreground">
            {subtitle ?? <span className="font-mono">{empId}</span>}
          </span>
        )}
      </span>
    </span>
  );

  if (!e) return body;
  const boss = lookup.employee(e.reportsTo);
  const dept = lookup.department(e.departmentId);

  return (
    <HoverCard openDelay={350} closeDelay={80}>
      <HoverCardTrigger asChild>
        {link ? (
          <Link href={`/people/${e.empId}`} className="min-w-0 rounded-md outline-offset-2 hover:[&_span.font-medium]:underline">
            {body}
          </Link>
        ) : (
          <span className="min-w-0">{body}</span>
        )}
      </HoverCardTrigger>
      <HoverCardContent align="start" className="w-64">
        <div className="flex items-start gap-3">
          <Avatar name={e.name} hue={e.avatarHue} size={40} />
          <div className="min-w-0">
            <p className="truncate font-semibold">{e.name}</p>
            <p className="truncate text-[12.5px] text-muted-foreground">{e.designation}</p>
            <p className="mt-0.5 font-mono text-[11.5px] text-muted-foreground">{e.empId}</p>
          </div>
        </div>
        <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-[12.5px]">
          <dt className="text-muted-foreground">Level</dt>
          <dd>
            <LevelMark level={e.level} showLabel />
          </dd>
          <dt className="text-muted-foreground">Department</dt>
          <dd className="truncate">{dept?.name ?? "—"}</dd>
          <dt className="text-muted-foreground">Reports to</dt>
          <dd className="truncate">{boss ? boss.name : "Nobody (top of the company)"}</dd>
        </dl>
      </HoverCardContent>
    </HoverCard>
  );
}

/** Overlapping avatars for small groups. */
export function AvatarStack({ empIds, max = 4, size = 24 }: { empIds: string[]; max?: number; size?: number }) {
  const lookup = useLookup();
  const shown = empIds.slice(0, max);
  return (
    <span className="inline-flex items-center">
      {shown.map((id, i) => {
        const e = lookup.employee(id);
        return (
          <span key={id} className={cn(i > 0 && "-ml-1.5")} title={e?.name ?? id}>
            <Avatar name={e?.name ?? id} hue={e?.avatarHue} size={size} ring />
          </span>
        );
      })}
      {empIds.length > max && (
        <span className="-ml-1.5 grid place-content-center rounded-full bg-muted text-[10px] font-semibold ring-2 ring-card" style={{ width: size, height: size }}>
          +{empIds.length - max}
        </span>
      )}
    </span>
  );
}
