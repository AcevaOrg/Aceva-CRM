/**
 * Module 15 · Sales and CRM: leads, deals and daily sales work (plan §20)
 * Owner: Developer B (Phase 2, cycles 6 and 7). Spec §9.15.
 * This file is the API contract for the module.
 */
import type { Money } from "@/types";

export type LeadSource = "apollo" | "fiverr" | "linkedin" | "referral" | "website" | "field" | "walk_in";
export type EmailCheck = "valid" | "invalid" | "catch_all" | "unknown" | "unchecked";

export interface Company {
  id: string;
  name: string;
  website?: string;
  domain?: string;
  country?: string;
  industry?: string;
}

export interface Lead {
  id: string;
  name: string;
  title?: string;
  companyId: string;
  email?: string;
  phone?: string;
  linkedinUrl?: string;
  country?: string;
  industry?: string;
  source: LeadSource;
  ownerEmpId: string;
  emailCheck: EmailCheck;
  checkedAt?: string;
  doNotContact: boolean;
  notes?: string;
  lastActivityAt?: string;
  archived: boolean;
  createdAt: string;
}

/** What a salesperson sees for a lead owned by someone else (plan §20: exists + owner only). */
export interface LeadStub {
  id: string;
  name: string;
  companyName: string;
  ownerEmpId: string;
  restricted: true;
}

export type DealStage = "new" | "contacted" | "replied" | "meeting_booked" | "proposal_sent" | "negotiation" | "won" | "lost";
export type DealService = "website" | "custom_software" | "ai_automation" | "mobile_app" | "ecommerce";

export interface StageChange {
  stage: DealStage;
  at: string;
  by: string;
  note?: string;
}

export interface Handover {
  clientName: string;
  /** Draft invoice created in Billing (Module 13), checked and sent by the finance duty person. */
  invoiceNumber: string;
  ctoNotified: boolean;
  at: string;
}

export interface Deal {
  id: string;
  number: string;
  leadId: string;
  companyId: string;
  service: DealService;
  value: Money;
  expectedClose: string;
  stage: DealStage;
  nextStep?: string;
  nextStepDate?: string;
  ownerEmpId: string;
  lostReason?: string;
  recontactAfter?: string;
  /** Won by an executive waits for the sales manager (plan §20). */
  wonStatus?: "pending" | "confirmed";
  wonRequestedAt?: string;
  wonConfirmedBy?: string;
  previousStage?: DealStage;
  proposalUrl?: string;
  handover?: Handover;
  history: StageChange[];
  createdAt: string;
  updatedAt: string;
}

export type ActivityKind =
  | "email_sent" | "reply" | "bounce" | "call" | "meeting" | "linkedin" | "whatsapp" | "fiverr" | "proposal" | "note" | "email_check" | "follow_up";
export type ActivitySource = "apollo" | "millionverifier" | "mailbox" | "manual";

export interface SalesActivity {
  id: string;
  leadId?: string;
  dealId?: string;
  empId: string;
  kind: ActivityKind;
  at: string;
  source: ActivitySource;
  /** The tool's own ID, so a sync never counts the same item twice (plan §21). */
  externalId?: string;
  summary: string;
}

export interface DailyTargets {
  empId: string;
  leadsAdded: number;
  emailsChecked: number;
  emailsSent: number;
  followUps: number;
}

export interface MonthlyTargets {
  empId: string;
  month: string;
  meetings: number;
  proposals: number;
  wonValue: Money;
}

export interface SelfReported {
  linkedin: number;
  whatsapp: number;
  fiverr: number;
  calls: number;
  fieldVisits: number;
}

export interface ManualDailyLog extends SelfReported {
  id: string;
  empId: string;
  date: string;
  note?: string;
  proofRequested?: boolean;
  submittedAt: string;
}

/** One salesperson's day, built from the connected tools and the manual log (plan §20). */
export interface DailySalesSummary {
  id: string;
  empId: string;
  /** ISO day, e.g. 2026-12-08 */
  date: string;
  leadsAdded: { auto: number; manual: number };
  emailsChecked: number;
  invalid: number;
  emailsSent: { apollo: number; mailbox: number };
  replies: number;
  bounces: number;
  meetings: number;
  followUps: { auto: number; manual: number };
  selfReported: SelfReported;
  proofRequested?: boolean;
}

