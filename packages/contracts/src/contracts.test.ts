import { describe, expect, it } from 'vitest';
import {
  BILLING_SETTINGS_DEFAULTS,
  billingSettingsSchema,
  commsMessageCreatedV1,
  createConversationSchema,
  editMessageSchema,
  markSeqSchema,
  mentionedEmpIds,
  MESSAGE_MAX_LENGTH,
  messageHistoryQuerySchema,
  messageSearchQuerySchema,
  reactionEmojiSchema,
  sendMessageSchema,
  containsCardNumber,
  createBillingInvoiceSchema,
  ESSENTIAL_NOTIFICATION_TYPES,
  recordInvoicePaymentSchema,
  resolveDealHandoverSchema,
  subscriptionCostSchema,
  healthResponseSchema,
  isEssentialNotificationType,
  markNotificationsReadSchema,
  notificationPrefsSchema,
  notificationSettingsSchema,
  notificationTypeSchema,
  outboxEventSchema,
  outboxEventSchemas,
  settingsModuleKeySchema,
  updateModuleSettingsSchema,
  ACTIVITY_MODULES,
  acknowledgeScorecardRequestSchema,
  activityEventsQuerySchema,
  addCommentRequestSchema,
  approveTaskRequestSchema,
  checkAlertRequestSchema,
  createTaskRequestSchema,
  decideApprovalRequestSchema,
  decideDisputeRequestSchema,
  disputeListQuerySchema,
  exportLogRequestSchema,
  heartbeatRequestSchema,
  liveQuerySchema,
  logoutRequestSchema,
  raiseDisputeRequestSchema,
  reasonActionRequestSchema,
  releaseScorecardRequestSchema,
  repeatRuleSchema,
  requestExtensionRequestSchema,
  saveScoreWeightsRequestSchema,
  scorecardListQuerySchema,
  scorecardRemarkRequestSchema,
  scoreWeightsQuerySchema,
  screenViewRequestSchema,
  summariesQuerySchema,
  taskListQuerySchema,
  updateSizeRuleRequestSchema,
  updateTaskRequestSchema,
} from './index';

const base = {
  id: '3f2b8c1e-5a4d-4e6b-9c7a-1d2e3f4a5b6c',
  version: 1,
  occurredAt: '2026-11-10T10:00:00.000Z',
  actor: 'ACV-0003',
};

describe('health contract', () => {
  it('accepts a valid response and rejects an invalid one', () => {
    const ok = { status: 'ok', database: 'up', time: '2026-11-10T10:00:00.000Z', version: '0.1.0' };
    expect(healthResponseSchema.safeParse(ok).success).toBe(true);
    expect(healthResponseSchema.safeParse({ ...ok, database: 'maybe' }).success).toBe(false);
  });
});

describe('outbox event contracts', () => {
  it('defines exactly the agreed events, all at version 1', () => {
    expect(Object.keys(outboxEventSchemas).sort()).toEqual([
      'activity.alert.raised',
      'activity.flagged',
      'attendance.correction.decided',
      'auth.login',
      'auth.login_failed',
      'auth.logout',
      'auth.security',
      'billing.invoice.issued',
      'billing.invoice.overdue',
      'billing.invoice.paid',
      'billing.subscription.renewal_due',
      'comms.announcement.published',
      'comms.meeting.cancelled',
      'comms.meeting.invited',
      'comms.member.removed',
      'comms.mention',
      'comms.message.changed',
      'comms.message.created',
      'employee.offboarded',
      'finance.period.reopened',
      'leave.decided',
      'leave.requested',
      'ledger.entry.posted',
      'payroll.final_settlement.requested',
      'task.approved',
      'task.comment_added',
      'task.created',
      'task.deadline_changed',
      'task.extension_decided',
      'task.extension_requested',
      'task.reminder.due',
      'task.reworked',
      'task.status_changed',
      'task.transferred',
      'payroll.run.approved',
      'payroll.run.ready',
      'payslip.issued',
      'sales.commission.approved',
      'sales.deal.won_confirmed',
      'task.transfer.requested',
      'scorecard.acknowledged',
      'scorecard.dispute_decided',
      'scorecard.dispute_raised',
      'scorecard.drafted',
      'scorecard.released',
      'score_weights.created',
    ].sort());
    for (const versions of Object.values(outboxEventSchemas)) {
      expect(Object.keys(versions)).toEqual(['1']);
    }
  });

  it('accepts a valid employee.offboarded event', () => {
    const event = {
      ...base,
      type: 'employee.offboarded',
      payload: { empId: 'ACV-0007', lastWorkingDay: '2026-12-31', managerEmpId: 'ACV-0004' },
    };
    expect(outboxEventSchema.safeParse(event).success).toBe(true);
  });

  it('rejects a payload that does not match its event type', () => {
    const event = { ...base, type: 'auth.logout', payload: { empId: 'ACV-0007' } };
    expect(outboxEventSchema.safeParse(event).success).toBe(false);
  });

  it('rejects an internal UUID where an Emp-ID is required', () => {
    const event = {
      ...base,
      type: 'task.transfer.requested',
      payload: { fromEmpId: base.id, toEmpId: 'ACV-0004', reason: 'employee_left' },
    };
    expect(outboxEventSchema.safeParse(event).success).toBe(false);
  });

  it('rejects an unknown version', () => {
    const event = {
      ...base,
      version: 2,
      type: 'auth.logout',
      payload: { empId: 'ACV-0007', sessionId: base.id, reason: 'user' },
    };
    expect(outboxEventSchema.safeParse(event).success).toBe(false);
  });
});

describe('Cycle 3 foundation contracts', () => {
  it('accepts a sales.deal.won_confirmed event with Emp-IDs and refuses a missing deal number', () => {
    const event = {
      ...base,
      type: 'sales.deal.won_confirmed',
      payload: { dealNumber: 'DEAL-2026-0001', ownerEmpId: 'ACV-0009', confirmedByEmpId: 'ACV-0003', client: { partyId: null, name: 'Globex', email: null, country: null }, service: 'Website', value: '1500.00', currency: 'USD' },
    };
    expect(outboxEventSchema.safeParse(event).success).toBe(true);
    expect(outboxEventSchema.safeParse({ ...event, payload: { ...event.payload, dealNumber: '' } }).success).toBe(false);
  });

  it('notification types: the essential ones are part of the list, and a preference is a partial map', () => {
    for (const type of ESSENTIAL_NOTIFICATION_TYPES) expect(notificationTypeSchema.safeParse(type).success).toBe(true);
    expect(isEssentialNotificationType('security_alert')).toBe(true);
    expect(isEssentialNotificationType('payslip_available')).toBe(false);
    expect(notificationPrefsSchema.safeParse({ email: { payslip_available: false }, dailySummary: true }).success).toBe(true);
    expect(notificationPrefsSchema.safeParse({ email: { not_a_type: false }, dailySummary: true }).success).toBe(false);
    expect(markNotificationsReadSchema.safeParse({ ids: [] }).success).toBe(false);
    expect(markNotificationsReadSchema.safeParse({}).success).toBe(true);
  });

  it('module settings: a key is lower case, a change carries a version and a reason', () => {
    expect(settingsModuleKeySchema.safeParse('notifications').success).toBe(true);
    expect(settingsModuleKeySchema.safeParse('Notifications').success).toBe(false);
    expect(updateModuleSettingsSchema.safeParse({ value: { emailEnabled: false }, version: 0, reason: 'Mail server is down' }).success).toBe(true);
    expect(updateModuleSettingsSchema.safeParse({ value: { emailEnabled: false }, version: 0, reason: 'x' }).success).toBe(false);
    expect(notificationSettingsSchema.safeParse({ emailEnabled: 'yes' }).success).toBe(false);
  });
});

