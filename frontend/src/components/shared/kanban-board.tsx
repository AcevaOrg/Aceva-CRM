"use client";
/**
 * Generic kanban board with native drag and drop (tasks board, sales pipeline).
 * `canDrop` decides if a card may move to a column; `onMove` performs the move
 * (which may open a reason dialog first).
 */
import * as React from "react";
import { cn } from "@/lib/utils";

export interface KanbanColumn {
  id: string;
  title: string;
  /** CSS colour for the column dot. */
  color?: string;
  subtitle?: React.ReactNode;
  collapsed?: boolean;
}

export function KanbanBoard<T>({
  columns,
  items,
  columnOf,
  itemKey,
  renderCard,
  canDrop,
  onMove,
  className,
  columnWidth = 280,
}: {
  columns: KanbanColumn[];
  items: T[];
  columnOf: (item: T) => string;
  itemKey: (item: T) => string;
  renderCard: (item: T) => React.ReactNode;
  canDrop?: (item: T, toColumn: string) => boolean;
  onMove?: (item: T, toColumn: string) => void;
  className?: string;
  columnWidth?: number;
}) {
  const [dragKey, setDragKey] = React.useState<string | null>(null);
  const [over, setOver] = React.useState<string | null>(null);
  const dragging = items.find((i) => itemKey(i) === dragKey);

  return (
    <div className={cn("flex gap-3 overflow-x-auto pb-3 scrollbar-thin", className)}>
      {columns.map((col) => {
        const list = items.filter((i) => columnOf(i) === col.id);
        const allowed = dragging ? (canDrop ? canDrop(dragging, col.id) : true) && columnOf(dragging) !== col.id : false;
        return (
          <section
            key={col.id}
            aria-label={col.title}
            onDragOver={(e) => {
              if (!allowed) return;
              e.preventDefault();
              setOver(col.id);
            }}
            onDragLeave={() => setOver((o) => (o === col.id ? null : o))}
            onDrop={(e) => {
              e.preventDefault();
              setOver(null);
              if (dragging && allowed) onMove?.(dragging, col.id);
              setDragKey(null);
            }}
            className={cn(
              "flex shrink-0 flex-col rounded-xl border border-border bg-muted/40 transition-colors",
              dragging && allowed && "border-dashed border-primary/50",
              dragging && !allowed && columnOf(dragging) !== col.id && "opacity-50",
              over === col.id && "bg-accent",
            )}
            style={{ width: col.collapsed ? 200 : columnWidth }}
          >
            <header className="flex items-center justify-between gap-2 px-3 pb-2 pt-3">
              <div className="flex min-w-0 items-center gap-2">
                <span className="size-2 shrink-0 rounded-full" style={{ background: col.color ?? "var(--muted-foreground)" }} />
                <h3 className="truncate text-[13px] font-semibold">{col.title}</h3>
                <span className="rounded-full bg-card px-1.5 text-[11px] font-medium text-muted-foreground tabular">{list.length}</span>
              </div>
              {col.subtitle && <span className="text-[11.5px] text-muted-foreground">{col.subtitle}</span>}
            </header>
            <div className="grid min-h-24 content-start gap-2 px-2 pb-2">
              {list.map((item) => {
                const k = itemKey(item);
                return (
                  <div
                    key={k}
                    draggable={!!onMove}
                    onDragStart={(e) => {
                      setDragKey(k);
                      e.dataTransfer.effectAllowed = "move";
                    }}
                    onDragEnd={() => {
                      setDragKey(null);
                      setOver(null);
                    }}
                    className={cn(onMove && "cursor-grab active:cursor-grabbing", dragKey === k && "opacity-40")}
                  >
                    {renderCard(item)}
                  </div>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}
