"use client";
/**
 * DataTable: a small, typed table with sorting, search, pagination, row click,
 * loading/empty states and stacked cards on phones (spec §3.8, §10).
 *
 *   <DataTable rows={tasks} rowKey={(t) => t.id} columns={[
 *     { key: "title", header: "Title", cell: (t) => t.title, sortValue: (t) => t.title },
 *     { key: "amount", header: "Amount", align: "right", cell: (t) => <Money value={t.total} /> },
 *   ]} />
 */
import * as React from "react";
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, ChevronsUpDown, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/misc";
import { cn } from "@/lib/utils";
import { EmptyState, ListSkeleton } from "./states";

export interface Column<T> {
  key: string;
  header: React.ReactNode;
  cell: (row: T) => React.ReactNode;
  sortValue?: (row: T) => string | number;
  align?: "left" | "right" | "center";
  className?: string;
  headerClassName?: string;
  /** Hide on small screens' card view. */
  hideOnMobile?: boolean;
  width?: string;
}

export function DataTable<T>({
  rows,
  columns,
  rowKey,
  loading,
  onRowClick,
  searchable,
  searchText,
  searchPlaceholder = "Search",
  pageSize = 15,
  empty,
  toolbar,
  initialSort,
  rowClassName,
  className,
  footer,
  dense,
}: {
  rows: T[] | undefined;
  columns: Column<T>[];
  rowKey: (row: T) => string;
  loading?: boolean;
  onRowClick?: (row: T) => void;
  searchable?: boolean;
  /** Text used for search; defaults to all string cells. */
  searchText?: (row: T) => string;
  searchPlaceholder?: string;
  pageSize?: number;
  empty?: React.ReactNode;
  toolbar?: React.ReactNode;
  initialSort?: { key: string; dir: "asc" | "desc" };
  rowClassName?: (row: T) => string | undefined;
  className?: string;
  footer?: React.ReactNode;
  dense?: boolean;
}) {
  const [q, setQ] = React.useState("");
  const [sort, setSort] = React.useState(initialSort);
  const [page, setPage] = React.useState(0);

  const filtered = React.useMemo(() => {
    let list = rows ?? [];
    if (q.trim() && searchText) {
      const needle = q.trim().toLowerCase();
      list = list.filter((r) => searchText(r).toLowerCase().includes(needle));
    }
    if (sort) {
      const col = columns.find((c) => c.key === sort.key);
      if (col?.sortValue) {
        const sv = col.sortValue;
        list = [...list].sort((a, b) => {
          const x = sv(a);
          const y = sv(b);
          const r = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y));
          return sort.dir === "asc" ? r : -r;
        });
      }
    }
    return list;
  }, [rows, q, sort, columns, searchText]);

  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  // Clamp instead of resetting in an effect: when filters shrink the list, stay on the last real page.
  const current = Math.min(page, pages - 1);
  const visible = filtered.slice(current * pageSize, current * pageSize + pageSize);

  const toggleSort = (key: string) =>
    setSort((s) => (s?.key !== key ? { key, dir: "asc" } : s.dir === "asc" ? { key, dir: "desc" } : undefined));

  const alignCls = (a?: string) => (a === "right" ? "text-right" : a === "center" ? "text-center" : "");

  return (
    <div className={cn("grid gap-3", className)}>
      {(searchable || toolbar) && (
        <div className="flex flex-wrap items-center gap-2">
          {searchable && (
            <div className="relative w-full sm:w-72">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input value={q} onChange={(e) => { setQ(e.target.value); setPage(0); }} placeholder={searchPlaceholder} className="pl-8" aria-label={searchPlaceholder} />
            </div>
          )}
          {toolbar}
        </div>
      )}

      {loading ? (
        <ListSkeleton />
      ) : filtered.length === 0 ? (
        (empty ?? <EmptyState compact title={q ? "No matches" : "Nothing here yet"} description={q ? "Try a different search." : undefined} />)
      ) : (
        <div className="overflow-hidden rounded-xl border border-border bg-card shadow-strata">
          {/* Desktop table */}
          <div className="hidden sm:block">
            <Table>
              <THead>
                <tr>
                  {columns.map((c) => (
                    <TH key={c.key} className={cn(alignCls(c.align), c.headerClassName)} style={{ width: c.width }} aria-sort={sort?.key === c.key ? (sort.dir === "asc" ? "ascending" : "descending") : undefined}>
                      {c.sortValue ? (
                        <button type="button" onClick={() => toggleSort(c.key)} className={cn("inline-flex items-center gap-1 uppercase hover:text-foreground", c.align === "right" && "flex-row-reverse")}>
                          {c.header}
                          {sort?.key === c.key ? sort.dir === "asc" ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" /> : <ChevronsUpDown className="size-3 opacity-50" />}
                        </button>
                      ) : (
                        c.header
                      )}
                    </TH>
                  ))}
                </tr>
              </THead>
              <TBody>
                {visible.map((r) => (
                  <TR
                    key={rowKey(r)}
                    onClick={onRowClick ? () => onRowClick(r) : undefined}
                    className={cn(onRowClick && "cursor-pointer", rowClassName?.(r))}
                  >
                    {columns.map((c) => (
                      <TD key={c.key} className={cn(alignCls(c.align), dense && "py-1.5", c.className)}>
                        {c.cell(r)}
                      </TD>
                    ))}
                  </TR>
                ))}
              </TBody>
            </Table>
          </div>
          {/* Phone cards */}
          <ul className="divide-y divide-border sm:hidden">
            {visible.map((r) => (
              <li key={rowKey(r)} onClick={onRowClick ? () => onRowClick(r) : undefined} className={cn("grid gap-1.5 px-4 py-3", onRowClick && "cursor-pointer active:bg-muted", rowClassName?.(r))}>
                {columns
                  .filter((c) => !c.hideOnMobile)
                  .map((c, i) => (
                    <div key={c.key} className={cn("flex items-center justify-between gap-3 text-[13px]", i === 0 && "font-medium")}>
                      {i > 0 && <span className="text-[11.5px] uppercase tracking-wider text-muted-foreground">{c.header}</span>}
                      <span className={cn("min-w-0", i > 0 && "text-right")}>{c.cell(r)}</span>
                    </div>
                  ))}
              </li>
            ))}
          </ul>
          {footer}
          {pages > 1 && (
            <div className="flex items-center justify-between border-t border-border px-4 py-2 text-[12.5px] text-muted-foreground">
              <span className="tabular">
                {current * pageSize + 1}–{Math.min(filtered.length, (current + 1) * pageSize)} of {filtered.length}
              </span>
              <div className="flex gap-1">
                <Button size="icon-sm" variant="ghost" onClick={() => setPage(current - 1)} disabled={current === 0} aria-label="Previous page">
                  <ChevronLeft />
                </Button>
                <Button size="icon-sm" variant="ghost" onClick={() => setPage(current + 1)} disabled={current >= pages - 1} aria-label="Next page">
                  <ChevronRight />
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
