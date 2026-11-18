import { describe, expect, it, vi } from 'vitest';
import type { Actor } from '../access/access.types';
import { PerformanceApprovalsProvider } from './performance-approvals.provider';

/** What a decision in the inbox is handed to: the scorecard and dispute services (their own rules are tested with the database). */
function setup() {
  const inbox = { register: vi.fn() };
  const scorecards = { release: vi.fn().mockResolvedValue(undefined), addRemark: vi.fn().mockResolvedValue(undefined) };
  const disputes = { decide: vi.fn().mockResolvedValue(undefined) };
  const provider = new PerformanceApprovalsProvider(inbox as never, {} as never, {} as never, {} as never, {} as never, scorecards as never, disputes as never);
  return { provider, inbox, scorecards, disputes };
}

const actor: Actor = { id: 'u-1', empId: 'ACV-0004', fullName: 'Omar Farooq', levelNumber: 3, roleKey: 'cto' };
const client = { ip: null, userAgent: null };
const scorecard = { type: 'scorecard' as const, refId: 'sc-1' };
const dispute = { type: 'dispute' as const, refId: 'dsp-1' };

describe('PerformanceApprovalsProvider', () => {
  it('registers itself with the inbox for scorecard and dispute items', () => {
    const { provider, inbox } = setup();
    provider.onModuleInit();
    expect(inbox.register).toHaveBeenCalledWith(provider);
    expect(provider.types).toEqual(['scorecard', 'dispute']);
  });

  describe('scorecard', () => {
    it('approve releases it; the reason, when given, is the remark that goes with it', async () => {
      const { provider, scorecards } = setup();
      await provider.decide(actor, scorecard, 'approve', {}, client);
      expect(scorecards.release).toHaveBeenLastCalledWith(actor, 'sc-1', undefined, client);
      await provider.decide(actor, scorecard, 'approve', { reason: 'Good month' }, client);
      expect(scorecards.release).toHaveBeenLastCalledWith(actor, 'sc-1', 'Good month', client);
      expect(scorecards.addRemark).not.toHaveBeenCalled();
    });

    it('reject adds a remark and keeps the draft: the remark is required', async () => {
      const { provider, scorecards } = setup();
      await expect(provider.decide(actor, scorecard, 'reject', {}, client)).rejects.toMatchObject({ response: { code: 'reason_required' } });
      expect(scorecards.addRemark).not.toHaveBeenCalled();
      await provider.decide(actor, scorecard, 'reject', { reason: 'Check task 3 first' }, client);
      expect(scorecards.addRemark).toHaveBeenCalledWith(actor, 'sc-1', 'Check task 3 first', client);
      expect(scorecards.release).not.toHaveBeenCalled();
    });
  });

  describe('dispute', () => {
    it('approve changes the rating: a new rating is required, the reason is the decision text', async () => {
      const { provider, disputes } = setup();
      await expect(provider.decide(actor, dispute, 'approve', { reason: 'ok' }, client)).rejects.toMatchObject({ response: { code: 'rating_required' } });
      expect(disputes.decide).not.toHaveBeenCalled();
      await provider.decide(actor, dispute, 'approve', { rating: 4, reason: 'The spec changed' }, client);
      expect(disputes.decide).toHaveBeenLastCalledWith(actor, 'dsp-1', { change: true, decision: 'The spec changed', newRating: 4 }, client);
      await provider.decide(actor, dispute, 'approve', { rating: 5 }, client);
      expect(disputes.decide).toHaveBeenLastCalledWith(actor, 'dsp-1', { change: true, decision: 'Rating changed after review.', newRating: 5 }, client);
    });

    it('reject keeps the rating, with the reason or the default words', async () => {
      const { provider, disputes } = setup();
      await provider.decide(actor, dispute, 'reject', {}, client);
      expect(disputes.decide).toHaveBeenLastCalledWith(actor, 'dsp-1', { change: false, decision: 'Rating kept.' }, client);
      await provider.decide(actor, dispute, 'reject', { reason: 'The work had bugs' }, client);
      expect(disputes.decide).toHaveBeenLastCalledWith(actor, 'dsp-1', { change: false, decision: 'The work had bugs' }, client);
    });
  });

  it('an item type that is not ours is not found', async () => {
    const { provider } = setup();
    await expect(provider.decide(actor, { type: 'leave', refId: 'x' }, 'approve', {}, client)).rejects.toMatchObject({ status: 404 });
  });
});
