import { describe, expect, it } from 'vitest';
import { canSeeTask, extractMentions, type Mentionable } from './task-people';
import { formatHours, formatPkDateTime, formatTaskNumber, parseTaskNumber } from './task-format';

const people: Mentionable[] = [
  { empId: 'ACV-0004', fullName: 'Omar Farooq' },
  { empId: 'ACV-0006', fullName: 'Fahad Khan' },
  { empId: 'ACV-0007', fullName: 'Mariam Shah' },
  { empId: 'ACV-0008', fullName: 'Ali Raza' },
  { empId: 'ACV-0011', fullName: 'Danish Iqbal' },
];

describe('who can see a task', () => {
  const work = { personal: false, assignee: 'ACV-0007', assignedBy: 'ACV-0004' };
  const below = (...ids: string[]) => new Set(ids);

  it('the person doing it and the person who assigned it', () => {
    expect(canSeeTask(work, 'ACV-0007', below())).toBe(true);
    expect(canSeeTask(work, 'ACV-0004', below())).toBe(true);
  });

  it('everyone above the assignee in the reporting line (the Director, and the Owner whose line is everyone)', () => {
    expect(canSeeTask(work, 'ACV-0003', below('ACV-0004', 'ACV-0007'))).toBe(true);
    expect(canSeeTask(work, 'ACV-0001', below('ACV-0003', 'ACV-0004', 'ACV-0007'))).toBe(true);
  });

  it('not people beside or below the assignee', () => {
    expect(canSeeTask(work, 'ACV-0008', below())).toBe(false);
    expect(canSeeTask(work, 'ACV-0009', below('ACV-0014'))).toBe(false);
  });

  it('a personal to-do is seen by its owner alone, even by the people above', () => {
    const todo = { personal: true, assignee: 'ACV-0007', assignedBy: 'ACV-0007' };
    expect(canSeeTask(todo, 'ACV-0007', below())).toBe(true);
    expect(canSeeTask(todo, 'ACV-0004', below('ACV-0007'))).toBe(false);
    expect(canSeeTask(todo, 'ACV-0001', below('ACV-0003', 'ACV-0004', 'ACV-0007'))).toBe(false);
  });
});

describe('@mentions in a comment', () => {
  it('finds a first name, in any case', () => {
    expect(extractMentions('Thanks @Mariam, please check', people)).toEqual(['ACV-0007']);
    expect(extractMentions('thanks @mariam!', people)).toEqual(['ACV-0007']);
    expect(extractMentions('@ALI can you look?', people)).toEqual(['ACV-0008']);
  });

  it('finds an Emp-ID and a full name', () => {
    expect(extractMentions('cc @ACV-0011', people)).toEqual(['ACV-0011']);
    expect(extractMentions('cc @Danish Iqbal', people)).toEqual(['ACV-0011']);
    expect(extractMentions('cc @danish   iqbal.', people)).toEqual(['ACV-0011']);
  });

  it('keeps the order they appear in and mentions each person once', () => {
    expect(extractMentions('@Omar and @Fahad, then @omar again, @ACV-0004 too', people)).toEqual(['ACV-0004', 'ACV-0006']);
    expect(extractMentions('@Fahad Khan @Fahad', people)).toEqual(['ACV-0006']);
  });

  it('does not treat an e-mail address, a half name or a plain @ as a mention', () => {
    expect(extractMentions('write to mariam@acevatech.com', people)).toEqual([]);
    expect(extractMentions('@Mariamx is not her', people)).toEqual([]);
    expect(extractMentions('meet @ 5 pm', people)).toEqual([]);
    expect(extractMentions('no mentions here', people)).toEqual([]);
    expect(extractMentions('Mariam without the at sign', people)).toEqual([]);
  });

  it('a first name two people share mentions nobody: the full name or Emp-ID is needed', () => {
    const twins: Mentionable[] = [...people, { empId: 'ACV-0013', fullName: 'Ali Hassan' }];
    expect(extractMentions('@Ali please look', twins)).toEqual([]);
    expect(extractMentions('@Ali Raza please look', twins)).toEqual(['ACV-0008']);
    expect(extractMentions('@ACV-0013 please look', twins)).toEqual(['ACV-0013']);
  });

  it('only people who may be mentioned are found (the caller leaves out people who left)', () => {
    expect(extractMentions('@Mariam', people.filter((p) => p.empId !== 'ACV-0007'))).toEqual([]);
  });

  it('a name with special characters is matched literally', () => {
    expect(extractMentions("ping @D'Souza Jr. now", [{ empId: 'ACV-0020', fullName: "D'Souza Jr." }])).toEqual(['ACV-0020']);
  });
});

describe('task numbers and formatting', () => {
  it('builds TSK-0001 for work and TODO-0001 for personal to-dos', () => {
    expect(formatTaskNumber(1, false)).toBe('TSK-0001');
    expect(formatTaskNumber(150, false)).toBe('TSK-0150');
    expect(formatTaskNumber(12345, false)).toBe('TSK-12345');
    expect(formatTaskNumber(7n, true)).toBe('TODO-0007');
  });

  it('reads a task number back', () => {
    expect(parseTaskNumber('TSK-0150')).toEqual({ personal: false, value: 150 });
    expect(parseTaskNumber('TODO-0007')).toEqual({ personal: true, value: 7 });
    expect(parseTaskNumber('TSK-7')).toBeNull();
    expect(parseTaskNumber('ACV-0007')).toBeNull();
  });

  it('shows a moment in Pakistan time and hours without noise', () => {
    expect(formatPkDateTime(new Date('2026-11-19T13:00:00Z'))).toBe('19 Nov 2026, 18:00');
    expect(formatPkDateTime(new Date('2026-11-19T19:30:00Z'))).toBe('20 Nov 2026, 00:30');
    expect(formatHours(16)).toBe('16 h');
    expect(formatHours(1.5)).toBe('1.5 h');
    expect(formatHours(2.004)).toBe('2 h');
  });
});