describe('Module 13 billing contracts', () => {
  const uuid = '7d4f3a62-8f0e-4b8e-9a43-0c7a6c2c9a11';
  it('a recurring invoice needs a billing period; a one-time invoice has none', () => {
    const base = { requestKey: uuid, partyId: uuid, issueDate: '2026-11-18', termsDays: 14, lines: [{ description: 'Build', quantity: '1', unitPrice: '100.00' }] };
    expect(createBillingInvoiceSchema.safeParse(base).success).toBe(true);
    expect(createBillingInvoiceSchema.safeParse({ ...base, kind: 'recurring' }).success).toBe(false);
    expect(createBillingInvoiceSchema.safeParse({ ...base, kind: 'recurring', period: 'monthly' }).success).toBe(true);
    expect(createBillingInvoiceSchema.safeParse({ ...base, period: 'monthly' }).success).toBe(false);
  });

  it('a payment reference that contains a card number is refused; other references pass', () => {
    expect(containsCardNumber('Card 4111 1111 1111 1111')).toBe(true);
    expect(containsCardNumber('TT-778899 / 2026-11-18')).toBe(false);
    const p = { requestKey: uuid, bankAccountId: uuid, date: '2026-11-18', amount: '10.00', method: 'card_provider' };
    expect(recordInvoicePaymentSchema.safeParse({ ...p, reference: 'pi_3PqXyz' }).success).toBe(true);
    expect(recordInvoicePaymentSchema.safeParse({ ...p, reference: '4111-1111-1111-1111' }).success).toBe(false);
  });

  it('customer emails cannot be switched on without the sending address and the legal name; the defaults invent nothing', () => {
    expect(billingSettingsSchema.safeParse(BILLING_SETTINGS_DEFAULTS).success).toBe(true);
    expect(BILLING_SETTINGS_DEFAULTS.company.legalName).toBeNull();
    expect(BILLING_SETTINGS_DEFAULTS.customerEmails).toEqual({ enabled: false, fromAddress: null, replyTo: null });
    expect(BILLING_SETTINGS_DEFAULTS.reminderOffsets).toEqual([-3, 0, 3, 7]);
    const on = { ...BILLING_SETTINGS_DEFAULTS, customerEmails: { enabled: true, fromAddress: null, replyTo: null } };
    expect(billingSettingsSchema.safeParse(on).success).toBe(false);
    expect(billingSettingsSchema.safeParse({ ...on, customerEmails: { enabled: true, fromAddress: 'billing@company.test', replyTo: null }, company: { ...on.company, legalName: 'Company Ltd' } }).success).toBe(true);
  });

  it('a Won-deal handover is resolved by choosing exactly one client (no other fields)', () => {
    expect(resolveDealHandoverSchema.safeParse({ partyId: uuid }).success).toBe(true);
    expect(resolveDealHandoverSchema.safeParse({}).success).toBe(false);
    expect(resolveDealHandoverSchema.safeParse({ partyId: uuid, createClient: true }).success).toBe(false);
  });

  it('the default terms and income account are configurable development defaults (not fixed in code)', () => {
    expect(billingSettingsSchema.safeParse({ ...BILLING_SETTINGS_DEFAULTS, defaultTermsDays: 30, defaultIncomeAccountCode: '4200' }).success).toBe(true);
    expect(billingSettingsSchema.safeParse({ ...BILLING_SETTINGS_DEFAULTS, defaultIncomeAccountCode: null }).success).toBe(true);
  });

  it('an actual subscription cost needs a bill or the provider invoice reference', () => {
    expect(subscriptionCostSchema.safeParse({ amount: '10.00', currency: 'USD', estimated: true }).success).toBe(true);
    expect(subscriptionCostSchema.safeParse({ amount: '10.00', currency: 'USD', estimated: false }).success).toBe(false);
    expect(subscriptionCostSchema.safeParse({ amount: '10.00', currency: 'USD', estimated: false, reference: 'INV-77' }).success).toBe(true);
  });
});
describe('Module 14 part 1: conversation and message contracts', () => {
  const key = '3f2b8c1e-5a4d-4e6b-9c7a-1d2e3f4a5b6c';

  it('message text is plain text of 1 to 4,000 characters; Windows line endings become new lines', () => {
    expect(sendMessageSchema.parse({ clientKey: key, body: 'line one\r\nline two' }).body).toBe('line one\nline two');
    expect(sendMessageSchema.safeParse({ clientKey: key, body: 'x'.repeat(MESSAGE_MAX_LENGTH) }).success).toBe(true);
    expect(sendMessageSchema.safeParse({ clientKey: key, body: 'x'.repeat(MESSAGE_MAX_LENGTH + 1) }).success).toBe(false);
    expect(sendMessageSchema.safeParse({ clientKey: key, body: '   \n ' }).success).toBe(false);
    expect(sendMessageSchema.safeParse({ clientKey: key, body: 'bell\u0007' }).success).toBe(false);
    expect(sendMessageSchema.safeParse({ clientKey: 'not-a-uuid', body: 'hi' }).success).toBe(false);
    // HTML is just text: it is kept as typed and shown as text, never interpreted.
    expect(sendMessageSchema.parse({ clientKey: key, body: '<b>bold</b>' }).body).toBe('<b>bold</b>');
    expect(editMessageSchema.safeParse({ body: '' }).success).toBe(false);
  });

  it('mentions are Emp-ID tokens, never names', () => {
    expect(mentionedEmpIds('@ACV-0006 and @ACV-0007, again @ACV-0006')).toEqual(['ACV-0006', 'ACV-0007']);
    expect(mentionedEmpIds('@Fahad and email@ACV-00 and @ACV-00061x')).toEqual(['ACV-00061']);
    expect(mentionedEmpIds('no mentions')).toEqual([]);
  });

  it('a conversation is a DM, a group or a channel with the right fields', () => {
    expect(createConversationSchema.safeParse({ kind: 'dm', empId: 'ACV-0006' }).success).toBe(true);
    expect(createConversationSchema.safeParse({ kind: 'dm', empId: 'Fahad' }).success).toBe(false);
    expect(createConversationSchema.safeParse({ kind: 'group', memberEmpIds: [] }).success).toBe(false);
    expect(createConversationSchema.safeParse({ kind: 'group', memberEmpIds: ['ACV-0006', 'ACV-0006'] }).success).toBe(false);
    expect(createConversationSchema.safeParse({ kind: 'channel', scope: 'department', name: 'eng', departmentId: 'dep-eng' }).success).toBe(true);
    expect(createConversationSchema.safeParse({ kind: 'channel', scope: 'department', name: 'eng' }).success).toBe(false);
    expect(createConversationSchema.safeParse({ kind: 'channel', scope: 'project', name: 'web', projectName: 'Website', projectCode: 'WEB-1' }).success).toBe(true);
    expect(createConversationSchema.safeParse({ kind: 'channel', scope: 'project', name: 'web' }).success).toBe(false);
    expect(createConversationSchema.safeParse({ kind: 'channel', scope: 'project', name: 'web', projectName: 'Website', departmentId: 'dep-eng' }).success).toBe(false);
  });

  it('reactions are emoji; history uses before or after; read positions are whole numbers', () => {
    for (const ok of ['👍', '🎉', '❤️', '👍🏽', '🇵🇰']) expect(reactionEmojiSchema.safeParse(ok).success, ok).toBe(true);
    for (const bad of ['ok', '<b>', '', '1', '#']) expect(reactionEmojiSchema.safeParse(bad).success, bad).toBe(false);
    expect(messageHistoryQuerySchema.parse({ before: '10' })).toEqual({ before: 10, limit: 50 });
    expect(messageHistoryQuerySchema.safeParse({ before: '10', after: '2' }).success).toBe(false);
    expect(markSeqSchema.safeParse({ seq: -1 }).success).toBe(false);
    expect(messageSearchQuerySchema.safeParse({ q: 'a' }).success).toBe(false);
  });

  it('message events carry ids and Emp-IDs, never the text', () => {
    const created = {
      ...base,
      type: 'comms.message.created',
      payload: { conversationId: key, conversationKind: 'dm', messageId: key, seq: 1, authorEmpId: 'ACV-0006', parentMessageId: null, mentionedEmpIds: [] },
    };
    expect(outboxEventSchema.safeParse(created).success).toBe(true);
    expect(Object.keys(commsMessageCreatedV1.shape.payload.shape)).not.toContain('body');
    expect(outboxEventSchema.safeParse({ ...created, payload: { ...created.payload, seq: 0 } }).success).toBe(false);
    const removed = { ...base, type: 'comms.member.removed', payload: { conversationId: key, empId: 'ACV-0008', byEmpId: 'ACV-0006', reason: 'removed' } };
    expect(outboxEventSchema.safeParse(removed).success).toBe(true);
    expect(outboxEventSchema.safeParse({ ...removed, payload: { ...removed.payload, reason: 'kicked' } }).success).toBe(false);
  });
});

