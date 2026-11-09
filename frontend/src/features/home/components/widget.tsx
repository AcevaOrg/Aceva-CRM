"use client";
import * as React from "react";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/misc";
import { ConfidentialSeal } from "@/components/shared/confidential-seal";
import { cn } from "@/lib/utils";
import type { Confidentiality } from "@/types";

/** Home dashboard card: title, optional seal, "see all" link (spec §9.12). */
export function Widget({
  title,
  icon,
  href,
  linkLabel = "See all",
  seal,
  action,
  children,
  className,
  bodyClassName,
}: {
  title: string;
  icon?: React.ReactNode;
  href?: string;
  linkLabel?: string;
  seal?: Confidentiality;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <Card className={cn("flex flex-col", className)}>
      <div className="flex items-center justify-between gap-2 px-5 pb-2 pt-4">
        <h2 className="flex items-center gap-2 text-[14px] font-semibold tracking-tight">
          {icon && <span className="text-muted-foreground [&_svg]:size-4">{icon}</span>}
          {title}
        </h2>
        <div className="flex items-center gap-2">
          {seal && <ConfidentialSeal level={seal} compact />}
          {action}
          {href && (
            <Link href={href} className="inline-flex items-center gap-1 text-[12.5px] font-medium text-primary hover:underline">
              {linkLabel} <ArrowRight className="size-3.5" />
            </Link>
          )}
        </div>
      </div>
      {/* min-w-0 on list items lets long text truncate instead of overflowing the card */}
      <div className={cn("min-w-0 flex-1 px-5 pb-5 [&_li]:min-w-0", bodyClassName)}>{children}</div>
    </Card>
  );
}

export function WidgetSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="grid gap-2">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-9" />
      ))}
    </div>
  );
}

export function WidgetEmpty({ children }: { children: React.ReactNode }) {
  return <p className="rounded-lg bg-muted/50 px-3 py-4 text-center text-[13px] text-muted-foreground">{children}</p>;
}
