/**
 * Module 14 live: what the screen remembers between REST answers and socket events. Kept in memory only (never in
 * storage): the latest server view of each message (for the toggles: reacted? pinned? saved?), the highest message
 * number known per conversation (to notice a gap and catch up), names, members, and who is online.
 */
import type { ConversationSummary, LiveMessageView, MessageView } from "@aceva/contracts";

/** The latest server view of each message, with the edit revision it carried (an older revision never wins). */
export const messageIndex = new Map<string, LiveMessageView & { savedByMe?: boolean; revision?: number }>();
/** Highest message number this screen has caught up to, per conversation. */
export const knownSeq = new Map<string, number>();
/** Conversation summaries (for titles of saved messages, previews). */
export const conversationIndex = new Map<string, ConversationSummary>();
/** Current members (Emp-IDs) per conversation, from the conversation detail. */
export const membersOf = new Map<string, string[]>();
/** Names the server sent (members, DM partners). */
export const names = new Map<string, string>();

export function rememberMessage(view: MessageView | LiveMessageView, revision?: number): void {
  const previous = messageIndex.get(view.id);
  if (previous?.revision !== undefined && revision !== undefined && revision < previous.revision) return;
  messageIndex.set(view.id, { ...previous, ...view, revision: revision ?? previous?.revision });
}

export function noteSeq(conversationId: string, seq: number): void {
  knownSeq.set(conversationId, Math.max(knownSeq.get(conversationId) ?? 0, seq));
}

// ---------------- presence (online/offline only) ----------------

const online = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;
let snapshot: string[] = [];

function changed() {
  version++;
  snapshot = [...online].sort();
  listeners.forEach((l) => l());
}

export const presenceStore = {
  replace(list: string[]) {
    online.clear();
    list.forEach((e) => online.add(e));
    changed();
  },
  set(empId: string, isOnline: boolean) {
    if (isOnline === online.has(empId)) return;
    if (isOnline) online.add(empId);
    else online.delete(empId);
    changed();
  },
  clear() {
    if (!online.size) return;
    online.clear();
    changed();
  },
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  /** A stable array (same reference until something changes). */
  online: () => snapshot,
  version: () => version,
};

/** Forget everything (sign-out). */
export function resetLiveStore(): void {
  messageIndex.clear();
  knownSeq.clear();
  conversationIndex.clear();
  membersOf.clear();
  names.clear();
  presenceStore.clear();
}
