"use client";
import * as React from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { isLive } from "@/lib/api/http";
import { ApiError } from "@/lib/api/mock";
import { useSession } from "@/lib/auth/session";
import { commsApi } from "./api";
import type { CommsSettings } from "@aceva/contracts";
import { liveCommsApi } from "./live-api";
import { presenceStore } from "./live-store";
import { startCommsRealtime } from "./realtime";
import { upcomingMeetings } from "./logic";
import type { Message, MessagesData, NewAnnouncementInput, NewConversationInput, NewMeetingInput, Rsvp, SendMessageInput } from "./types";

export const commsKeys = {
  all: ["comms"] as const,
  conversations: (empId: string | null) => ["comms", "conversations", empId] as const,
  messages: (id: string) => ["comms", "messages", id] as const,
  pins: (id: string) => ["comms", "pins", id] as const,
  adminChannels: ["comms", "admin-channels"] as const,
  thread: (id: string) => ["comms", "thread", id] as const,
  saved: (empId: string | null) => ["comms", "saved", empId] as const,
  presence: ["comms", "presence"] as const,
  announcements: (empId: string | null) => ["comms", "announcements", empId] as const,
  meetings: (empId: string | null) => ["comms", "meetings", empId] as const,
  meeting: (id: string) => ["comms", "meeting", id] as const,
};

/** Live (m14): the WebSocket keeps every screen current, so nothing polls. The mock demo still polls to feel alive. */
const LIVE_API = isLive("m14");
const POLL = LIVE_API ? false : 4000;

export function useConversations() {
  const empId = useSession((s) => s.empId);
  return useQuery({ queryKey: commsKeys.conversations(empId), queryFn: commsApi.conversations, enabled: !!empId, refetchInterval: POLL });
}

/** "Not found" and "no access" are answers, not failures: they are shown at once instead of being tried again. */
const retryUnlessRefused = (count: number, error: unknown) => !(error instanceof ApiError && (error.status === 404 || error.status === 403)) && count < 1;

export function useMessages(id: string | undefined) {
  return useQuery({ queryKey: commsKeys.messages(id ?? ""), queryFn: () => commsApi.messages(id!), enabled: !!id, refetchInterval: POLL, retry: retryUnlessRefused });
}

/**
 * "Load older messages": the page just before the oldest one loaded, merged into the open conversation (no duplicates,
 * in order). Live updates keep merging into the same list, and a reload keeps what was loaded (realtime.ts).
 */
export function useLoadOlder(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const data = qc.getQueryData<MessagesData>(commsKeys.messages(id));
      if (!data?.hasMoreBefore || data.historyFrom === undefined) return;
      const page = await commsApi.older(id, data.historyFrom);
      qc.setQueryData<MessagesData>(commsKeys.messages(id), (cur) => {
        if (!cur) return cur;
        const byId = new Map<string, Message>();
        for (const m of [...page.messages, ...cur.messages]) if (!byId.has(m.id)) byId.set(m.id, m);
        const messages = [...byId.values()].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0) || a.at.localeCompare(b.at));
        return { ...cur, messages, hasMoreBefore: page.hasMoreBefore, historyFrom: Math.min(page.historyFrom, cur.historyFrom ?? page.historyFrom), olderLoaded: true };
      });
    },
  });
}

/** Every pinned message of a conversation (also those older than the loaded history), newest pin first. */
export function usePins(id: string, enabled: boolean, pinnedIds: readonly string[]) {
  return useQuery({ queryKey: [...commsKeys.pins(id), [...pinnedIds].sort().join(",")], queryFn: () => commsApi.pins(id), enabled, retry: retryUnlessRefused });
}

export function useThread(id: string | undefined) {
  return useQuery({ queryKey: commsKeys.thread(id ?? ""), queryFn: () => commsApi.thread(id!), enabled: !!id, refetchInterval: POLL, retry: retryUnlessRefused });
}

export function useSavedMessages(enabled = true) {
  const empId = useSession((s) => s.empId);
  return useQuery({ queryKey: commsKeys.saved(empId), queryFn: commsApi.saved, enabled: !!empId && enabled });
}

/** Online / offline (no "away", no "last seen"). Live: pushed by the WebSocket, never polled. */
export function usePresence() {
  const q = useQuery({ queryKey: commsKeys.presence, queryFn: commsApi.presence, refetchInterval: 30_000, enabled: !LIVE_API });
  const online = React.useSyncExternalStore(presenceStore.subscribe, presenceStore.online, presenceStore.online);
  const live = React.useMemo(() => online.map((empId) => ({ empId, state: "online" as const })), [online]);
  return LIVE_API ? { data: live } : q;
}

