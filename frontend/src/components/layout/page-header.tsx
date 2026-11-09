"use client";
import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { ConfidentialSeal } from "@/components/shared/confidential-seal";
import { matchNav, ZONE_LABEL } from "@/lib/nav";
import { cn } from "@/lib/utils";
import type { Confidentiality, Zone } from "@/types";

export const ZONE_COLOR: Record<Zone, string> = {
  home: "var(--zone-home)",
  work: "var(--zone-work)",
  finance: "var(--zone-finance)",
  sales: "var(--zone-sales)",
  control: "var(--zone-control)",
};

/**
 * Every page starts with PageHeader (spec §3.5.1): zone eyebrow, title, description,
 * confidentiality seal, actions. The zone comes from the URL unless given.
 */
export function PageHeader({
  title,
  description,
  zone,
  eyebrow,
  seal,
  actions,
  back,
  meta,
  phase2,
  className,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  zone?: Zone;
  eyebrow?: string;
  seal?: Confidentiality;
  actions?: React.ReactNode;
  back?: { href: string; label: string };
  meta?: React.ReactNode;
  phase2?: boolean;
  className?: string;
}) {
  const pathname = usePathname();
  const nav = matchNav(pathname);
  const z = zone ?? nav?.zone ?? "home";
  const isPhase2 = phase2 ?? nav?.phase2;
  return (
    <header
      className={cn("layer-lines relative -mx-4 mb-6 border-b border-border px-4 pb-5 pt-5 sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8", className)}
      style={{ ["--layer-color" as string]: ZONE_COLOR[z] }}
    >
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-transparent to-background" aria-hidden />
      <div className="relative flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          {back && (
            <Link href={back.href} className="mb-2 inline-flex items-center gap-1 text-[12.5px] text-muted-foreground hover:text-foreground">
              <ArrowLeft className="size-3.5" /> {back.label}
            </Link>
          )}
          <div className="flex items-center gap-2">
            <span className="size-1.5 rounded-full" style={{ background: ZONE_COLOR[z] }} aria-hidden />
            <p className="text-[11px] font-semibold uppercase tracking-[0.1em]" style={{ color: ZONE_COLOR[z] }}>
              {eyebrow ?? ZONE_LABEL[z]}
            </p>
            {isPhase2 && (
              <Badge tone="sales" className="h-4 px-1.5 text-[10px]">
                Phase 2
              </Badge>
            )}
          </div>
          <h1 className="mt-1 text-2xl font-semibold tracking-[-0.02em] text-balance">{title}</h1>
          {description && <p className="mt-1 max-w-2xl text-[13.5px] text-muted-foreground">{description}</p>}
          {meta && <div className="mt-2.5 flex flex-wrap items-center gap-2">{meta}</div>}
        </div>
        {(seal || actions) && (
          <div className="flex flex-wrap items-center gap-2">
            {seal && <ConfidentialSeal level={seal} />}
            {actions}
          </div>
        )}
      </div>
    </header>
  );
}

/** Section heading inside a page. */
export function SectionTitle({ title, description, actions, className }: { title: React.ReactNode; description?: React.ReactNode; actions?: React.ReactNode; className?: string }) {
  return (
    <div className={cn("mb-3 flex flex-wrap items-end justify-between gap-2", className)}>
      <div>
        <h2 className="text-base font-semibold tracking-tight">{title}</h2>
        {description && <p className="text-[13px] text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}