describe('Module 14, part 2: live delivery contract', () => {
  it('fixes the agreed socket limits and the passive-read header', async () => {
    const rt = await import('./realtime');
    expect(rt.MAX_SOCKETS_PER_PERSON).toBe(5);
    expect(rt.SOCKET_EVENTS_PER_SECOND).toBe(20);
    expect(rt.REALTIME_PATH).toBe('/socket.io');
    expect(rt.PASSIVE_REQUEST_HEADER).toBe('x-aceva-passive');
  });

  it('lets a browser send only the catch-up request; everything else is a change and goes through REST', async () => {
    const rt = await import('./realtime');
    expect([...rt.CLIENT_EVENTS]).toEqual(['sync']);
  });

  it('names every refusal a screen must handle', async () => {
    const rt = await import('./realtime');
    expect(rt.realtimeRefusalSchema.options.sort()).toEqual(
      ['auth_incomplete', 'forbidden', 'origin_not_allowed', 'realtime_unavailable', 'too_many_attempts', 'too_many_connections', 'unauthenticated'].sort(),
    );
    expect(rt.realtimeRefusalSchema.safeParse('kicked').success).toBe(false);
  });
});

describe('Module 14, part 2: message change events', () => {
  it('describe a change by ids only, never the text', async () => {
    const { outboxEventSchema } = await import('./events');
    const base = { id: '7f2c1f1e-1d2a-4f61-9c0e-4c3b9a5d1e10', version: 1, occurredAt: '2026-11-20T10:00:00.000Z', actor: 'ACV-0006' };
    const ids = { conversationId: '1b0b6b4e-2a7c-4d3e-9a6f-0c1d2e3f4a5b', messageId: '2c1c7c5f-3b8d-4e4f-8b7a-1d2e3f4a5b6c' };
    for (const change of ['edited', 'deleted', 'removed', 'reaction', 'pinned', 'unpinned']) {
      expect(outboxEventSchema.safeParse({ ...base, type: 'comms.message.changed', payload: { ...ids, change } }).success).toBe(true);
    }
    expect(outboxEventSchema.safeParse({ ...base, type: 'comms.message.changed', payload: { ...ids, change: 'renamed' } }).success).toBe(false);
    // Unknown keys (such as a body) are not part of the event.
    const parsed = outboxEventSchema.parse({ ...base, type: 'comms.message.changed', payload: { ...ids, change: 'edited', body: 'secret' } });
    expect(parsed.payload).not.toHaveProperty('body');
  });
});

describe('Module 4 event contracts', () => {
  it('a logout can end for every reason Module 4 understands, including from another device and after too many wrong codes', () => {
    const reasons = ['user', 'idle_timeout', 'max_duration', 'password_changed', 'forced', 'employee_left', 'user_other_device', 'too_many_wrong_codes'];
    for (const reason of reasons) {
      const event = { ...base, type: 'auth.logout', payload: { empId: 'ACV-0007', sessionId: base.id, reason } };
      expect(outboxEventSchema.safeParse(event).success).toBe(true);
    }
    expect(outboxEventSchema.safeParse({ ...base, type: 'auth.logout', payload: { empId: 'ACV-0007', sessionId: base.id, reason: 'shut_laptop' } }).success).toBe(false);
  });

  it('accepts a security event by an administrator and by the system', () => {
    const byAdmin = { ...base, type: 'auth.security', payload: { empId: 'ACV-0011', kind: 'account_locked', byEmpId: 'ACV-0003' } };
    const bySystem = { ...base, actor: 'system', type: 'auth.security', payload: { empId: 'ACV-0011', kind: 'account_locked', byEmpId: null } };
    expect(outboxEventSchema.safeParse(byAdmin).success).toBe(true);
    expect(outboxEventSchema.safeParse(bySystem).success).toBe(true);
    expect(outboxEventSchema.safeParse({ ...byAdmin, payload: { ...byAdmin.payload, kind: 'password_shown' } }).success).toBe(false);
  });

  it('accepts a flagged activity and a raised alert, never with internal UUIDs as Emp-IDs', () => {
    const flagged = { ...base, type: 'activity.flagged', payload: { eventId: base.id, empId: 'ACV-0008', kind: 'finance_blocked', at: base.occurredAt, module: 'Ledger', rows: null } };
    expect(outboxEventSchema.safeParse(flagged).success).toBe(true);
    expect(outboxEventSchema.safeParse({ ...flagged, payload: { ...flagged.payload, empId: base.id } }).success).toBe(false);
    const raised = { ...base, type: 'activity.alert.raised', payload: { alertId: base.id, kind: 'new_device', severity: 'medium', empId: 'ACV-0008' } };
    expect(outboxEventSchema.safeParse(raised).success).toBe(true);
    expect(outboxEventSchema.safeParse({ ...raised, payload: { ...raised.payload, severity: 'critical' } }).success).toBe(false);
  });
});

describe('Module 4 request contracts', () => {
  it('a logout without a body is a plain logout; the browser may say it timed out, and nothing else', () => {
    expect(logoutRequestSchema.parse(undefined)).toEqual({});
    expect(logoutRequestSchema.parse({})).toEqual({});
    expect(logoutRequestSchema.parse({ reason: 'idle_timeout', financeScreen: true })).toEqual({ reason: 'idle_timeout', financeScreen: true });
    expect(logoutRequestSchema.safeParse({ reason: 'forced' }).success).toBe(false);
    expect(logoutRequestSchema.safeParse({ reason: 'idle_timeout', extra: 1 }).success).toBe(false);
    expect(logoutRequestSchema.safeParse({ financeScreen: 'yes' }).success).toBe(false);
  });

  it('a heartbeat carries only a yes/no, nothing else (no keystrokes, no screen content)', () => {
    expect(heartbeatRequestSchema.safeParse({ active: true }).success).toBe(true);
    expect(heartbeatRequestSchema.safeParse({ active: 'yes' }).success).toBe(false);
    expect(heartbeatRequestSchema.safeParse({ active: true, keys: 'abc' }).success).toBe(false);
  });

  it('a screen view is a label and an optional page path', () => {
    expect(screenViewRequestSchema.safeParse({ screen: 'My tasks', path: '/tasks' }).success).toBe(true);
    expect(screenViewRequestSchema.safeParse({ screen: '' }).success).toBe(false);
    expect(screenViewRequestSchema.safeParse({ screen: 'Ledger', path: 'finance/ledger' }).success).toBe(false);
  });

  it('activity search treats empty filters as "any"', () => {
    const parsed = activityEventsQuerySchema.parse({ action: '', source: '', module: 'People', from: '2026-11-01', to: '2026-11-07' });
    expect(parsed).toEqual({ module: 'People', from: '2026-11-01', to: '2026-11-07' });
    expect(activityEventsQuerySchema.safeParse({ action: 'teleport' }).success).toBe(false);
    expect(activityEventsQuerySchema.safeParse({ empId: '42' }).success).toBe(false);
  });

  it('summaries need a date range that runs forwards', () => {
    expect(summariesQuerySchema.safeParse({ from: '2026-11-01', to: '2026-11-07', scope: 'team' }).success).toBe(true);
    expect(summariesQuerySchema.safeParse({ from: '2026-11-08', to: '2026-11-07' }).success).toBe(false);
  });

  it('checking an alert needs a note; an export log needs a row count and a format', () => {
    expect(checkAlertRequestSchema.safeParse({ note: 'Confirmed with the employee' }).success).toBe(true);
    expect(checkAlertRequestSchema.safeParse({ note: '  ' }).success).toBe(false);
    expect(exportLogRequestSchema.safeParse({ rows: 120, format: 'xlsx' }).success).toBe(true);
    expect(exportLogRequestSchema.safeParse({ rows: -1, format: 'xlsx' }).success).toBe(false);
    expect(exportLogRequestSchema.safeParse({ rows: 1, format: 'docx' }).success).toBe(false);
  });

  it('the activity search offers every module the server records, including Org (structure changes), and none twice', () => {
    expect(ACTIVITY_MODULES).toEqual(expect.arrayContaining(['Org', 'Home', 'Login', 'People', 'Ledger', 'Banking', 'Payroll', 'Statements', 'Sales', 'Announcements']));
    expect(new Set(ACTIVITY_MODULES).size).toBe(ACTIVITY_MODULES.length);
    // Every label is a valid search filter
    for (const module of ACTIVITY_MODULES) expect(activityEventsQuerySchema.safeParse({ module }).success).toBe(true);
  });
});

