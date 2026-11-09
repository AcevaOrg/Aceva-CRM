"use client";
import * as React from "react";
import { ChevronDown, ChevronUp, Maximize2, Minus, Plus, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Avatar } from "@/components/ui/misc";
import { Tip } from "@/components/ui/overlays";
import { LevelMark } from "@/components/shared/level-mark";
import { QueryState } from "@/components/shared/states";
import { useLookup } from "@/hooks/use-directory";
import { DUTY_LABEL, ROLE_LABEL } from "@/lib/auth/permissions";
import { useViewer } from "@/lib/auth/viewer";
import { cn } from "@/lib/utils";
import { useOrgTree } from "../hooks";
import { buildTree, type TreeNode } from "../logic";
import type { OrgNode } from "../types";
import styles from "./org-chart.module.css";
import { OrgNodeSheet } from "./org-node-sheet";

function matches(n: OrgNode, q: string) {
  const needle = q.trim().toLowerCase();
  return !!needle && (n.name.toLowerCase().includes(needle) || n.empId.toLowerCase().includes(needle) || n.designation.toLowerCase().includes(needle));
}

/** Interactive top-down org chart (spec §9.1): collapse, search-highlight, zoom, side sheet. */
export function OrgChart() {
  const query = useOrgTree();
  const viewer = useViewer();
  const [q, setQ] = React.useState("");
  const [collapsed, setCollapsed] = React.useState<Set<string>>(new Set());
  const [scale, setScale] = React.useState(1);
  const [selected, setSelected] = React.useState<string | null>(null);
  const viewportRef = React.useRef<HTMLDivElement>(null);
  const treeRef = React.useRef<HTMLDivElement>(null);
  const fitted = React.useRef(false);

  /** Zoom so the whole tree fits the visible width (CSS zoom changes layout, so scrolling stays correct). */
  const fit = React.useCallback(() => {
    const vp = viewportRef.current;
    const tree = treeRef.current;
    if (!vp || !tree) return;
    const natural = tree.scrollWidth / (Number(tree.style.zoom) || 1);
    const next = Math.max(0.5, Math.min(1, +((vp.clientWidth - 48) / natural).toFixed(2)));
    setScale(next);
    requestAnimationFrame(() => {
      vp.scrollLeft = (vp.scrollWidth - vp.clientWidth) / 2;
    });
  }, []);

  React.useEffect(() => {
    if (query.data && !fitted.current) {
      fitted.current = true;
      requestAnimationFrame(fit);
    }
  }, [query.data, fit]);

  const toggle = (id: string) =>
    setCollapsed((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const hits = (query.data ?? []).filter((n) => matches(n, q));

  /** Searching expands every branch so the matches are visible. */
  const search = (value: string) => {
    setQ(value);
    if (value.trim()) setCollapsed(new Set());
  };

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
        <div className="relative w-full sm:w-72">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => search(e.target.value)} placeholder="Find a person, Emp-ID or role" className="pl-8 pr-8" aria-label="Find in org chart" />
          {q && (
            <button onClick={() => setQ("")} className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground" aria-label="Clear search">
              <X className="size-3.5" />
            </button>
          )}
        </div>
        {q && (
          <span className="text-[12.5px] text-muted-foreground" aria-live="polite">
            {hits.length ? `${hits.length} match${hits.length === 1 ? "" : "es"}` : "No match"}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          <Button size="sm" variant="ghost" onClick={() => setCollapsed(new Set())}>
            <ChevronDown /> Expand all
          </Button>
          <div className="flex items-center rounded-lg border border-border">
            <Button size="icon-sm" variant="ghost" onClick={() => setScale((s) => Math.max(0.5, +(s - 0.1).toFixed(2)))} aria-label="Zoom out">
              <Minus />
            </Button>
            <span className="w-11 text-center text-[12px] tabular text-muted-foreground">{Math.round(scale * 100)}%</span>
            <Button size="icon-sm" variant="ghost" onClick={() => setScale((s) => Math.min(1.3, +(s + 0.1).toFixed(2)))} aria-label="Zoom in">
              <Plus />
            </Button>
            <Tip content="Fit to screen">
              <Button size="icon-sm" variant="ghost" onClick={fit} aria-label="Fit to screen">
                <Maximize2 />
              </Button>
            </Tip>
          </div>
        </div>
      </div>
      <div
        ref={viewportRef}
        className="layer-lines overflow-auto bg-background/60 scrollbar-thin"
        style={{ ["--layer-color" as string]: "var(--zone-control)", maxHeight: "calc(100dvh - 300px)", minHeight: 420 }}
      >
        <QueryState query={query}>
          {(nodes) => {
            const roots = buildTree(nodes);
            return (
              <div className="inline-block min-w-full px-6 py-8">
                <div ref={treeRef} className={cn(styles.tree, "w-max")} style={{ zoom: scale, marginInline: "auto" }}>
                  <ul>
                    {roots.map((r) => (
                      <Branch key={r.node.empId} t={r} q={q} collapsed={collapsed} onToggle={toggle} onOpen={setSelected} me={viewer?.employee.empId} />
                    ))}
                  </ul>
                </div>
              </div>
            );
          }}
        </QueryState>
      </div>
      <OrgNodeSheet empId={selected} onClose={() => setSelected(null)} />
    </Card>
  );
}

function Branch({
  t,
  q,
  collapsed,
  onToggle,
  onOpen,
  me,
}: {
  t: TreeNode;
  q: string;
  collapsed: Set<string>;
  onToggle: (id: string) => void;
  onOpen: (id: string) => void;
  me?: string;
}) {
  const isCollapsed = collapsed.has(t.node.empId);
  return (
    <li>
      <NodeCard t={t} q={q} isCollapsed={isCollapsed} onToggle={() => onToggle(t.node.empId)} onOpen={() => onOpen(t.node.empId)} isMe={me === t.node.empId} />
      {t.children.length > 0 && !isCollapsed && (
        <ul>
          {t.children.map((c) => (
            <Branch key={c.node.empId} t={c} q={q} collapsed={collapsed} onToggle={onToggle} onOpen={onOpen} me={me} />
          ))}
        </ul>
      )}
    </li>
  );
}

function NodeCard({ t, q, isCollapsed, onToggle, onOpen, isMe }: { t: TreeNode; q: string; isCollapsed: boolean; onToggle: () => void; onOpen: () => void; isMe: boolean }) {
  const lookup = useLookup();
  const n = t.node;
  const dept = lookup.department(n.departmentId);
  const hit = matches(n, q);
  const dim = !!q.trim() && !hit;
  return (
    <div className="relative flex flex-col items-center">
      <button
        type="button"
        onClick={onOpen}
        className={cn(
          "relative w-[172px] overflow-hidden rounded-xl border border-border bg-card px-3 pb-3 pt-3.5 text-left shadow-strata transition hover:-translate-y-0.5 hover:shadow-float",
          hit && "ring-2 ring-signal ring-offset-2 ring-offset-background",
          dim && "opacity-40",
          isMe && !hit && "border-primary/50",
        )}
        aria-label={`${n.name}, ${n.designation}. Open details`}
      >
        <span className="absolute inset-x-0 top-0 h-1" style={{ background: dept?.color ?? "var(--muted)" }} aria-hidden />
        <span className="flex items-center gap-2.5">
          <Avatar name={n.name} hue={n.avatarHue} size={34} />
          <span className="grid min-w-0 leading-tight">
            <span className="truncate text-[13px] font-semibold">{n.name}</span>
            <span className="truncate text-[11.5px] text-muted-foreground">{n.designation}</span>
          </span>
        </span>
        <span className="mt-2.5 flex items-center justify-between gap-2">
          <span className="font-mono text-[11px] text-muted-foreground">{n.empId}</span>
          <LevelMark level={n.level} />
        </span>
        <span className="mt-1.5 flex flex-wrap gap-1">
          <span className="rounded-full bg-muted px-1.5 py-px text-[10.5px] font-medium text-muted-foreground">{ROLE_LABEL[n.role]}</span>
          {n.duties.map((d) => (
            <span key={d} className="rounded-full bg-primary/10 px-1.5 py-px text-[10.5px] font-medium text-foreground">
              {DUTY_LABEL[d]}
            </span>
          ))}
          {isMe && <span className="rounded-full bg-signal/50 px-1.5 py-px text-[10.5px] font-semibold text-signal-foreground">You</span>}
        </span>
      </button>
      {t.children.length > 0 && (
        <button
          type="button"
          onClick={onToggle}
          className="relative z-[1] -mt-2.5 inline-flex h-5 items-center gap-0.5 rounded-full border border-border bg-card px-1.5 text-[10.5px] font-semibold text-muted-foreground shadow-strata hover:text-foreground"
          aria-label={isCollapsed ? `Show ${t.size} people below ${n.name}` : `Hide people below ${n.name}`}
          aria-expanded={!isCollapsed}
        >
          {isCollapsed ? <ChevronDown className="size-3" /> : <ChevronUp className="size-3" />}
          {isCollapsed ? t.size : t.children.length}
        </button>
      )}
    </div>
  );
}
