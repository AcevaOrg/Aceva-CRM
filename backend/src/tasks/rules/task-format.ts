/**
 * Small formatting helpers shared by the tasks code and its mails. Pure functions.
 */

/** TSK-0001 for a work task, TODO-0001 for a personal to-do (the number is the next value of the matching sequence). */
export function formatTaskNumber(sequenceValue: number | bigint, personal: boolean): string {
  return `${personal ? 'TODO' : 'TSK'}-${String(sequenceValue).padStart(4, '0')}`;
}

/** The sequence value of a task number, or null when the text is not a task number. */
export function parseTaskNumber(text: string): { personal: boolean; value: number } | null {
  const m = /^(TSK|TODO)-(\d{4,})$/.exec(text);
  return m ? { personal: m[1] === 'TODO', value: Number(m[2]) } : null;
}

const PK = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Karachi', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });

/** "19 Nov 2026, 18:00" in Pakistan time, for mails and reasons written into the history. */
export function formatPkDateTime(at: Date): string {
  return PK.format(at).replace(' at ', ', ');
}

/** Hours for people: 2, 4, 16, 1.5 (never 16.00). */
export function formatHours(hours: number): string {
  return `${Math.round(hours * 100) / 100} h`;
}