describe('Module 5 task contracts', () => {
  const task = '7d3f1c9a-2b4e-4a6d-8c1f-0e5a9b7c3d21';
  const create = { title: 'Fix login bug', assignee: 'ACV-0007', size: 'M', estimatedHours: 16, startDate: '2026-11-16T04:00:00.000Z', deadline: '2026-11-19T13:00:00.000Z' };

  it('creating a task needs a title, an assignee below you, a size, hours and a deadline; defaults are filled in', () => {
    const parsed = createTaskRequestSchema.parse(create);
    expect(parsed).toMatchObject({ priority: 'medium', description: '', checklist: [] });
    expect(createTaskRequestSchema.safeParse({ ...create, assignee: undefined }).success).toBe(false);
    expect(createTaskRequestSchema.safeParse({ ...create, assignee: '7' }).success).toBe(false);
    expect(createTaskRequestSchema.safeParse({ ...create, size: 'XXL' }).success).toBe(false);
    expect(createTaskRequestSchema.safeParse({ ...create, deadline: '2026-11-15T13:00:00.000Z' }).success).toBe(false);
    expect(createTaskRequestSchema.safeParse({ ...create, deadline: 'next week' }).success).toBe(false);
    expect(createTaskRequestSchema.safeParse({ ...create, estimatedHours: 0 }).success).toBe(false);
    expect(createTaskRequestSchema.safeParse({ ...create, surprise: 1 }).success).toBe(false);
  });

  it('refuses dates outside the years 2020 to 2100 (a far-off deadline such as 9999-12-31 is never a plan)', () => {
    for (const deadline of ['9999-12-31T00:00:00.000Z', '2101-01-01T00:00:00.000Z', '1999-12-31T23:59:59.000Z']) {
      expect(createTaskRequestSchema.safeParse({ ...create, startDate: '2026-11-16T04:00:00.000Z', deadline }).success).toBe(false);
      expect(updateTaskRequestSchema.safeParse({ deadline, reason: 'Client moved the date' }).success).toBe(false);
      expect(requestExtensionRequestSchema.safeParse({ requestedDeadline: deadline, reason: 'Waiting for the API keys' }).success).toBe(false);
    }
    expect(createTaskRequestSchema.safeParse({ ...create, startDate: '1970-01-01T00:00:00.000Z' }).success).toBe(false);
    expect(createTaskRequestSchema.safeParse({ ...create, deadline: '2100-12-31T23:59:59.000Z' }).success).toBe(true);
    expect(updateTaskRequestSchema.safeParse({ deadline: '2100-12-31T23:59:59.000Z', reason: 'Client moved the date' }).success).toBe(true);
  });

  it('a personal to-do has no assignee and never repeats', () => {
    const todo = { ...create, assignee: '', personal: true };
    expect(createTaskRequestSchema.safeParse(todo).success).toBe(true);
    expect(createTaskRequestSchema.safeParse({ ...todo, assignee: 'ACV-0007' }).success).toBe(false);
    expect(createTaskRequestSchema.safeParse({ ...todo, repeat: { every: 'week', on: 1 } }).success).toBe(false);
  });

  it('a repeat rule is weekly on a weekday 1 to 7 or monthly on a day 1 to 28, with an optional stop date', () => {
    expect(repeatRuleSchema.safeParse({ every: 'week', on: 1 }).success).toBe(true);
    expect(repeatRuleSchema.safeParse({ every: 'week', on: 1, until: '2027-03-01' }).success).toBe(true);
    expect(repeatRuleSchema.safeParse({ every: 'week', on: 8 }).success).toBe(false);
    expect(repeatRuleSchema.safeParse({ every: 'month', on: 28 }).success).toBe(true);
    expect(repeatRuleSchema.safeParse({ every: 'month', on: 29 }).success).toBe(false);
    expect(repeatRuleSchema.safeParse({ every: 'year', on: 1 }).success).toBe(false);
  });

  it('an empty edit is refused; the reason for a deadline change is checked by the server (a personal to-do needs none)', () => {
    expect(updateTaskRequestSchema.safeParse({ deadline: '2026-11-20T13:00:00.000Z', reason: 'Client moved the date' }).success).toBe(true);
    expect(updateTaskRequestSchema.safeParse({ deadline: '2026-11-20T13:00:00.000Z' }).success).toBe(true);
    expect(updateTaskRequestSchema.safeParse({ reason: 'Because' }).success).toBe(false);
    expect(updateTaskRequestSchema.safeParse({ title: 'New title' }).success).toBe(true);
  });

  it('approve needs a rating from 1 to 5; rework, hold and cancel need a reason', () => {
    expect(approveTaskRequestSchema.safeParse({ rating: 5, comment: 'Great' }).success).toBe(true);
    expect(approveTaskRequestSchema.safeParse({ rating: 0 }).success).toBe(false);
    expect(approveTaskRequestSchema.safeParse({ rating: 6 }).success).toBe(false);
    expect(approveTaskRequestSchema.safeParse({ rating: 3.5 }).success).toBe(false);
    expect(approveTaskRequestSchema.safeParse({}).success).toBe(false);
    expect(reasonActionRequestSchema.safeParse({ reason: 'Tests are missing' }).success).toBe(true);
    expect(reasonActionRequestSchema.safeParse({ reason: '  ' }).success).toBe(false);
    expect(reasonActionRequestSchema.safeParse({}).success).toBe(false);
  });

  it('an extension asks for a new date and says why; a comment cannot be empty', () => {
    expect(requestExtensionRequestSchema.safeParse({ requestedDeadline: '2026-11-25T13:00:00.000Z', reason: 'Waiting for the API keys' }).success).toBe(true);
    expect(requestExtensionRequestSchema.safeParse({ requestedDeadline: '2026-11-25T13:00:00.000Z' }).success).toBe(false);
    expect(addCommentRequestSchema.safeParse({ body: 'Thanks @Mariam' }).success).toBe(true);
    expect(addCommentRequestSchema.safeParse({ body: '   ' }).success).toBe(false);
  });

  it('the task list treats empty filters as "any" and only knows the three scopes', () => {
    expect(taskListQuerySchema.parse({})).toEqual({ scope: 'mine' });
    expect(taskListQuerySchema.parse({ scope: 'team', status: '', assignee: 'ACV-0008', includePersonal: 'true' })).toEqual({ scope: 'team', assignee: 'ACV-0008', includePersonal: true });
    expect(taskListQuerySchema.safeParse({ scope: 'everyone' }).success).toBe(false);
    expect(taskListQuerySchema.safeParse({ status: 'late' }).success).toBe(false);
  });

  it('the task list can ask for open tasks only, or for the closed ones older than 90 days too', () => {
    expect(taskListQuerySchema.parse({ open: 'true', closed: 'all' })).toEqual({ scope: 'mine', open: true, closed: 'all' });
    expect(taskListQuerySchema.parse({ open: '', closed: '' })).toEqual({ scope: 'mine' });
    expect(taskListQuerySchema.parse({ closed: 'recent' })).toEqual({ scope: 'mine', closed: 'recent' });
    expect(taskListQuerySchema.safeParse({ closed: 'never' }).success).toBe(false);
    expect(taskListQuerySchema.safeParse({ open: 'maybe' }).success).toBe(false);
  });

  it('a size rule change needs a reason and at least one change', () => {
    expect(updateSizeRuleRequestSchema.safeParse({ hours: 20, reason: 'Our M tasks run longer' }).success).toBe(true);
    expect(updateSizeRuleRequestSchema.safeParse({ reason: 'Our M tasks run longer' }).success).toBe(false);
    expect(updateSizeRuleRequestSchema.safeParse({ hours: 20 }).success).toBe(false);
    expect(updateSizeRuleRequestSchema.safeParse({ points: -1, reason: 'Our M tasks run longer' }).success).toBe(false);
  });

  it('an approval decision may carry a rating, a reason and a comment, and nothing else', () => {
    expect(decideApprovalRequestSchema.parse(undefined)).toEqual({});
    expect(decideApprovalRequestSchema.safeParse({ rating: 4, comment: 'Good' }).success).toBe(true);
    expect(decideApprovalRequestSchema.safeParse({ rating: 9 }).success).toBe(false);
    expect(decideApprovalRequestSchema.safeParse({ secret: 1 }).success).toBe(false);
  });

  it('the task events accept Emp-IDs, never internal UUIDs, and carry what Module 6 needs', () => {
    const approved = {
      ...base,
      type: 'task.approved',
      payload: {
        taskId: task, number: 'TSK-0001', assignee: 'ACV-0007', reviewer: 'ACV-0004', rating: 4, size: 'M', points: 3, estimatedHours: 16,
        deadline: '2026-11-19T13:00:00.000Z', originalDeadline: '2026-11-18T13:00:00.000Z', startedAt: '2026-11-16T05:00:00.000Z', submittedAt: '2026-11-19T10:00:00.000Z',
        onTime: true, extensionsCount: 1, reworkCount: 0,
      },
    };
    expect(outboxEventSchema.safeParse(approved).success).toBe(true);
    expect(outboxEventSchema.safeParse({ ...approved, payload: { ...approved.payload, rating: 6 } }).success).toBe(false);
    expect(outboxEventSchema.safeParse({ ...approved, payload: { ...approved.payload, assignee: task } }).success).toBe(false);
    const reworked = { ...base, type: 'task.reworked', payload: { taskId: task, number: 'TSK-0001', assignee: 'ACV-0007', reviewer: 'ACV-0004', reason: 'Tests missing', reworkCount: 1 } };
    expect(outboxEventSchema.safeParse(reworked).success).toBe(true);
    expect(outboxEventSchema.safeParse({ ...reworked, payload: { ...reworked.payload, reworkCount: 0 } }).success).toBe(false);
    const reminder = { ...base, actor: 'system', type: 'task.reminder.due', payload: { taskId: task, number: 'TSK-0001', kind: 'overdue', recipients: ['ACV-0007', 'ACV-0004'], deadline: '2026-11-19T13:00:00.000Z', day: '2026-11-20' } };
    expect(outboxEventSchema.safeParse(reminder).success).toBe(true);
    expect(outboxEventSchema.safeParse({ ...reminder, payload: { ...reminder.payload, recipients: [] } }).success).toBe(false);
    expect(outboxEventSchema.safeParse({ ...reminder, payload: { ...reminder.payload, kind: 'whenever' } }).success).toBe(false);
  });
});