/** Module 14 live: opens this tab's WebSocket while someone is signed in (mounted once, in the app shell). */
export function useCommsRealtime() {
  const qc = useQueryClient();
  const empId = useSession((s) => s.empId);
  const stage = useSession((s) => s.stage);
  React.useEffect(() => {
    if (!LIVE_API || !empId || stage !== "signed_in") return;
    return startCommsRealtime(qc, empId);
  }, [qc, empId, stage]);
}

function useInvalidate() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: commsKeys.all });
}

export function useMarkConversationRead() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (id: string) => commsApi.markRead(id), onSuccess: () => qc.invalidateQueries({ queryKey: ["comms", "conversations"] }) });
}

export function useSendMessage() {
  const done = useInvalidate();
  return useMutation({ mutationFn: (input: SendMessageInput) => commsApi.send(input), onSuccess: done });
}

export function useEditMessage() {
  const done = useInvalidate();
  return useMutation({ mutationFn: ({ id, body }: { id: string; body: string }) => commsApi.edit(id, body), onSuccess: done });
}

export function useDeleteMessage() {
  const done = useInvalidate();
  return useMutation({ mutationFn: (id: string) => commsApi.remove(id), onSuccess: done });
}

export function useReact() {
  const done = useInvalidate();
  return useMutation({ mutationFn: ({ id, emoji }: { id: string; emoji: string }) => commsApi.react(id, emoji), onSuccess: done });
}

export function useToggleSave() {
  const done = useInvalidate();
  return useMutation({ mutationFn: (id: string) => commsApi.toggleSave(id), onSuccess: done });
}

export function useTogglePin() {
  const done = useInvalidate();
  return useMutation({ mutationFn: (id: string) => commsApi.togglePin(id), onSuccess: done });
}

export function useLinkTask() {
  const done = useInvalidate();
  return useMutation({ mutationFn: ({ id, taskId }: { id: string; taskId: string | null }) => commsApi.linkTask(id, taskId), onSuccess: done });
}

/** Rename a group or channel (who may is decided by the server: group moderators; channel moderators and comms admins). */
export function useRenameConversation() {
  const done = useInvalidate();
  return useMutation({ mutationFn: ({ id, name }: { id: string; name: string }) => commsApi.rename(id, name), onSuccess: done });
}

/** Change or clear the topic (the same people who may rename). */
export function useSetTopic() {
  const done = useInvalidate();
  return useMutation({ mutationFn: ({ id, topic }: { id: string; topic: string | null }) => commsApi.setTopic(id, topic), onSuccess: done });
}

/** Appoint or stop a moderator (channels: comms admins; groups: their moderators). They stay a member. */
export function useSetModerator() {
  const done = useInvalidate();
  return useMutation({ mutationFn: ({ id, empId, moderator }: { id: string; empId: string; moderator: boolean }) => commsApi.setModerator(id, empId, moderator), onSuccess: done });
}

/** Archive a group or channel with a reason: it stays readable for its members, nothing can change it any more. */
export function useArchiveConversation() {
  const done = useInvalidate();
  return useMutation({ mutationFn: ({ id, reason }: { id: string; reason: string }) => commsApi.archive(id, reason), onSuccess: done });
}

/** A moderator removes someone else's message, with a reason (audited; the text is never copied anywhere). */
export function useRemoveAsModerator() {
  const done = useInvalidate();
  return useMutation({ mutationFn: ({ id, reason }: { id: string; reason: string }) => commsApi.removeAsModerator(id, reason), onSuccess: done });
}

/** Live: the retention policy everyone is told in conversation details. */
export function useCommsPolicy() {
  return useQuery({ queryKey: ["comms", "policy"], queryFn: liveCommsApi.policy, enabled: LIVE_API, staleTime: 60_000 });
}

/** comms.admin: the retention settings and saving them (after "confirm again"; audited with the reason). */
export function useRetentionSettings(enabled: boolean) {
  return useQuery({ queryKey: ["comms", "retention"], queryFn: liveCommsApi.retentionSettings, enabled: LIVE_API && enabled });
}

export function useSaveRetention() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ value, version, reason }: { value: CommsSettings; version: number; reason: string }) => liveCommsApi.saveRetention(value, version, reason),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["comms"] }),
  });
}

