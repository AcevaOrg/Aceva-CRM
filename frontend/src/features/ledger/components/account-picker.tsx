"use client";
import * as React from "react";
import { Command } from "cmdk";
import { Check, ChevronsUpDown, Search } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/overlays";
import { cn } from "@/lib/utils";
import { GROUP_LABEL, GROUP_ORDER } from "../logic";
import type { Account } from "../types";

/**
 * Searchable account picker (type a code like "5400" or a name like "hosting").
 * Header accounts are shown as group labels and can't be picked.
 */
export function AccountPicker({
  accounts,
  value,
  onChange,
  filter,
  placeholder = "Choose an account",
  invalid,
  className,
  id,
}: {
  accounts: Account[];
  value: string;
  onChange: (id: string) => void;
  filter?: (a: Account) => boolean;
  placeholder?: string;
  invalid?: boolean;
  className?: string;
  id?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const current = accounts.find((a) => a.id === value);
  const usable = accounts.filter((a) => !a.isHeader && a.active && (!filter || filter(a)));

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          id={id}
          type="button"
          aria-label={invalid ? `${current ? current.name : placeholder} (required)` : undefined}
          className={cn(
            "flex h-9 w-full min-w-0 items-center gap-2 rounded-lg border border-input bg-card px-2.5 text-left text-[13px] shadow-[0_1px_1px_oklch(0.2_0.03_265/0.04)] transition hover:border-ring/50 focus-visible:outline-2 focus-visible:outline-ring/30",
            invalid && "border-danger",
            className,
          )}
        >
          {current ? (
            <>
              <span className="font-mono text-[12px] text-muted-foreground">{current.code}</span>
              <span className="truncate">{current.name}</span>
              {current.currency === "USD" && <span className="rounded bg-muted px-1 text-[10px] font-semibold text-muted-foreground">USD</span>}
            </>
          ) : (
            <span className="truncate text-muted-foreground/80">{placeholder}</span>
          )}
          <ChevronsUpDown className="ml-auto size-3.5 shrink-0 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[min(92vw,360px)] p-0">
        <Command
          filter={(itemValue, search) => (itemValue.toLowerCase().includes(search.toLowerCase().trim()) ? 1 : 0)}
          className="flex flex-col"
        >
          <div className="flex items-center gap-2 border-b border-border px-3">
            <Search className="size-4 text-muted-foreground" />
            <Command.Input autoFocus placeholder="Code or name, e.g. 5400 or hosting" className="h-10 flex-1 bg-transparent text-[13px] outline-none placeholder:text-muted-foreground" />
          </div>
          <Command.List className="max-h-72 overflow-y-auto p-1.5 scrollbar-thin">
            <Command.Empty className="py-6 text-center text-[13px] text-muted-foreground">No matching account.</Command.Empty>
            {GROUP_ORDER.map((g) => {
              const items = usable.filter((a) => a.group === g);
              if (!items.length) return null;
              return (
                <Command.Group
                  key={g}
                  heading={GROUP_LABEL[g]}
                  className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:text-[10.5px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[0.12em] [&_[cmdk-group-heading]]:text-muted-foreground"
                >
                  {items.map((a) => (
                    <Command.Item
                      key={a.id}
                      value={`${a.code} ${a.name}`}
                      onSelect={() => {
                        onChange(a.id);
                        setOpen(false);
                      }}
                      className="flex h-8 cursor-default items-center gap-2 rounded-md px-2 text-[13px] data-[selected=true]:bg-muted"
                    >
                      <span className="w-10 font-mono text-[12px] text-muted-foreground">{a.code}</span>
                      <span className="flex-1 truncate">{a.name}</span>
                      {a.currency === "USD" && <span className="text-[10px] font-semibold text-muted-foreground">USD</span>}
                      {a.id === value && <Check className="size-3.5 text-primary" />}
                    </Command.Item>
                  ))}
                </Command.Group>
              );
            })}
          </Command.List>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
