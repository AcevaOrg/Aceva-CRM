import { describe, expect, it } from 'vitest';
import { canViewDispute, nextVersionNo, reviewerShown, sortByName } from './core-view';

describe('reviewerShown', () => {
  it('a draft shows who reviews it now, so a leaver\'s drafts move up', () => {
    expect(reviewerShown({ status: 'draft', currentReviewer: 'ACV-0003', storedReviewer: 'ACV-0004', releasedBy: null })).toBe('ACV-0003');
  });
  it('a draft with nobody to review it shows none', () => {
    expect(reviewerShown({ status: 'draft', currentReviewer: null, storedReviewer: null, releasedBy: null })).toBeNull();
  });
  it('a released scorecard shows who released it', () => {
    expect(reviewerShown({ status: 'released', currentReviewer: 'ACV-0003', storedReviewer: 'ACV-0004', releasedBy: 'ACV-0003' })).toBe('ACV-0003');
    expect(reviewerShown({ status: 'acknowledged', currentReviewer: 'ACV-0003', storedReviewer: 'ACV-0004', releasedBy: 'ACV-0004' })).toBe('ACV-0004');
  });
  it('the Director\'s scorecard (released by the system, no reviewer) shows none', () => {
    expect(reviewerShown({ status: 'released', currentReviewer: null, storedReviewer: null, releasedBy: null })).toBeNull();
  });
});

describe('sortByName', () => {
  const people = [
    { empId: 'ACV-0009', fullName: 'Zara Khan', score: 99 },
    { empId: 'ACV-0006', fullName: 'adam Shah', score: 10 },
    { empId: 'ACV-0008', fullName: 'Maria Noor', score: 55 },
    { empId: 'ACV-0007', fullName: 'Adam Shah', score: 70 },
  ];
  it('sorts by full name, ignoring case, and by Emp-ID on a tie; the score never decides the order', () => {
    expect(sortByName(people).map((p) => p.empId)).toEqual(['ACV-0006', 'ACV-0007', 'ACV-0008', 'ACV-0009']);
  });
  it('does not change the list it is given', () => {
    const copy = [...people];
    sortByName(people);
    expect(people).toEqual(copy);
  });
});

describe('nextVersionNo', () => {
  it('starts at 1 and goes one past the highest', () => {
    expect(nextVersionNo([])).toBe(1);
    expect(nextVersionNo([1])).toBe(2);
    expect(nextVersionNo([3, 1, 2])).toBe(4);
  });
});

describe('canViewDispute', () => {
  it('the employee, the decider and everyone above the employee', () => {
    expect(canViewDispute({ isEmployee: true, isDecider: false, isAboveEmployee: false })).toBe(true);
    expect(canViewDispute({ isEmployee: false, isDecider: true, isAboveEmployee: false })).toBe(true);
    expect(canViewDispute({ isEmployee: false, isDecider: false, isAboveEmployee: true })).toBe(true);
  });
  it('nobody else', () => {
    expect(canViewDispute({ isEmployee: false, isDecider: false, isAboveEmployee: false })).toBe(false);
  });
});
