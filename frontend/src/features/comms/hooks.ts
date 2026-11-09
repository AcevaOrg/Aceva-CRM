"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSession } from "@/lib/auth/session";
import { commsApi } from "./api";
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

/** Polling keeps the mock "live"; a websocket replaces it when the backend lands. */
const LIVE = 4000;

export function useConversations() {
  const empId = useSession((s) => s.empId);
  return useQuery({ queryKey: commsKeys.conversations(empId), queryFn: commsApi.conversations, enabled: !!empId, refetchInterval: LIVE });
}

export function useMessages(id: string | undefined) {
  return useQuery({ queryKey: commsKeys.messages(id ?? ""), queryFn: () => commsApi.messages(id!), enabled: !!id, refetchInterval: LIVE });
}

export function useThread(id: string | undefined) {
  return useQuery({ queryKey: commsKeys.thread(id ?? ""), queryFn: () => commsApi.thread(id!), enabled: !!id, refetchInterval: LIVE });
}

export function useSavedMessages(enabled = true) {
  const empId = useSession((s) => s.empId);
  return useQuery({ queryKey: commsKeys.saved(empId), queryFn: commsApi.saved, enabled: !!empId && enabled });
}

export function usePresence() {
  return useQuery({ queryKey: commsKeys.presence, queryFn: commsApi.presence, refetchInterval: 30_000 });
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