describe('Module 6 request contracts', () => {
  it('the live figures and the scorecard list take an optional Emp-ID; empty filters mean "any"; latest accepts 1 or true', () => {
    expect(liveQuerySchema.parse({})).toEqual({});
    expect(liveQuerySchema.parse({ empId: '' })).toEqual({});
    expect(liveQuerySchema.safeParse({ empId: 'not-an-id' }).success).toBe(false);
    expect(scorecardListQuerySchema.parse({ empId: 'ACV-0007', latest: '1' })).toEqual({ empId: 'ACV-0007', latest: true });
    expect(scorecardListQuerySchema.parse({ latest: 'false', month: '2026-10', limit: '12' })).toEqual({ latest: false, month: '2026-10', limit: 12 });
    expect(scorecardListQuerySchema.safeParse({ month: '2026-13' }).success).toBe(false);
    expect(scorecardListQuerySchema.safeParse({ limit: '500' }).success).toBe(false);
  });

  it('a remark needs some words; a release and an acknowledgement may carry a note but need none', () => {
    expect(scorecardRemarkRequestSchema.safeParse({ remark: 'ok' }).success).toBe(false);
    expect(scorecardRemarkRequestSchema.safeParse({ remark: 'Steady month, keep going.' }).success).toBe(true);
    expect(releaseScorecardRequestSchema.parse(undefined)).toEqual({});
    expect(releaseScorecardRequestSchema.safeParse({ remark: 'Good.' }).success).toBe(true);
    expect(acknowledgeScorecardRequestSchema.parse(undefined)).toEqual({});
    expect(acknowledgeScorecardRequestSchema.safeParse({ comment: 'Thanks.' }).success).toBe(true);
    expect(acknowledgeScorecardRequestSchema.safeParse({ comment: 'Thanks.', extra: 1 }).success).toBe(false);
  });

  it('a dispute names the scorecard, a task number and a real reason', () => {
    const ok = { scorecardId: '3f2b8c1e-5a4d-4e6b-9c7a-1d2e3f4a5b6c', taskNumber: 'TSK-0142', reason: 'The client changed the brief twice.' };
    expect(raiseDisputeRequestSchema.safeParse(ok).success).toBe(true);
    expect(raiseDisputeRequestSchema.safeParse({ ...ok, taskNumber: 'TODO-0001' }).success).toBe(false);
    expect(raiseDisputeRequestSchema.safeParse({ ...ok, scorecardId: 'sc_0006_2026-10' }).success).toBe(false);
    expect(raiseDisputeRequestSchema.safeParse({ ...ok, reason: 'no' }).success).toBe(false);
  });

  it('a decision keeps the rating or changes it; the new rating is 1 to 5 and the reason is required', () => {
    expect(decideDisputeRequestSchema.safeParse({ change: false, decision: 'Rating kept.' }).success).toBe(true);
    expect(decideDisputeRequestSchema.safeParse({ change: true, decision: 'Fair point.', newRating: 4 }).success).toBe(true);
    expect(decideDisputeRequestSchema.safeParse({ change: true, decision: 'Fair point.', newRating: 6 }).success).toBe(false);
    expect(decideDisputeRequestSchema.safeParse({ change: true, decision: 'Fair point.', newRating: 3.5 }).success).toBe(false);
    expect(decideDisputeRequestSchema.safeParse({ change: false, decision: '' }).success).toBe(false);
    expect(disputeListQuerySchema.parse({ status: '' })).toEqual({});
    expect(disputeListQuerySchema.safeParse({ status: 'whatever' }).success).toBe(false);
  });

  it('new score weights name a kind, whole-number weights and a reason (the server checks the sum of 100 and the metric names)', () => {
    const ok = { kind: 'standard', weights: { quality: 35, onTime: 25, completion: 20, rework: 10, attendance: 10 }, reason: 'Deadlines matter more' };
    expect(saveScoreWeightsRequestSchema.safeParse(ok).success).toBe(true);
    expect(saveScoreWeightsRequestSchema.safeParse({ ...ok, kind: 'executive' }).success).toBe(false);
    expect(saveScoreWeightsRequestSchema.safeParse({ ...ok, weights: { quality: '35' } }).success).toBe(false);
    expect(saveScoreWeightsRequestSchema.safeParse({ ...ok, reason: '' }).success).toBe(false);
    expect(saveScoreWeightsRequestSchema.safeParse({ ...ok, departmentId: 'dep-eng' }).success).toBe(false);
    expect(saveScoreWeightsRequestSchema.safeParse({ ...ok, departmentId: '3f2b8c1e-5a4d-4e6b-9c7a-1d2e3f4a5b6c' }).success).toBe(true);
    expect(scoreWeightsQuerySchema.parse({ kind: '', departmentId: '' })).toEqual({});
  });
});

