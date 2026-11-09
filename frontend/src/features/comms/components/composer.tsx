"use client";
import * as React from "react";
import { toast } from "sonner";
import { Loader2, Paperclip, SendHorizontal, ShieldCheck, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Avatar, Kbd } from "@/components/ui/misc";
import { Tip } from "@/components/ui/overlays";
import { useLookup } from "@/hooks/use-directory";
import { ApiError } from "@/lib/api/mock";
import { formatBytes } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useSendMessage } from "../hooks";
import { ALLOWED_EXTENSIONS, checkFile } from "../logic";

interface Pending {
  key: string;
  fileName: string;
  sizeBytes: number;
  mimeType: string;
  scan: "scanning" | "clean";
}

/**
 * Message composer: Enter sends, Shift+Enter adds a line, "@" suggests people in the conversation,
 * files are checked for type and size and "scanned" before they can be sent (plan §19).
 */
export function Composer({
  conversationId,
  memberEmpIds,
  parentId,
  placeholder,
  disabled,
  disabledReason,
  autoFocus,
  compact,
}: {
  conversationId: string;
  memberEmpIds: string[];
  parentId?: string;
  placeholder: string;
  disabled?: boolean;
  disabledReason?: string;
  autoFocus?: boolean;
  compact?: boolean;
}) {
  const send = useSendMessage();
  const lookup = useLookup();
  const [text, setText] = React.useState("");
  const [files, setFiles] = React.useState<Pending[]>([]);
  const [mention, setMention] = React.useState<{ query: string; index: number } | null>(null);
  const ref = React.useRef<HTMLTextAreaElement>(null);
  const fileRef = React.useRef<HTMLInputElement>(null);

  const candidates = React.useMemo(() => {
    if (!mention) return [];
    const q = mention.query.toLowerCase();
    return lookup.employees.filter((e) => memberEmpIds.includes(e.empId) && e.status !== "left" && e.name.toLowerCase().split(" ").some((p) => p.startsWith(q))).slice(0, 6);
  }, [mention, lookup.employees, memberEmpIds]);

  // Auto-grow the textarea up to 8 lines.
  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [text]);

  const detectMention = (value: string, caret: number) => {
    const m = /(^|\s)@([A-Za-z]*)$/.exec(value.slice(0, caret));
    setMention(m ? { query: m[2], index: 0 } : null);
  };

  const pick = (name: string) => {
    const el = ref.current;
    const caret = el?.selectionStart ?? text.length;
    const before = text.slice(0, caret).replace(/@([A-Za-z]*)$/, `@${name.split(" ")[0]} `);
    const next = before + text.slice(caret);
    setText(next);
    setMention(null);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(before.length, before.length);
    });
  };

  const addFiles = (list: FileList | null) => {
    if (!list) return;
    Array.from(list).forEach((f) => {
      const err = checkFile(f.name, f.size);
      if (err) return toast.error(`Can't attach ${f.name}`, { description: err });
      const key = `${f.name}-${f.size}-${Math.random()}`;
      setFiles((p) => [...p, { key, fileName: f.name, sizeBytes: f.size, mimeType: f.type || "application/octet-stream", scan: "scanning" }]);
      setTimeout(() => setFiles((p) => p.map((x) => (x.key === key ? { ...x, scan: "clean" } : x))), 1200 + Math.random() * 600);
    });
    if (fileRef.current) fileRef.current.value = "";
  };

  const scanning = files.some((f) => f.scan === "scanning");
  const canSend = !disabled && !send.isPending && !scanning && (text.trim().length > 0 || files.length > 0);

  const submit = async () => {
    if (!canSend) return;
    try {
      await send.mutateAsync({ conversationId, parentId, body: text, attachments: files.map(({ fileName, sizeBytes, mimeType }) => ({ fileName, sizeBytes, mimeType })) });
      setText("");
      setFiles([]);
      setMention(null);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't send the message.");
    }
  };

  if (disabled)
    return <p className="m-3 rounded-lg border border-dashed border-border bg-muted/50 px-3 py-3 text-center text-[13px] text-muted-foreground">{disabledReason ?? "You can't send messages here."}</p>;

  return (
    <div className={cn("relative border-t border-border bg-card p-3", compact && "p-2")}>
      {mention && candidates.length > 0 && (
        <ul role="listbox" aria-label="Mention someone" className="absolute bottom-full left-3 z-20 mb-2 w-64 overflow-hidden rounded-xl border border-border bg-popover p-1 shadow-float">
          {candidates.map((e, i) => (
            <li key={e.empId}>
              <button
                type="button"
                role="option"
                aria-selected={i === mention.index}
                onMouseDown={(ev) => {
                  ev.preventDefault();
                  pick(e.name);
                }}
                className={cn("flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px]", i === mention.index && "bg-muted")}
              >
                <Avatar name={e.name} hue={e.avatarHue} size={22} />
                <span className="flex-1 truncate">{e.name}</span>
                <span className="font-mono text-[11px] text-muted-foreground">{e.empId}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {files.length > 0 && (
        <ul className="mb-2 flex flex-wrap gap-2">
          {files.map((f) => (
            <li key={f.key} className="flex items-center gap-2 rounded-lg border border-border bg-muted/60 py-1 pl-2 pr-1 text-[12px]">
              {f.scan === "scanning" ? <Loader2 className="size-3.5 animate-spin text-muted-foreground" /> : <ShieldCheck className="size-3.5 text-success" />}
              <span className="max-w-40 truncate font-medium">{f.fileName}</span>
              <span className="text-muted-foreground">{f.scan === "scanning" ? "Scanning…" : formatBytes(f.sizeBytes)}</span>
              <button type="button" onClick={() => setFiles((p) => p.filter((x) => x.key !== f.key))} className="rounded p-0.5 text-muted-foreground hover:bg-card hover:text-foreground" aria-label={`Remove ${f.fileName}`}>
                <X className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex items-end gap-2 rounded-xl border border-input bg-background px-2 py-1.5 focus-within:border-ring focus-within:outline-2 focus-within:outline-ring/25">
        <input ref={fileRef} type="file" multiple hidden accept={ALLOWED_EXTENSIONS.map((e) => `.${e}`).join(",")} onChange={(e) => addFiles(e.target.files)} />
        <Tip content={`Attach files (up to 25 MB: ${ALLOWED_EXTENSIONS.slice(0, 6).join(", ")}…)`}>
          <Button type="button" size="icon-sm" variant="ghost" onClick={() => fileRef.current?.click()} aria-label="Attach files">
            <Paperclip />
          </Button>
        </Tip>
        <textarea
          ref={ref}
          rows={1}
          autoFocus={autoFocus}
          value={text}
          placeholder={placeholder}
          aria-label={placeholder}
          onChange={(e) => {
            setText(e.target.value);
            detectMention(e.target.value, e.target.selectionStart);
          }}
          onKeyDown={(e) => {
            if (mention && candidates.length) {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                return setMention({ ...mention, index: (mention.index + 1) % candidates.length });
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                return setMention({ ...mention, index: (mention.index - 1 + candidates.length) % candidates.length });
              }
              if (e.key === "Enter" || e.key === "Tab") {
                e.preventDefault();
                return pick(candidates[mention.index].name);
              }
              if (e.key === "Escape") return setMention(null);
            }
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
          onBlur={() => setTimeout(() => setMention(null), 120)}
          className="max-h-[180px] min-h-8 flex-1 resize-none bg-transparent py-1.5 text-[14px] leading-snug outline-none placeholder:text-muted-foreground/70"
        />
        <Button type="button" size="icon-sm" onClick={submit} disabled={!canSend} aria-label="Send">
          {send.isPending ? <Loader2 className="animate-spin" /> : <SendHorizontal />}
        </Button>
      </div>
      {!compact && (
        <p className="mt-1.5 hidden items-center gap-1 text-[11px] text-muted-foreground sm:flex">
          <Kbd>Enter</Kbd> to send · <Kbd>Shift</Kbd>+<Kbd>Enter</Kbd> new line · <Kbd>@</Kbd> to mention
        </p>
      )}
    </div>
  );
}
