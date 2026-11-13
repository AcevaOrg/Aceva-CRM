/**
 * Bank statement CSV (plan section 13, "import the bank statement (CSV)"). Pure, unit-tested.
 * Format: a header row naming the columns date, description, amount and optionally reference (any order, any case).
 * Dates are YYYY-MM-DD; amounts are signed decimals with at most 2 decimals (positive = money in, negative = money out);
 * thousands separators inside quotes ("1,250.00") are accepted. Every row is checked and every problem is listed.
 */
export interface StatementRow {
  lineNo: number;
  date: string;
  description: string;
  amount: string;
  reference: string | null;
}

export interface CsvProblem {
  row: number;
  message: string;
}

export const MAX_STATEMENT_ROWS = 5000;

/** Splits CSV text into rows of fields (RFC 4180 quotes; "" inside quotes is a quote). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let quoted = false;
  const src = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => f.trim() !== ''));
}

const DAY = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const AMOUNT = /^-?\d{1,12}(\.\d{1,2})?$/;

function validDay(day: string): boolean {
  if (!DAY.test(day)) return false;
  const d = new Date(`${day}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === day;
}

export function parseStatement(text: string): { rows: StatementRow[]; errors: CsvProblem[] } {
  const all = parseCsv(text);
  const errors: CsvProblem[] = [];
  if (!all.length) return { rows: [], errors: [{ row: 1, message: 'The file is empty' }] };
  const header = all[0].map((h) => h.trim().toLowerCase());
  const col = (name: string) => header.indexOf(name);
  const [iDate, iDesc, iAmount, iRef] = [col('date'), col('description'), col('amount'), col('reference')];
  if (iDate < 0 || iDesc < 0 || iAmount < 0) {
    return { rows: [], errors: [{ row: 1, message: 'The first row must name the columns: date, description, amount (and optionally reference)' }] };
  }
  const data = all.slice(1);
  if (!data.length) return { rows: [], errors: [{ row: 2, message: 'The file has no statement lines' }] };
  if (data.length > MAX_STATEMENT_ROWS) return { rows: [], errors: [{ row: MAX_STATEMENT_ROWS + 2, message: `At most ${MAX_STATEMENT_ROWS} lines per file` }] };
  const rows: StatementRow[] = [];
  data.forEach((r, i) => {
    const rowNo = i + 2; // as the spreadsheet shows it (row 1 is the header)
    const date = (r[iDate] ?? '').trim();
    const description = (r[iDesc] ?? '').trim();
    const amountText = (r[iAmount] ?? '').trim().replace(/,/g, '');
    const reference = iRef >= 0 ? (r[iRef] ?? '').trim() || null : null;
    const problems: string[] = [];
    if (!validDay(date)) problems.push(`the date "${date}" is not a day like 2026-11-05`);
    if (!description) problems.push('the description is empty');
    else if (description.length > 300) problems.push('the description is longer than 300 characters');
    if (!AMOUNT.test(amountText)) problems.push(`the amount "${r[iAmount] ?? ''}" is not a number with at most 2 decimals`);
    else if (Number(amountText) === 0) problems.push('the amount is zero');
    if (reference && reference.length > 80) problems.push('the reference is longer than 80 characters');
    if (problems.length) errors.push({ row: rowNo, message: problems.join('; ') });
    else rows.push({ lineNo: i + 1, date, description, amount: amountText, reference });
  });
  return { rows, errors };
}