describe('Module 6 event contracts', () => {
  const card = { scorecardId: '3f2b8c1e-5a4d-4e6b-9c7a-1d2e3f4a5b6c', empId: 'ACV-0007', month: '2026-10', kind: 'standard' };

  it('a draft scorecard names the reviewer (none for the Director) and may have no score', () => {
    const drafted = { ...base, actor: 'system', type: 'scorecard.drafted', payload: { ...card, reviewer: 'ACV-0004', score: 84.6, taskCount: 6, smallSample: false } };
    expect(outboxEventSchema.safeParse(drafted).success).toBe(true);
    expect(outboxEventSchema.safeParse({ ...drafted, payload: { ...drafted.payload, reviewer: null, score: null } }).success).toBe(true);
    expect(outboxEventSchema.safeParse({ ...drafted, payload: { ...drafted.payload, score: 120 } }).success).toBe(false);
    expect(outboxEventSchema.safeParse({ ...drafted, payload: { ...drafted.payload, month: '2026-10-01' } }).success).toBe(false);
    expect(outboxEventSchema.safeParse({ ...drafted, payload: { ...drafted.payload, reviewer: card.scorecardId } }).success).toBe(false);
  });

  it('released and acknowledged scorecards', () => {
    const released = { ...base, type: 'scorecard.released', payload: { ...card, releasedBy: 'ACV-0004', automatic: false, hasRemark: true } };
    expect(outboxEventSchema.safeParse(released).success).toBe(true);
    expect(outboxEventSchema.safeParse({ ...released, actor: 'system', payload: { ...released.payload, releasedBy: null, automatic: true } }).success).toBe(true);
    const acknowledged = { ...base, actor: 'ACV-0007', type: 'scorecard.acknowledged', payload: { ...card, reviewer: 'ACV-0004', hasComment: false } };
    expect(outboxEventSchema.safeParse(acknowledged).success).toBe(true);
  });

  it('disputes: raised, and decided with the score before and after', () => {
    const raised = {
      ...base,
      actor: 'ACV-0007',
      type: 'scorecard.dispute_raised',
      payload: { disputeId: card.scorecardId, scorecardId: card.scorecardId, empId: 'ACV-0007', month: '2026-10', taskId: card.scorecardId, taskNumber: 'TSK-0142', ratingAtRaise: 3, decider: 'ACV-0003' },
    };
    expect(outboxEventSchema.safeParse(raised).success).toBe(true);
    expect(outboxEventSchema.safeParse({ ...raised, payload: { ...raised.payload, ratingAtRaise: 0 } }).success).toBe(false);
    const decided = {
      ...base,
      type: 'scorecard.dispute_decided',
      payload: { disputeId: card.scorecardId, scorecardId: card.scorecardId, empId: 'ACV-0007', month: '2026-10', taskNumber: 'TSK-0142', decision: 'changed', decidedBy: 'ACV-0003', ratingBefore: 3, ratingAfter: 5, scoreBefore: 80.1, scoreAfter: 83.4 },
    };
    expect(outboxEventSchema.safeParse(decided).success).toBe(true);
    expect(outboxEventSchema.safeParse({ ...decided, payload: { ...decided.payload, decision: 'upheld', ratingAfter: null, scoreBefore: null, scoreAfter: null } }).success).toBe(true);
    expect(outboxEventSchema.safeParse({ ...decided, payload: { ...decided.payload, decision: 'maybe' } }).success).toBe(false);
  });

  it('a new version of the score weights', () => {
    const created = {
      ...base,
      type: 'score_weights.created',
      payload: { versionId: card.scorecardId, kind: 'sales', departmentId: null, versionNo: 2, weights: { activity: 20, meetings: 25, won: 30, dataQuality: 10, attendance: 15 }, previousVersionId: card.scorecardId },
    };
    expect(outboxEventSchema.safeParse(created).success).toBe(true);
    expect(outboxEventSchema.safeParse({ ...created, payload: { ...created.payload, weights: { activity: 0.2 } } }).success).toBe(false);
    expect(outboxEventSchema.safeParse({ ...created, payload: { ...created.payload, versionNo: 0 } }).success).toBe(false);
  });
});

describe('Module 15.1: leads and companies contracts', () => {
  it('normalises emails and website domains for the duplicate check, without guessing', async () => {
    const { normalizeEmail, websiteDomain } = await import('./sales');
    expect(normalizeEmail('  Ayesha.Khan@Acme.COM ')).toBe('ayesha.khan@acme.com');
    expect(normalizeEmail('a+b@x.io')).toBe('a+b@x.io'); // "+" and dots are kept: no rule says otherwise
    expect(websiteDomain('https://www.Acme.com/about?x=1')).toBe('acme.com');
    expect(websiteDomain('acme.com')).toBe('acme.com');
    expect(websiteDomain('http://WWW.acme.co.uk.')).toBe('acme.co.uk');
    expect(websiteDomain('shop.acme.com')).toBe('shop.acme.com'); // sub-domains are not merged
    expect(websiteDomain('localhost')).toBeNull();
    expect(websiteDomain('http://192.168.1.10')).toBeNull();
    expect(websiteDomain('ftp://acme.com')).toBeNull();
    expect(websiteDomain('not a website')).toBeNull();
    expect(websiteDomain('   ')).toBeNull();
  });

  it('a lead needs a name and a source from the plan list; email, website and LinkedIn must be real addresses', async () => {
    const { createSalesLeadSchema, SALES_LEAD_SOURCES } = await import('./sales');
    expect([...SALES_LEAD_SOURCES]).toEqual(['apollo', 'fiverr', 'linkedin', 'referral', 'website', 'field', 'walk_in']);
    const ok = createSalesLeadSchema.parse({ fullName: ' Ayesha Khan ', source: 'linkedin', email: 'ayesha@acme.com', company: { name: 'Acme', website: 'acme.com' } });
    expect(ok.fullName).toBe('Ayesha Khan');
    expect(createSalesLeadSchema.parse({ fullName: 'A', source: 'walk_in', email: '' }).email).toBeNull();
    expect(createSalesLeadSchema.safeParse({ fullName: 'A', source: 'cold_call' }).success).toBe(false);
    expect(createSalesLeadSchema.safeParse({ fullName: '  ', source: 'website' }).success).toBe(false);
    expect(createSalesLeadSchema.safeParse({ fullName: 'A', source: 'website', email: 'not-an-email' }).success).toBe(false);
    expect(createSalesLeadSchema.safeParse({ fullName: 'A', source: 'website', company: { name: 'X', website: 'nope' } }).success).toBe(false);
    expect(createSalesLeadSchema.safeParse({ fullName: 'A', source: 'website', companyId: '00000000-0000-4000-8000-000000000000', company: { name: 'X' } }).success).toBe(false);
    expect(createSalesLeadSchema.safeParse({ fullName: 'A', source: 'website', ownerEmpId: 'bob' }).success).toBe(false);
  });

  it('edits name the version they read and change something; reassigning needs a reason', async () => {
    const { updateSalesLeadSchema, updateSalesCompanySchema, reassignSalesLeadSchema, salesDuplicateCheckSchema } = await import('./sales');
    expect(updateSalesLeadSchema.safeParse({ notes: 'Called' }).success).toBe(false);
    expect(updateSalesLeadSchema.safeParse({ version: 1 }).success).toBe(false);
    expect(updateSalesLeadSchema.parse({ phone: null, version: 2 })).toMatchObject({ phone: null, version: 2 });
    expect(updateSalesCompanySchema.safeParse({ version: 1 }).success).toBe(false);
    expect(reassignSalesLeadSchema.safeParse({ toEmpId: 'ACV-0012', reason: 'ok', version: 1 }).success).toBe(false);
    expect(reassignSalesLeadSchema.safeParse({ toEmpId: 'ACV-0012', reason: 'Taking over the account', version: 1 }).success).toBe(true);
    expect(salesDuplicateCheckSchema.safeParse({}).success).toBe(false);
  });

  it('the settings start with no shared domains (nothing invented); entries must be plain domains', async () => {
    const { salesSettingsSchema, SALES_SETTINGS_DEFAULTS } = await import('./sales');
    expect(SALES_SETTINGS_DEFAULTS.sharedWebsiteDomains).toEqual([]);
    expect(salesSettingsSchema.parse({ sharedWebsiteDomains: ['Fiverr.com'] }).sharedWebsiteDomains).toEqual(['fiverr.com']);
    expect(salesSettingsSchema.safeParse({ sharedWebsiteDomains: ['https://fiverr.com'] }).success).toBe(false);
    expect(salesSettingsSchema.safeParse({ sharedWebsiteDomains: ['www.fiverr.com'] }).success).toBe(false);
    expect(salesSettingsSchema.safeParse({ sharedWebsiteDomains: ['a.com', 'a.com'] }).success).toBe(false);
  });
});

