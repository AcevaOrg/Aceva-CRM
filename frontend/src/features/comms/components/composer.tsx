"use client";
import * as React from "react";
import { toast } from "sonner";
import { Loader2, Paperclip, SendHorizontal, ShieldAlert, ShieldCheck, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Avatar, Kbd } from "@/components/ui/misc";
import { Tip } from "@/components/ui/overlays";
import { useLookup } from "@/hooks/use-directory";
import { ApiError } from "@/lib/api/mock";
import { formatBytes } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useSendMessage } from "../hooks";
import { isLive } from "@/lib/api/http";
import { liveCommsApi } from "../live-api";
import { ALLOWED_EXTENSIONS, FILE_LIMIT_BYTES, checkFile } from "../logic";

/** Live: files are uploaded at once and checked by ClamAV on the server; the message carries their ids. */
const LIVE = isLive("m14");
/** While the server is still checking a file (its scanner was busy or down), ask again this often. */
const SCAN_POLL_MS = 3000;

interface Pending {
  key: string;
  fileName: string;
  sizeBytes: number;
  mimeType: string;
  /** "uploading": on its way to the server (live). "blocked": malware was found; it can only be removed. */
  scan: "uploading" | "scanning" | "clean" | "blocked";
  /** Live: the uploaded file's id. */
  fileId?: string;
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

  // Live: files the server is still checking are asked about again until the check is done (stops when unmounted).
  const alive = React.useRef(true);
  React.useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const update = (key: string, patch: Partial<Pending>) => setFiles((p) => p.map((x) => (x.key === key ? { ...x, ...patch } : x)));
  const watch = (key: string, fileId: string) => {
    const check = async () => {
      if (!alive.current) return;
      try {
        const f = await liveCommsApi.fileStatus(fileId);
        if (f.discarded) {
          setFiles((p) => p.filter((x) => x.key !== key));
          return void toast(`${f.fileName} was removed`, { description: "It was not sent within a day. Attach it again to share it." });
        }
        if (f.scan === "scanning") return void setTimeout(check, SCAN_POLL_MS);
        update(key, { scan: f.scan });
        if (f.scan === "blocked") toast.error(`${f.fileName} was blocked`, { description: "Malware was found in it. It was removed and cannot be shared." });
      } catch {
        setTimeout(check, SCAN_POLL_MS * 2);
      }
    };
    setTimeout(check, SCAN_POLL_MS);
  };
  const uploadLive = async (key: string, f: File) => {
    try {
      const saved = await liveCommsApi.uploadFile(conversationId, f);
      update(key, { fileId: saved.id, scan: saved.scan, mimeType: saved.mimeType, sizeBytes: saved.sizeBytes });
      if (saved.scan === "scanning") watch(key, saved.id);
      if (saved.scan === "blocked") toast.error(`${f.name} was blocked`, { description: "Malware was found in it. It was removed and cannot be shared." });
    } catch (e) {
      setFiles((p) => p.filter((x) => x.key !== key));
      toast.error(`Can't attach ${f.name}`, { description: e instanceof ApiError ? e.message : "The upload failed." });
    }
  };

  const addFiles = (list: FileList | null) => {
    if (!list) return;
    Array.from(list).forEach((f) => {
      const err = checkFile(f.name, f.size);
      if (err) return toast.error(`Can't attach ${f.name}`, { description: err });
      const key = `${f.name}-${f.size}-${Math.random()}`;
      setFiles((p) => [...p, { key, fileName: f.name, sizeBytes: f.size, mimeType: f.type || "application/octet-stream", scan: LIVE ? "uploading" : "scanning" }]);
      if (LIVE) void uploadLive(key, f);
      else setTimeout(() => update(key, { scan: "clean" }), 1200 + Math.random() * 600);
    });
    if (fileRef.current) fileRef.current.value = "";
  };

  const scanning = files.some((f) => f.scan === "scanning" || f.scan === "uploading" || f.scan === "blocked");
  // Sending never blocks typing: Enter hands the message to an ordered send queue and the box is free at once.
  const canSend = !disabled && !scanning && (text.trim().length > 0 || files.length > 0);

  // Messages waiting to be sent, in the order they were written. They go out one at a time, so they keep their order.
  const queue = React.useRef<Array<{ body: string; attachments: Array<{ fileName: string; sizeBytes: number; mimeType: string }>; attachmentIds: string[] }>>([]);
  const draining = React.useRef(false);
  const [sending, setSending] = React.useState(false);

  const drain = async () => {
    if (draining.current) return;
    draining.current = true;
    setSending(true);
    try {
      while (queue.current.length) {
        const next = queue.current[0];
        try {
          await send.mutateAsync(
            LIVE ? { conversationId, parentId, body: next.body, attachmentIds: next.attachmentIds } : { conversationId, parentId, body: next.body, attachments: next.attachments },
          );
          queue.current.shift();
        } catch (e) {
          // Nothing is lost: what could not be sent goes back into the box, ahead of anything typed since.
          const unsent = queue.current.splice(0).map((m) => m.body).filter((b) => b.trim());
          if (unsent.length) setText((current) => [...unsent, current].filter((t) => t.trim()).join("\n"));
          toast.error(e instanceof ApiError ? e.message : "Couldn't send the message.", { description: "It is back in the message box." });
        }
      }
    } finally {
      draining.current = false;
      setSending(false);
    }
  };

  const submit = () => {
    if (!canSend) return;
    // A message needs some text: a message that is only files says which files it shares.
    const body = text.trim() ? text : files.map((f) => `📎 ${f.fileName}`).join("\n");
    queue.current.push({
      body,
      attachments: files.map(({ fileName, sizeBytes, mimeType }) => ({ fileName, sizeBytes, mimeType })),
      attachmentIds: files.flatMap((f) => (f.fileId ? [f.fileId] : [])),
    });
    // Only what was just sent leaves the box; the person can type the next message straight away.
    setText("");
    setFiles([]);
    setMention(null);
    void drain();
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
              {f.scan === "scanning" || f.scan === "uploading" ? (
                <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
              ) : f.scan === "blocked" ? (
                <ShieldAlert className="size-3.5 text-danger" />
              ) : (
                <ShieldCheck className="size-3.5 text-success" />
              )}
              <span className="max-w-40 truncate font-medium">{f.fileName}</span>
              <span className={cn("text-muted-foreground", f.scan === "blocked" && "font-medium text-danger")}>
                {f.scan === "uploading" ? "Uploading…" : f.scan === "scanning" ? "Scanning…" : f.scan === "blocked" ? "Blocked: malware" : formatBytes(f.sizeBytes)}
              </span>
              <button type="button" onClick={() => setFiles((p) => p.filter((x) => x.key !== f.key))} className="rounded p-0.5 text-muted-foreground hover:bg-card hover:text-foreground" aria-label={`Remove ${f.fileName}`}>
                <X className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex items-end gap-2 rounded-xl border border-input bg-background px-2 py-1.5 focus-within:border-ring focus-within:outline-2 focus-within:outline-ring/25">
        <input ref={fileRef} type="file" multiple hidden accept={ALLOWED_EXTENSIONS.map((e) => `.${e}`).join(",")} onChange={(e) => addFiles(e.target.files)} />
        <Tip content={`Attach files (up to ${Math.round(FILE_LIMIT_BYTES / 1024 / 1024)} MB: ${ALLOWED_EXTENSIONS.slice(0, 6).join(", ")}${ALLOWED_EXTENSIONS.length > 6 ? "…" : ""}). Every file is checked for viruses.`}>
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
          {sending ? <Loader2 className="animate-spin" /> : <SendHorizontal />}
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
