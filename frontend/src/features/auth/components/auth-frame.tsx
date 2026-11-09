import * as React from "react";
import { ShieldCheck, Layers, ScrollText } from "lucide-react";
import { AcevaLogo } from "@/components/layout/logo";

/** Split layout for public pages: ink panel with drifting layer lines + form (spec §9.2). */
export function AuthFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid min-h-dvh lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]">
      <aside className="relative hidden overflow-hidden bg-sidebar text-sidebar-foreground lg:flex lg:flex-col lg:justify-between lg:p-12">
        <Strata />
        <AcevaLogo className="relative" />
        <div className="relative max-w-md">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-signal">Aceva Digital System</p>
          <h2 className="mt-3 text-[40px] font-semibold leading-[1.05] tracking-[-0.03em] text-white">
            One company.
            <br />
            Every layer in order.
          </h2>
          <ul className="mt-8 grid gap-4 text-[13.5px]">
            {[
              { icon: Layers, t: "Five levels, one reporting line", d: "You see your own work and your team's, never above or beside." },
              { icon: ShieldCheck, t: "Finance behind two locks", d: "Two-step login and confirm-again for every risky action." },
              { icon: ScrollText, t: "Every change on the record", d: "A tamper-proof audit log anyone can trust." },
            ].map(({ icon: Icon, t, d }) => (
              <li key={t} className="flex gap-3">
                <span className="grid size-8 shrink-0 place-content-center rounded-lg bg-white/8 text-signal">
                  <Icon className="size-4" />
                </span>
                <span>
                  <span className="block font-medium text-white">{t}</span>
                  <span className="text-sidebar-muted">{d}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
        <p className="relative text-[12px] text-sidebar-muted">© {new Date().getFullYear()} Aceva · app.acevatech.com</p>
      </aside>
      <main className="flex flex-col px-5 py-8 sm:px-10">
        <div className="lg:hidden">
          <AcevaLogo tone="dark" />
        </div>
        <div className="mx-auto flex w-full max-w-[400px] flex-1 flex-col justify-center py-10">{children}</div>
      </main>
    </div>
  );
}

/** Drifting strata lines (the one decorative motion, spec §3.6). */
function Strata() {
  const rows = [
    { top: "18%", w: 1, o: 0.12, c: "var(--zone-work)", d: "38s" },
    { top: "30%", w: 2, o: 0.18, c: "var(--primary)", d: "28s" },
    { top: "44%", w: 1, o: 0.1, c: "var(--zone-finance)", d: "46s" },
    { top: "58%", w: 3, o: 0.16, c: "var(--signal)", d: "34s" },
    { top: "71%", w: 1, o: 0.12, c: "var(--zone-sales)", d: "52s" },
    { top: "84%", w: 2, o: 0.1, c: "var(--zone-control)", d: "40s" },
  ];
  return (
    <div className="pointer-events-none absolute inset-0" aria-hidden>
      <div className="absolute inset-0 opacity-60" style={{ backgroundImage: "repeating-linear-gradient(180deg, oklch(1 0 0 / 0.035) 0 1px, transparent 1px 12px)" }} />
      {rows.map((r, i) => (
        <div key={i} className="absolute left-0 h-24 w-[200%] animate-drift" style={{ top: r.top, animationDuration: r.d }}>
          <svg viewBox="0 0 1200 96" preserveAspectRatio="none" className="h-full w-full">
            <path
              d="M0 48 C 150 18, 300 78, 450 48 S 750 18, 900 48 S 1050 78, 1200 48"
              fill="none"
              stroke={r.c}
              strokeOpacity={r.o * 2}
              strokeWidth={r.w}
              vectorEffect="non-scaling-stroke"
            />
          </svg>
        </div>
      ))}
      <div className="absolute -right-32 -top-32 size-[420px] rounded-full bg-primary/25 blur-[120px]" />
      <div className="absolute -bottom-40 -left-20 size-[360px] rounded-full bg-signal/10 blur-[120px]" />
    </div>
  );
}

export function AuthHeading({ title, description }: { title: string; description?: React.ReactNode }) {
  return (
    <div className="mb-7">
      <h1 className="text-[28px] font-semibold tracking-[-0.02em]">{title}</h1>
      {description && <p className="mt-1.5 text-[14px] text-muted-foreground">{description}</p>}
    </div>
  );
}