describe('Module 15.2: deals and pipeline contracts', () => {
  it('the eight stages of the plan, in order; six are open', async () => {
    const { SALES_DEAL_STAGES, SALES_OPEN_STAGES, isOpenDealStage, SALES_DEAL_SERVICES } = await import('./sales');
    expect([...SALES_DEAL_STAGES]).toEqual(['new', 'contacted', 'replied', 'meeting_booked', 'proposal_sent', 'negotiation', 'won', 'lost']);
    expect([...SALES_OPEN_STAGES]).toEqual(['new', 'contacted', 'replied', 'meeting_booked', 'proposal_sent', 'negotiation']);
    expect(isOpenDealStage('won')).toBe(false);
    expect(isOpenDealStage('lost')).toBe(false);
    expect([...SALES_DEAL_SERVICES]).toEqual(['website', 'custom_software', 'ai_automation', 'mobile_app', 'ecommerce']);
  });

  it('a deal needs a service, an amount, PKR or USD, dates and a next step', async () => {
    const { createSalesDealSchema } = await import('./sales');
    const ok = { leadId: '00000000-0000-4000-8000-000000000001', service: 'website', value: '1500.50', currency: 'USD', expectedClose: '2026-12-31', nextStep: 'Call', nextStepDate: '2026-12-08' };
    expect(createSalesDealSchema.safeParse(ok).success).toBe(true);
    expect(createSalesDealSchema.safeParse({ ...ok, currency: 'EUR' }).success).toBe(false);
    expect(createSalesDealSchema.safeParse({ ...ok, value: '12.345' }).success).toBe(false);
    expect(createSalesDealSchema.safeParse({ ...ok, value: '-1' }).success).toBe(false);
    expect(createSalesDealSchema.safeParse({ ...ok, nextStep: ' ' }).success).toBe(false);
    expect(createSalesDealSchema.safeParse({ ...ok, nextStepDate: '08/12/2026' }).success).toBe(false);
  });

  it('Won is never a move; Lost needs a reason; edits and decisions name a version; sending back needs a reason', async () => {
    const { moveSalesDealSchema, updateSalesDealSchema, rejectSalesWonSchema, salesDealVersionSchema } = await import('./sales');
    expect(moveSalesDealSchema.safeParse({ toStage: 'won', version: 1 }).success).toBe(false);
    expect(moveSalesDealSchema.safeParse({ toStage: 'lost', version: 1 }).success).toBe(false);
    expect(moveSalesDealSchema.safeParse({ toStage: 'lost', lostReason: 'Price', version: 1 }).success).toBe(true);
    expect(moveSalesDealSchema.safeParse({ toStage: 'contacted', version: 1 }).success).toBe(true);
    expect(moveSalesDealSchema.safeParse({ toStage: 'contacted' }).success).toBe(false);
    expect(updateSalesDealSchema.safeParse({ version: 1 }).success).toBe(false);
    expect(rejectSalesWonSchema.safeParse({ reason: 'no', version: 1 }).success).toBe(false);
    expect(salesDealVersionSchema.safeParse({ version: 0 }).success).toBe(false);
  });

  it('lost reasons and the re-contact period start unset (nothing invented); stored settings without them still read', async () => {
    const { salesSettingsSchema, SALES_SETTINGS_DEFAULTS } = await import('./sales');
    // M15.5 adds the archive period, whose default is the plan's own 12 months (approved decision 9)
    expect(SALES_SETTINGS_DEFAULTS).toEqual({ sharedWebsiteDomains: [], lostReasons: [], recontactMonths: null, archiveMonths: 12 });
    expect(salesSettingsSchema.parse({ sharedWebsiteDomains: [] })).toEqual({ sharedWebsiteDomains: [], lostReasons: [], recontactMonths: null, archiveMonths: 12 });
    expect(salesSettingsSchema.safeParse({ sharedWebsiteDomains: [], lostReasons: ['Price', 'price'], recontactMonths: 6 }).success).toBe(false);
    expect(salesSettingsSchema.safeParse({ sharedWebsiteDomains: [], lostReasons: ['Price'], recontactMonths: 0 }).success).toBe(false);
  });
});

describe('Module 15.3: activities and follow-ups contracts', () => {
  it('the manual kinds of the plan (and Fiverr), a follow-up kind, and the sources; contacts move a deal forward', async () => {
    const { SALES_MANUAL_ACTIVITY_KINDS, SALES_ACTIVITY_KINDS, SALES_ACTIVITY_SOURCES, SALES_ACTIVITY_STAGE } = await import('./sales');
    expect([...SALES_MANUAL_ACTIVITY_KINDS]).toEqual(['call', 'email_sent', 'reply', 'meeting', 'linkedin', 'whatsapp', 'fiverr', 'proposal', 'note']);
    expect(SALES_ACTIVITY_KINDS).toContain('follow_up');
    expect([...SALES_ACTIVITY_SOURCES]).toEqual(['manual', 'apollo', 'millionverifier', 'mailbox']);
    expect(SALES_ACTIVITY_STAGE).toEqual({ call: 'contacted', email_sent: 'contacted', linkedin: 'contacted', whatsapp: 'contacted', fiverr: 'contacted', reply: 'replied' });
  });

  it('a reply moves a deal only from Contacted (never New straight to Replied); the reasons a stage stays are named', async () => {
    const { SALES_ACTIVITY_MOVES_FROM, SALES_STAGE_NOT_CHANGED_REASONS } = await import('./sales');
    expect(SALES_ACTIVITY_MOVES_FROM).toEqual({ reply: ['contacted'] });
    expect([...SALES_STAGE_NOT_CHANGED_REASONS]).toEqual(['deal_closed', 'won_pending', 'not_forward', 'needs_contacted']);
  });

  it('a logged activity: a manual kind and a summary; a meeting date only on a meeting; a web link only on a proposal', async () => {
    const { logSalesActivitySchema } = await import('./sales');
    expect(logSalesActivitySchema.safeParse({ kind: 'call', summary: 'Called' }).success).toBe(true);
    expect(logSalesActivitySchema.safeParse({ kind: 'follow_up', summary: 'Done' }).success).toBe(false); // written by the follow-up route only
    expect(logSalesActivitySchema.safeParse({ kind: 'bounce', summary: 'x' }).success).toBe(false); // Module 16
    expect(logSalesActivitySchema.safeParse({ kind: 'call', summary: ' ' }).success).toBe(false);
    expect(logSalesActivitySchema.safeParse({ kind: 'meeting', summary: 'Booked', meetingAt: '2026-12-10T10:00:00+05:00' }).success).toBe(true);
    expect(logSalesActivitySchema.safeParse({ kind: 'call', summary: 'x x', meetingAt: '2026-12-10T10:00:00Z' }).success).toBe(false);
    expect(logSalesActivitySchema.safeParse({ kind: 'proposal', summary: 'Sent', proposalUrl: 'https://docs.example.com/p' }).success).toBe(true);
    expect(logSalesActivitySchema.safeParse({ kind: 'proposal', summary: 'Sent', proposalUrl: 'ftp://docs.example.com/p' }).success).toBe(false);
    expect(logSalesActivitySchema.safeParse({ kind: 'note', summary: 'x x', proposalUrl: 'https://docs.example.com/p' }).success).toBe(false);
    expect(logSalesActivitySchema.safeParse({ kind: 'call', summary: 'x x', at: 'yesterday' }).success).toBe(false);
  });

  it('completing a follow-up names the next step, its date and the version; the list query has safe defaults', async () => {
    const { completeSalesFollowUpSchema, salesFollowUpListQuerySchema } = await import('./sales');
    expect(completeSalesFollowUpSchema.safeParse({ nextStep: 'Send scope', nextStepDate: '2026-12-10', version: 3 }).success).toBe(true);
    expect(completeSalesFollowUpSchema.safeParse({ nextStep: 'Send scope', nextStepDate: '2026-12-10' }).success).toBe(false);
    expect(salesFollowUpListQuerySchema.parse({})).toEqual({ scope: 'mine', status: 'all' });
    expect(salesFollowUpListQuerySchema.safeParse({ scope: 'everyone' }).success).toBe(false);
  });
});

