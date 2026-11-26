"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/controls";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Avatar } from "@/components/ui/misc";
import { useLookup } from "@/hooks/use-directory";
import { ApiError } from "@/lib/api/mock";
import { cn } from "@/lib/utils";
import { useAddMembers, useRemoveMember } from "../hooks";
import type { Conversation } from "../types";

/**
 * Add people to a group or channel (moderators; comms admins for channels). The server checks the permission again and
 * starts each new member's history now: they never see what was said before they joined.
 */
export function AddMembersDialog({ conversation, onClose }: { conversation: Conversation; onClose: () => void }) {
  const lookup = useLookup();
  const add = useAddMembers();
  const [q, setQ] = React.useState("");
  const [selected, setSelected] = React.useState<string[]>([]);
  const needle = q.trim().toLowerCase();
  const people = lookup.employees.filter(
    (e) => e.status !== "left" && !conversation.memberEmpIds.includes(e.empId) && (!needle || `${e.name} ${e.empId} ${e.designation}`.toLowerCase().includes(needle)),
  );
  const toggle = (id: string) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  const submit = async () => {
    try {
      await add.mutateAsync({ id: conversation.id, empIds: selected });
      toast.success(selected.length === 1 ? "Added. They see messages from now on." : `${selected.length} people added. They see messages from now on.`);
      onClose();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't add them.");
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>Add people</DialogTitle>
          <DialogDescription>New members see messages from the moment they are added, never the earlier history.</DialogDescription>
        </DialogHeader>
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search people" className="pl-8" aria-label="Search people to add" />
        </div>
        <ul className="max-h-64 overflow-y-auto rounded-lg border border-border scrollbar-thin" aria-label="People to add">
          {people.length === 0 && <li className="px-3 py-3 text-[13px] text-muted-foreground">Nobody else to add.</li>}
          {people.map((e) => {
            const on = selected.includes(e.empId);
            return (
              <li key={e.empId} className="border-b border-border last:border-0">
                <div className={cn("flex items-center gap-3 px-3 py-2 hover:bg-muted", on && "bg-accent/60")}>
                  <Checkbox checked={on} onCheckedChange={() => toggle(e.empId)} aria-label={`Add ${e.name}`} />
                  <button type="button" onClick={() => toggle(e.empId)} className="flex min-w-0 flex-1 items-center gap-3 text-left">
                    <Avatar name={e.name} hue={e.avatarHue} size={26} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-medium">{e.name}</span>
                      <span className="block truncate text-[11.5px] text-muted-foreground">{e.designation}</span>
                    </span>
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!selected.length} loading={add.isPending}>
            {selected.length > 1 ? `Add ${selected.length} people` : "Add"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Remove a member (moderators; comms admins for channels), or leave when `empId` is the viewer. Access ends at once. */
export function RemoveMemberDialog({ conversation, empId, leaving, onClose }: { conversation: Conversation; empId: string; leaving: boolean; onClose: () => void }) {
  const lookup = useLookup();
  const remove = useRemoveMember();
  const router = useRouter();
  const name = lookup.employee(empId)?.name ?? empId;

  const submit = async () => {
    try {
      await remove.mutateAsync({ id: conversation.id, empId });
      toast.success(leaving ? "You left the conversation." : `${name} was removed.`);
      onClose();
      if (leaving) router.push("/messages");
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : leaving ? "Couldn't leave." : "Couldn't remove them.");
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>{leaving ? "Leave this conversation?" : `Remove ${name}?`}</DialogTitle>
          <DialogDescription>
            {leaving
              ? "You will stop seeing its messages at once. Someone can add you again later; you would then see only new messages."
              : `${name.split(" ")[0]} stops seeing this conversation at once, on every device. If added again later, they see only new messages.`}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={submit} loading={remove.isPending}>
            {leaving ? "Leave" : "Remove"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
