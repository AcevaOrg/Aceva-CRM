"use client";
/** Loading, empty and error states + a QueryState helper (spec §11). */
import * as React from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import { CircleAlert, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/misc";
import { cn } from "@/lib/utils";

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
  compact,
}: {
  icon?: React.ReactNode;
  title: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
  compact?: boolean;
}) {
  return (
    <div
      className={cn(
        "layer-lines relative grid place-items-center rounded-xl border border-dashed border-border text-center",
        compact ? "px-4 py-8" : "px-6 py-14",
        className,
      )}
      style={{ ["--layer-color" as string]: "var(--muted-foreground)" }}
    >
      <div className="grid max-w-sm justify-items-center gap-2 rounded-xl bg-background/80 px-4 py-2 backdrop-blur-[1px]">
        {icon && <span className="mb-1 grid size-11 place-content-center rounded-2xl border border-border bg-card text-muted-foreground shadow-strata [&_svg]:size-5">{icon}</span>}
        <p className="text-[15px] font-semibold">{title}</p>
        {description && <p className="text-[13px] text-muted-foreground">{description}</p>}
        {action && <div className="mt-2">{action}</div>}
      </div>
    </div>
  );
}

export function ErrorState({ error, onRetry, className }: { error?: unknown; onRetry?: () => void; className?: string }) {
  const message = error instanceof Error ? error.message : "Something went wrong.";
  return (
    <div className={cn("flex items-start gap-3 rounded-xl border border-danger/30 bg-danger/8 p-4", className)} role="alert">
      <CircleAlert className="mt-0.5 size-5 shrink-0 text-danger" />
      <div className="grid gap-2">
        <p className="text-[13px] font-medium">Couldn&apos;t load this.</p>
        <p className="text-[12.5px] text-muted-foreground">{message}</p>
        {onRetry && (
          <Button size="sm" variant="outline" onClick={onRetry} className="w-fit">
            <RefreshCw /> Try again
          </Button>
        )}
      </div>
    </div>
  );
}

export function ListSkeleton({ rows = 5, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn("grid gap-2", className)} aria-busy>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-11 w-full" />
      ))}
    </div>
  );
}

export function CardsSkeleton({ count = 4, className }: { count?: number; className?: string }) {
  return (
    <div className={cn("grid gap-4 sm:grid-cols-2 xl:grid-cols-4", className)} aria-busy>
      {Array.from({ length: count }, (_, i) => (
        <Skeleton key={i} className="h-28 rounded-xl" />
      ))}
    </div>
  );
}

/**
 * Render a query's loading / error / empty / data states consistently.
 *   <QueryState query={q} isEmpty={(d) => !d.length} empty={<EmptyState …/>}>{(d) => …}</QueryState>
 */
export function QueryState<T>({
  query,
  children,
  skeleton,
  empty,
  isEmpty,
}: {
  query: UseQueryResult<T>;
  children: (data: T) => React.ReactNode;
  skeleton?: React.ReactNode;
  empty?: React.ReactNode;
  isEmpty?: (data: T) => boolean;
}) {
  if (query.isPending) return <>{skeleton ?? <ListSkeleton />}</>;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => query.refetch()} />;
  if (empty && isEmpty?.(query.data)) return <>{empty}</>;
  return <>{children(query.data)}</>;
}
