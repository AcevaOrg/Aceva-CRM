import { z } from 'zod';
import type { ConversationKind, MessageView } from './comms';

/**
 * Module 14, part 2: live delivery over a WebSocket (Socket.IO 4.8, WebSocket transport only).
 *
 * REST stays the only way to change anything (send, edit, delete, react, pin, read). The socket only tells the screen
 * what happened, after it is saved. Every message carries its sequence number, so a screen that missed something (a
 * dropped connection, a server restart, a Redis outage) catches up from the REST history (`?after=N`): the database is
 * always the truth, the socket is a fast hint.
 *
 * Signing in: the browser's HttpOnly session cookie is sent with the WebSocket handshake. A socket never makes a
 * session last longer (only the person's own activity does). Ending the session (logout, timeout, a forced logout,
 * a password change, leaving the company) closes the socket at once.
 *
 * Presence is online or offline only, never stored, never a score, and shown only to people who share a direct message
 * or a group with the person (never in channels).
 */

/** Socket.IO path on the API server (outside /api/v1). */
export const REALTIME_PATH = '/socket.io';
/** At most this many open sockets per person, across all servers (tabs and devices together). */
export const MAX_SOCKETS_PER_PERSON = 5;
/** At most this many packets per second from one socket. */
export const SOCKET_EVENTS_PER_SECOND = 20;
/** Largest packet a browser may send (it only sends small requests and acknowledgements). */
export const SOCKET_MAX_PACKET_BYTES = 16_384;
/** A request with this header (value "1") is "passive": it checks the session without counting as activity. */
export const PASSIVE_REQUEST_HEADER = 'x-aceva-passive';
/**
 * The screen a request comes from, when the route itself does not say: "finance" for the heartbeat sent while a finance
 * screen is open, so the session keeps the 10-minute finance idle limit (also for its live socket). It can only make the
 * limit stricter.
 */
export const SCREEN_HEADER = 'x-aceva-screen';

/** Why a connection was refused (in `connect_error`: `err.data.code`). */
export const realtimeRefusalSchema = z.enum([
  'origin_not_allowed',
  'unauthenticated',
  'auth_incomplete',
  'forbidden',
  'too_many_connections',
  'too_many_attempts',
  'realtime_unavailable',
]);
export type RealtimeRefusal = z.infer<typeof realtimeRefusalSchema>;

/** Why the server closed a socket (sent as `session.ended` / `closing` just before it disconnects). */
export const realtimeCloseReasonSchema = z.enum(['session_ended', 'rate_limited', 'unknown_event', 'forbidden']);
export type RealtimeCloseReason = z.infer<typeof realtimeCloseReasonSchema>;

/** A message as the socket sends it: the same view as REST, without the per-person `savedByMe` (the screen keeps its own). */
export type LiveMessageView = Omit<MessageView, 'savedByMe'>;

// ---------- Server to browser ----------

export interface MessageCreatedEvent {
  conversationId: string;
  seq: number;
  message: LiveMessageView;
}

/** An edit, a deletion, a moderator removal, a reaction or a pin changed a message. `revision` counts text changes. */
export interface MessageUpdatedEvent {
  conversationId: string;
  seq: number;
  revision: number;
  message: LiveMessageView;
}

/** Someone's delivered/read position moved. DMs and groups: every member gets it; channels: only that person. */
export interface ReceiptEvent {
  conversationId: string;
  empId: string;
  lastDeliveredSeq: number;
  lastReadSeq: number;
}

/** A conversation I can see changed (new, renamed, members, moderators, archived): reload it. */
export interface ConversationChangedEvent {
  conversationId: string;
  kind: ConversationKind;
}

/** I can no longer see this conversation (removed, left, moved out of the department). */
export interface ConversationRemovedEvent {
  conversationId: string;
}

export interface PresenceEvent {
  empId: string;
  online: boolean;
}

/** Sent once after connecting: the people I share a DM or group with who are online now. */
export interface PresenceSnapshotEvent {
  online: string[];
}

/** Live delivery may have missed something (the relay reconnected): catch up from the REST history. */
export interface SyncRequiredEvent {
  reason: 'relay_reconnected';
}

export interface SessionEndedEvent {
  reason: 'session_ended';
}

export interface ServerToClientEvents {
  'message.created': (event: MessageCreatedEvent, ack: (reply: { ok: true }) => void) => void;
  'message.updated': (event: MessageUpdatedEvent) => void;
  'receipt.updated': (event: ReceiptEvent) => void;
  'conversation.changed': (event: ConversationChangedEvent) => void;
  'conversation.removed': (event: ConversationRemovedEvent) => void;
  presence: (event: PresenceEvent) => void;
  'presence.snapshot': (event: PresenceSnapshotEvent) => void;
  'sync.required': (event: SyncRequiredEvent) => void;
  'session.ended': (event: SessionEndedEvent) => void;
  closing: (event: { reason: RealtimeCloseReason }) => void;
}

// ---------- Browser to server ----------

/** "What are the latest message numbers in my conversations?" (for catching up after a reconnect). */
export interface SyncReply {
  conversations: Array<{ id: string; lastSeq: number }>;
}

export type RealtimeErrorReply = { error: 'rate_limited' | 'invalid' };

export interface ClientToServerEvents {
  sync: (ack: (reply: SyncReply | RealtimeErrorReply) => void) => void;
}

/** The only events a browser may send. Anything else closes the socket. */
export const CLIENT_EVENTS = ['sync'] as const satisfies ReadonlyArray<keyof ClientToServerEvents>;