/** comms.admin: Module 14 security and audit events (metadata only), newest first. */
export function useCommsAudit(filter: { action?: string; outcome?: "success" | "denied" }, enabled: boolean) {
  return useInfiniteQuery({
    queryKey: ["comms", "audit", filter.action ?? "", filter.outcome ?? ""],
    queryFn: ({ pageParam }) => liveCommsApi.auditEvents({ ...filter, cursor: pageParam ?? undefined }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled: LIVE_API && enabled,
  });
}

/** comms.admin: every channel with its members and moderators (never its messages). */
export function useAdminChannels(enabled: boolean) {
  return useQuery({ queryKey: commsKeys.adminChannels, queryFn: commsApi.adminChannels, enabled });
}

export function useAddMembers() {
  const done = useInvalidate();
  return useMutation({ mutationFn: ({ id, empIds }: { id: string; empIds: string[] }) => commsApi.addMembers(id, empIds), onSuccess: done });
}

/** Remove a member, or leave (with my own Emp-ID). */
export function useRemoveMember() {
  const done = useInvalidate();
  return useMutation({ mutationFn: ({ id, empId }: { id: string; empId: string }) => commsApi.removeMember(id, empId), onSuccess: done });
}

/** Message search: only conversations I can see now, and only from where my history starts (the server decides). */
export function useMessageSearch(q: string) {
  const empId = useSession((s) => s.empId);
  const term = q.trim();
  return useQuery({ queryKey: ["comms", "search", empId, term], queryFn: () => commsApi.search(term), enabled: !!empId && term.length >= 2, staleTime: 10_000 });
}

export function useCreateConversation() {
  const done = useInvalidate();
  return useMutation({ mutationFn: (input: NewConversationInput) => commsApi.create(input), onSuccess: done });
}

/* ---------------- Announcements ---------------- */

/**
 * Announcements the viewer can see, pinned first.
 * Each item: Announcement + { audienceEmpIds: string[]; acknowledgedByMe: boolean }.
 */
export function useAnnouncements() {
  const empId = useSession((s) => s.empId);
  return useQuery({ queryKey: commsKeys.announcements(empId), queryFn: commsApi.announcements, enabled: !!empId });
}

export function useAcknowledge() {
  const done = useInvalidate();
  return useMutation({ mutationFn: (id: string) => commsApi.acknowledge(id), onSuccess: done });
}

export function usePublishAnnouncement() {
  const done = useInvalidate();
  return useMutation({ mutationFn: (input: NewAnnouncementInput) => commsApi.publish(input), onSuccess: done });
}

export function useTogglePinAnnouncement() {
  const done = useInvalidate();
  return useMutation({ mutationFn: (id: string) => commsApi.togglePinAnnouncement(id), onSuccess: done });
}

/* ---------------- Meetings ---------------- */

export function useMeetings() {
  const empId = useSession((s) => s.empId);
  return useQuery({ queryKey: commsKeys.meetings(empId), queryFn: commsApi.meetings, enabled: !!empId });
}

/**
 * The viewer's next meetings (not cancelled, not yet ended), soonest first.
 * Returns { data: Meeting[] | undefined, isPending, isError, … } like any query.
 */
export function useUpcomingMeetings(limit = 5) {
  const empId = useSession((s) => s.empId);
  return useQuery({
    queryKey: commsKeys.meetings(empId),
    queryFn: commsApi.meetings,
    enabled: !!empId,
    select: (list) => upcomingMeetings(list, Date.now()).slice(0, limit),
  });
}

export function useMeeting(id: string) {
  // While a file of the meeting is being checked for viruses, look again every few seconds.
  return useQuery({
    queryKey: commsKeys.meeting(id),
    queryFn: () => commsApi.meeting(id),
    refetchInterval: (q) => (q.state.data?.meeting.attachments.some((a) => a.scan === "scanning") ? 5000 : false),
  });
}

export function useCreateMeeting() {
  const done = useInvalidate();
  return useMutation({ mutationFn: (input: NewMeetingInput) => commsApi.createMeeting(input), onSuccess: done });
}

export function useRsvp() {
  const done = useInvalidate();
  return useMutation({ mutationFn: ({ id, rsvp }: { id: string; rsvp: Rsvp }) => commsApi.rsvp(id, rsvp), onSuccess: done });
}

export function useSaveMeetingNotes() {
  const done = useInvalidate();
  return useMutation({ mutationFn: ({ id, notes }: { id: string; notes: string }) => commsApi.saveNotes(id, notes), onSuccess: done });
}

export function useCancelMeeting() {
  const done = useInvalidate();
  return useMutation({ mutationFn: ({ id, reason }: { id: string; reason: string }) => commsApi.cancelMeeting(id, reason), onSuccess: done });
}
