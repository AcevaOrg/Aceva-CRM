import { z } from 'zod';

// ---------------------------------------------------------------------------
// The approvals inbox (spec 4.5): every module that needs someone's decision adds its items here, so the person sees
// them in one place. The shapes are frontend/src/features/approvals/types.ts. Module 5 adds task_review and extension.
// ---------------------------------------------------------------------------

export const APPROVAL_TYPES = [
  'task_review',
  'extension',
  'leave',
  'attendance_correction',
  'journal_entry',
  'payroll',
  'month_close',
  'commission',
  'won_deal',
  'scorecard',
  'dispute',
] as const;
export const approvalTypeSchema = z.enum(APPROVAL_TYPES);
export type ApprovalTypeName = z.infer<typeof approvalTypeSchema>;

/**
 * POST /approvals/:id/approve and /approvals/:id/reject. `:id` is the item id, for example "task_review:<task id>" or
 * "extension:<extension id>" (URL-encode the colon). Approving a task review needs a `rating` 1 to 5; rejecting it (send
 * to rework) and rejecting an extension need a `reason`. Other item types add their own requirements.
 */
export const decideApprovalRequestSchema = z
  .object({
    reason: z.string().trim().min(3, 'Please give a reason (at least 3 characters)').max(500).optional(),
    rating: z.number().int().min(1).max(5).optional(),
    comment: z.string().trim().max(1000).optional(),
  })
  .strict()
  .default({});
export type DecideApprovalRequest = z.infer<typeof decideApprovalRequestSchema>;

export interface ApprovalItemView {
  /** Unique across modules: "<type>:<ref id>". */
  id: string;
  type: ApprovalTypeName;
  refId: string;
  refNumber?: string;
  title: string;
  subtitle?: string;
  /** Emp-ID of the person who asked. */
  requester: string;
  from?: string;
  to?: string;
  createdAt: string;
  /** The screen to open (an app path, for example /tasks/<id>). */
  href: string;
  needsStepUp?: boolean;
  /** Task reviews need a 1 to 5 rating on approve. */
  needsRating?: boolean;
  approveLabel?: string;
  rejectLabel?: string;
  /** Oversight lists only: the Emp-ID of the person who must decide. */
  waitingFor?: string;
}

/** GET /approvals */
export interface ApprovalsListResponse {
  items: ApprovalItemView[];
  /** How many requests the caller made that were routed to someone else (maker-checker). */
  routedUp: number;
}