describe('Module 15.4: do-not-contact and import contracts', () => {
  it('masks an email to its first character and domain, never more', async () => {
    const { maskEmail } = await import('./sales');
    expect(maskEmail(' Ayesha.Khan@Northwind.co.uk ')).toBe('a***@northwind.co.uk');
    expect(maskEmail('x@y.test')).toBe('x***@y.test');
    expect(maskEmail('not-an-email')).toBe('***');
  });

  it('a reason is required to mark a lead or add an email; the email must be a real address', async () => {
    const { markSalesLeadDncSchema, addSalesDncEmailSchema } = await import('./sales');
    expect(markSalesLeadDncSchema.safeParse({ reason: 'Asked us not to' }).success).toBe(true);
    expect(markSalesLeadDncSchema.safeParse({ reason: ' x ' }).success).toBe(false);
    expect(addSalesDncEmailSchema.safeParse({ email: ' a@b.test ', reason: 'Unsubscribed' }).success).toBe(true);
    expect(addSalesDncEmailSchema.safeParse({ email: 'a@', reason: 'Unsubscribed' }).success).toBe(false);
  });

  it('blocks only the approved outgoing kinds; sources and limits are the approved ones', async () => {
    const c = await import('./sales');
    expect([...c.SALES_DNC_BLOCKED_KINDS]).toEqual(['call', 'email_sent', 'linkedin', 'whatsapp', 'meeting', 'proposal']);
    expect([...c.SALES_DNC_SOURCES]).toEqual(['manual', 'apollo', 'mailbox']);
    expect([...c.SALES_IMPORT_COLUMNS]).toEqual(['name', 'email', 'company', 'website', 'country', 'title', 'source']);
    expect([c.SALES_IMPORT_MAX_BYTES, c.SALES_IMPORT_MAX_ROWS, c.SALES_IMPORT_PREVIEW_MINUTES]).toEqual([2 * 1024 * 1024, 5000, 30]);
    expect([...c.SALES_IMPORT_ROW_STATUSES]).toEqual(['ok', 'duplicate', 'repeated', 'dnc', 'invalid']);
  });

  it('a preview names a valid source for the file; the owner is optional', async () => {
    const { salesImportPreviewSchema } = await import('./sales');
    expect(salesImportPreviewSchema.safeParse({ source: 'apollo' }).success).toBe(true);
    expect(salesImportPreviewSchema.safeParse({ source: 'apollo', ownerEmpId: 'ACV-0009' }).success).toBe(true);
    expect(salesImportPreviewSchema.safeParse({ source: 'newsletter' }).success).toBe(false);
    expect(salesImportPreviewSchema.safeParse({}).success).toBe(false);
  });
});

describe('Module 15.5: archiving and leavers contracts', () => {
  it('the archive period is a setting: 12 months by default, 1 to 120', async () => {
    const { salesSettingsSchema, SALES_SETTINGS_DEFAULTS } = await import('./sales');
    expect(SALES_SETTINGS_DEFAULTS.archiveMonths).toBe(12);
    expect(salesSettingsSchema.parse({ sharedWebsiteDomains: [] }).archiveMonths).toBe(12);
    expect(salesSettingsSchema.safeParse({ sharedWebsiteDomains: [], archiveMonths: 6 }).success).toBe(true);
    for (const bad of [0, 121, 1.5]) expect(salesSettingsSchema.safeParse({ sharedWebsiteDomains: [], archiveMonths: bad }).success, String(bad)).toBe(false);
  });

  it('archiving removes exactly the approved contact details; the reasons are named', async () => {
    const c = await import('./sales');
    expect([...c.SALES_ARCHIVE_CLEARED_FIELDS]).toEqual(['email', 'phone', 'linkedinUrl']);
    expect([...c.SALES_ARCHIVE_REASONS]).toEqual(['inactive']);
    expect([...c.SALES_REASSIGNMENT_ISSUE_REASONS]).toEqual(['no_recipient']);
  });
});

describe('Module 15.6: targets, daily log, proof and report contracts', () => {
  it('daily metrics are the plan’s four; emails checked is not measured; monthly are meetings, proposals and deals won', async () => {
    const c = await import('./sales');
    expect([...c.SALES_DAILY_METRICS]).toEqual(['leadsAdded', 'emailsChecked', 'emailsSent', 'followUpsDone']);
    expect([...c.SALES_UNMEASURED_METRICS]).toEqual(['emailsChecked']);
    expect([...c.SALES_MONTHLY_METRICS]).toEqual(['meetingsBooked', 'proposalsSent', 'wonValue']);
    expect([...c.SALES_LOG_FIELDS]).toEqual(['linkedin', 'whatsapp', 'fiverr', 'calls', 'fieldVisits']);
    expect([...c.SALES_PROOF_STATUSES]).toEqual(['open', 'answered', 'closed']);
  });

  it('targets are whole numbers from 0 to 10,000 (null clears one); a deals-won target needs a positive amount and USD or PKR', async () => {
    const { setSalesDailyTargetsSchema, setSalesMonthlyTargetsSchema } = await import('./sales');
    const base = { empId: 'ACV-0009', effectiveFrom: '2026-12-10' };
    expect(setSalesDailyTargetsSchema.safeParse({ ...base, leadsAdded: 30, emailsChecked: null }).success).toBe(true);
    for (const bad of [-1, 10_001, 2.5]) expect(setSalesDailyTargetsSchema.safeParse({ ...base, leadsAdded: bad }).success, String(bad)).toBe(false);
    expect(setSalesDailyTargetsSchema.safeParse(base).success).toBe(false); // nothing to set
    expect(setSalesMonthlyTargetsSchema.safeParse({ empId: 'ACV-0009', month: '2026-12', wonValue: { amount: '5000.00', currency: 'USD' } }).success).toBe(true);
    expect(setSalesMonthlyTargetsSchema.safeParse({ empId: 'ACV-0009', month: '2026-12', wonValue: { amount: '0', currency: 'USD' } }).success).toBe(false);
    expect(setSalesMonthlyTargetsSchema.safeParse({ empId: 'ACV-0009', month: '2026-12', wonValue: { amount: '10.00', currency: 'EUR' } }).success).toBe(false);
    expect(setSalesMonthlyTargetsSchema.safeParse({ empId: 'ACV-0009', month: '2026-13', meetingsBooked: 2 }).success).toBe(false);
  });

  it('a log names the version it read and has counts from 0 to 1,000; proof notes need a reason', async () => {
    const { submitSalesDailyLogSchema, requestSalesProofSchema, answerSalesProofSchema } = await import('./sales');
    const log = { linkedin: 1, whatsapp: 0, fiverr: 0, calls: 2, fieldVisits: 0, version: 0 };
    expect(submitSalesDailyLogSchema.safeParse(log).success).toBe(true);
    expect(submitSalesDailyLogSchema.safeParse({ ...log, version: undefined }).success).toBe(false);
    expect(submitSalesDailyLogSchema.safeParse({ ...log, calls: 1001 }).success).toBe(false);
    expect(requestSalesProofSchema.safeParse({ empId: 'ACV-0009', day: '2026-12-08', note: 'ok' }).success).toBe(false);
    expect(answerSalesProofSchema.safeParse({ answer: 'Sent by message' }).success).toBe(true);
  });

  it('the two new notification types exist and are not essential (people may switch their emails off)', async () => {
    const n = await import('./notifications');
    for (const t of ['sales_daily_report', 'sales_proof_requested'] as const) {
      expect(n.notificationTypeSchema.safeParse(t).success, t).toBe(true);
      expect(n.isEssentialNotificationType(t), t).toBe(false);
    }
  });
});