export interface FollowUp {
  dealId: string;
  dealNumber: string;
  companyName: string;
  leadName: string;
  nextStep: string;
  nextStepDate: string;
  missed: boolean;
  ownerEmpId: string;
}

export interface MySalesDay {
  empId: string;
  date: string;
  targets: DailyTargets;
  summary: DailySalesSummary;
  log?: ManualDailyLog;
  followUpsDue: FollowUp[];
  newReplies: (SalesActivity & { leadName: string; companyName: string })[];
  pipeline: PipelineStageSummary[];
  apolloLastSyncAt?: string;
}

export interface PipelineStageSummary {
  stage: DealStage;
  count: number;
  /** Total in USD at the saved exchange rate. */
  valueUsd: number;
}

export interface PipelineSummary {
  stages: PipelineStageSummary[];
  openValueUsd: number;
  openCount: number;
  wonThisMonthUsd: number;
  wonThisMonthCount: number;
  lostThisMonthCount: number;
  pendingWonCount: number;
}

export interface CommissionRule {
  id: string;
  name: string;
  /** Percent of the client's first payment. */
  ratePercent: number;
  effectiveFrom: string;
  setBy: string;
  active: boolean;
}

export type CommissionStatus = "calculated" | "approved" | "sent_to_payroll" | "rejected";

export interface CommissionLine {
  id: string;
  dealId: string;
  dealNumber: string;
  empId: string;
  invoiceNumber: string;
  invoicePaidAt: string;
  base: Money;
  ratePercent: number;
  amount: Money;
  status: CommissionStatus;
  approvedBy?: string;
  approvedAt?: string;
  payrollMonth?: string;
  rejectReason?: string;
}

export interface DncEntry {
  id: string;
  email: string;
  leadId?: string;
  reason: string;
  addedBy: string;
  at: string;
}

export interface SalesScorecard {
  empId: string;
  month: string;
  activity: number;
  meetings: number;
  won: number;
  dataQuality: number;
  attendance: number;
  score: number;
  weights: SalesWeights;
  detail: { daysMet: number; workingDays: number; meetingsBooked: number; meetingTarget: number; wonUsd: number; wonTargetUsd: number; bounceRate: number; duplicates: number };
}

export interface SalesWeights {
  activity: number;
  meetings: number;
  won: number;
  dataQuality: number;
  attendance: number;
}

export interface NewLeadInput {
  name: string;
  title?: string;
  companyName: string;
  website?: string;
  email?: string;
  phone?: string;
  linkedinUrl?: string;
  country?: string;
  industry?: string;
  source: LeadSource;
  notes?: string;
}

export interface DuplicateResult {
  duplicate: boolean;
  matchedOn?: "email" | "domain";
  leadId?: string;
  leadName?: string;
  companyName?: string;
  ownerEmpId?: string;
}

export interface ImportRow {
  line: number;
  name: string;
  email: string;
  companyName: string;
  website?: string;
  country?: string;
  title?: string;
  source: LeadSource;
  status: "ok" | "duplicate" | "invalid" | "repeated";
  message?: string;
  ownerEmpId?: string;
}

export interface VerifyPreview {
  toCheck: number;
  skippedRecent: number;
  creditsLeft: number;
}

export interface VerifyResult {
  checked: number;
  valid: number;
  invalid: number;
  catchAll: number;
  unknown: number;
  skippedRecent: number;
  creditsLeft: number;
}

export interface NewDealInput {
  leadId: string;
  service: DealService;
  value: Money;
  expectedClose: string;
  nextStep: string;
  nextStepDate: string;
}

export interface LogActivityInput {
  leadId: string;
  dealId?: string;
  kind: ActivityKind;
  summary: string;
  at?: string;
}

export interface LeadDetail {
  lead: Lead;
  company: Company;
  activities: SalesActivity[];
  deals: Deal[];
}

export interface DealDetail {
  deal: Deal;
  lead: Lead;
  company: Company;
  activities: SalesActivity[];
  commission?: CommissionLine;
}
