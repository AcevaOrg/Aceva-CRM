"use client";
/** Permission gates (spec §8). The server is the real lock; these only hide UI. */
import * as React from "react";
import Link from "next/link";
import { Lock, SearchX } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { Permission } from "@/lib/auth/permissions";
import { useCan } from "@/lib/auth/viewer";
import { EmptyState } from "./states";

export function Can({ permission, children, fallback = null }: { permission: Permission | Permission[]; children: React.ReactNode; fallback?: React.ReactNode }) {
  return useCan(permission) ? <>{children}</> : <>{fallback}</>;
}

/**
 * Wrap a whole page. mode="404" (finance, plan §16) shows Not Found so the page's
 * existence isn't revealed; mode="explain" says why access is missing.
 */
export function RequireAccess({
  permission,
  mode = "explain",
  children,
}: {
  permission: Permission | Permission[];
  mode?: "404" | "explain";
  children: React.ReactNode;
}) {
  const allowed = useCan(permission);
  if (allowed) return <>{children}</>;
  if (mode === "404") return <NotFoundBlock />;
  return (
    <EmptyState
      icon={<Lock />}
      title="You don't have access to this page"
      description="Access follows your level and duties. If you need it for your work, ask your manager or the Director."
      action={
        <Button asChild variant="outline">
          <Link href="/">Go to Home</Link>
        </Button>
      }
    />
  );
}

export function NotFoundBlock() {
  return (
    <EmptyState
      icon={<SearchX />}
      title="Page not found"
      description="The page you're looking for doesn't exist or has moved."
      action={
        <Button asChild variant="outline">
          <Link href="/">Go to Home</Link>
        </Button>
      }
    />
  );
}
