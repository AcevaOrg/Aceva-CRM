"use client";
import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { isLive } from "@/lib/api/http";
import { ApiError } from "@/lib/api/mock";
import { useSession } from "@/lib/auth/session";
import { commsApi } from "./api";
import { presenceStore } from "./live-store";
import { startCommsRealtime } from "./realtime";
import { upcomingMeetings } from "./logic";
import type { NewAnnouncementInput, NewConversationInput, NewMeetingInput, Rsvp, SendMessageInput } from "./types";

export const commsKeys = {
  all: ["comms"] as const,
  conversations: (empId: string | null) => ["comms", "conversations", empId] as const,
  messages: (id: string) => ["comms", "messages", id] as const,
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
  return useQuery({ queryKey: commsKeys.meeting(id), queryFn: () => commsApi.meeting(id) });
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
  return useMutation({ mutationFn: (id: string) => commsApi.cancelMeeting(id), onSuccess: done });
}
