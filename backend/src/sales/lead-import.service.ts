import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  createSalesLeadSchema,
  type CreateSalesLeadRequest,
  normalizeEmail,
  SALES_IMPORT_COLUMNS,
  SALES_IMPORT_MAX_BYTES,
  SALES_IMPORT_MAX_ROWS,
  SALES_IMPORT_PREVIEW_MINUTES,
  SALES_IMPORT_ROW_STATUSES,
  SALES_LEAD_SOURCES,
  type SalesImportColumn,
  type SalesImportPreviewView,
  type SalesImportResultView,
  type SalesImportRowStatus,
  type SalesImportRowView,
  type SalesLeadSource,
  type SalesPersonRef,
  salesImportPreviewSchema,
} from '@aceva/contracts';
import type { Actor } from '../access/access.types';
import { AuditService } from '../access/audit.service';
import type { RequestInfo } from '../access/decorators';
import { Clock } from '../common/clock';
import { isUniqueViolation } from '../common/db-rules';
import { noteActivity } from '../common/request-context';
import { parseCsv } from '../finance/statement-csv';
import type { UploadedFileData } from '../finance/finance-documents.service';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CompaniesService } from './companies.service';
import { DncService } from './dnc.service';
import { SalesAccessService } from './sales-access.service';
import { badRequest, conflict, notFound } from './sales-errors';
import { person } from './sales-views';

type Tx = Prisma.TransactionClient;

/** A checked row as the batch keeps it between the preview and the commit. */
interface StoredRow {
  view: SalesImportRowView;
  /** The lead to create (only for "ok" rows): the same request a person adding the lead by hand would send. */
  lead: CreateSalesLeadRequest | null;
  emailNormalized: string | null;
}

/** Column names in the messages, as the file names them. */
const FIELD_COLUMN: Record<string, SalesImportColumn> = { fullName: 'name', email: 'email', company: 'company', jobTitle: 'title', country: 'country', source: 'source' };
const COMMIT_ATTEMPTS = 3;
const COMMIT_TIMEOUT_MS = 5 * 60_000;

/**
 * Module 15.4, the lead import (plan section 20: leads come in "by uploading the exported list. The system removes
 * duplicates"). Approved decisions 5 and 6:
 *  - CSV only, in the existing format (SALES_IMPORT_COLUMNS: a header naming only those columns, or no header and that
 *    order); at most 2 MB and 5,000 rows; nothing is saved by the preview except the batch, which expires in 30 minutes;
 *  - the uploader picks the source of the file; a valid source on a row overrides it, an unknown one makes the row invalid;
 *  - every row is checked with the same rules as a lead added by hand (createSalesLeadSchema, M15.1), and against the
 *    leads that exist (the M15.1 email rule), the rows above it, and the do-not-contact list (M15.4).
 *
 * The commit is all or nothing (one transaction): it takes the lock of every email (the same lock a lead added by hand and
 * a do-not-contact entry take), checks every row again and skips, never forces in, a row that became a duplicate or
 * do-not-contact since the preview. A collision with a lead added at the same moment, or a deadlock, rolls everything back
 * and the commit is tried again. A batch is committed once; committing it again returns the same result.
 * The owner is the uploader, or (sales manager only) someone in their team, exactly as for a lead added by hand.
 */
@Injectable()
export class LeadImportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: SalesAccessService,
    private readonly companies: CompaniesService,
    private readonly dnc: DncService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  /** POST /sales/leads/import/preview (multipart: file, source, ownerEmpId?). */
  async preview(actor: Actor, file: UploadedFileData | undefined, body: unknown, client: RequestInfo): Promise<SalesImportPreviewView> {
    const parsed = salesImportPreviewSchema.safeParse(body ?? {});
    if (!parsed.success) badRequest('validation_failed', parsed.error.issues.map((i) => i.message).join('; '));
    const dto = parsed.data;
    const a = await this.access.of(actor);
    const owner = dto.ownerEmpId && dto.ownerEmpId !== actor.empId ? await this.access.assignableOwner(a, dto.ownerEmpId) : { id: actor.id, empId: actor.empId };
    const text = readCsvFile(file);
    const rows = this.rowsOf(text, dto.source);

    // Against the leads that exist (an email belongs to one lead that is not archived) and the do-not-contact list.
    const emails = [...new Set(rows.map((r) => r.emailNormalized).filter((e): e is string => !!e))];
    const existing = await this.existingByEmail(this.prisma, emails);
    const dnc = await this.dnc.listed(this.prisma, emails);
    const seen = new Set<string>();
    for (const r of rows) {
      if (r.view.status === 'invalid' || !r.emailNormalized) continue;
      const e = r.emailNormalized;
      if (dnc.has(e)) mark(r, 'dnc', 'This email is on the do-not-contact list');
      else if (existing.has(e)) {
        const o = existing.get(e)!;
        mark(r, 'duplicate', `This lead already exists. Owner: ${o.name} (${o.empId})`);
        r.view.owner = o;
      } else if (seen.has(e)) mark(r, 'repeated', 'The same email is on an earlier row of this file');
      seen.add(e);
    }

    const now = this.clock.now();
    const expiresAt = new Date(now.getTime() + SALES_IMPORT_PREVIEW_MINUTES * 60_000);
    const fileName = safeFileName(file!.originalname);
    const sha256 = createHash('sha256').update(file!.buffer).digest('hex');
    const counts = countsOf(rows.map((r) => r.view));
    const batch = await this.prisma.$transaction(async (tx) => {
      // Housekeeping: rows of previews nobody committed are cleared once they have expired (they hold contact details).
      await tx.salesImportBatch.updateMany({ where: { status: 'previewed', expiresAt: { lt: now } }, data: { status: 'expired', rows: [] } });
      const b = await tx.salesImportBatch.create({
        data: { createdBy: actor.id, ownerId: owner.id, source: dto.source, fileName, fileSha256: sha256, rowCount: rows.length, rows: rows as unknown as Prisma.InputJsonValue, expiresAt },
        select: { id: true },
      });
      await this.audit.record({ actorId: actor.id, action: 'sales.leads.import_previewed', targetType: 'sales_import', targetId: b.id, details: { file: fileName, sha256, rows: rows.length, counts, owner: owner.empId, source: dto.source }, ...client }, tx);
      return b;
    });
    noteActivity({ target: fileName, description: `Previewed a lead import (${rows.length} rows)`, details: { batch: batch.id } });
    const ownerRow = await this.prisma.employee.findUniqueOrThrow({ where: { id: owner.id }, select: { empId: true, fullName: true } });
    return { batchId: batch.id, fileName, source: dto.source, owner: person(ownerRow), expiresAt: expiresAt.toISOString(), counts, rows: rows.map((r) => r.view) };
  }

  /** POST /sales/leads/import/:batchId/commit: adds the rows that are still good. Once per batch; again = same result. */
  async commit(actor: Actor, batchId: string, client: RequestInfo): Promise<SalesImportResultView> {
    const a = await this.access.of(actor);
    const batch = await this.prisma.salesImportBatch.findUnique({ where: { id: batchId }, include: { owner: { select: { id: true, empId: true, status: true } } } });
    if (!batch || batch.createdBy !== actor.id) notFound('Import not found');
    if (batch.status === 'committed') return this.resultOf(batchId);
    const now = this.clock.now();
    if (batch.status === 'expired' || batch.expiresAt.getTime() <= now.getTime()) {
      await this.prisma.salesImportBatch.updateMany({ where: { id: batchId, status: 'previewed' }, data: { status: 'expired', rows: [] } });
      conflict('import_expired', `This preview is older than ${SALES_IMPORT_PREVIEW_MINUTES} minutes. Upload the file again`);
    }
    // The owner must still be able to own the leads (still active, still in the manager's team).
    if (batch.ownerId !== actor.id) await this.access.assignableOwner(a, batch.owner.empId);

    for (let attempt = 1; ; attempt++) {
      try {
        const created = await this.prisma.$transaction((tx) => this.commitIn(tx, actor, batchId, client), { timeout: COMMIT_TIMEOUT_MS, maxWait: 30_000 });
        if (created !== null) noteActivity({ target: batch.fileName, description: `Imported ${created} lead${created === 1 ? '' : 's'}`, details: { batch: batchId } });
        return this.resultOf(batchId);
      } catch (error) {
        if (attempt < COMMIT_ATTEMPTS && retryable(error)) continue;
        if (retryable(error)) conflict('import_busy', 'Leads were being added at the same moment. Try the import again');
        throw error;
      }
    }
  }

  // ---------------------------------------------------------------------------------------------------------- commit

  /** The commit inside its transaction. Returns how many leads it added, or null when the batch was committed already. */
  private async commitIn(tx: Tx, actor: Actor, batchId: string, client: RequestInfo): Promise<number | null> {
    const locked = await tx.$queryRaw<Array<{ status: string }>>`SELECT status FROM sales_import_batches WHERE id = ${batchId}::uuid FOR UPDATE`;
    if (locked[0]?.status === 'committed') return null; // committed by a request that ran at the same moment
    if (locked[0]?.status !== 'previewed') conflict('import_expired', 'This preview has expired. Upload the file again');
    const batch = await tx.salesImportBatch.findUniqueOrThrow({ where: { id: batchId } });
    const rows = batch.rows as unknown as StoredRow[];
    const good = rows.filter((r) => r.view.status === 'ok' && r.lead);
    const emails = good.map((r) => r.emailNormalized).filter((e): e is string => !!e);
    // The same lock a lead added by hand and a do-not-contact entry take, then every row is checked again.
    await this.dnc.lockEmails(tx, emails);
    const existing = await this.existingByEmail(tx, emails);
    const dnc = await this.dnc.listed(tx, emails);
    const skipped: SalesImportResultView['skipped'] = rows.filter((r) => r.view.status !== 'ok').map((r) => ({ line: r.view.line, status: r.view.status as Exclude<SalesImportRowStatus, 'ok'> }));
    let created = 0;
    for (const r of good) {
      const e = r.emailNormalized;
      if (e && dnc.has(e)) {
        skipped.push({ line: r.view.line, status: 'dnc' });
        continue;
      }
      if (e && existing.has(e)) {
        skipped.push({ line: r.view.line, status: 'duplicate' });
        continue;
      }
      const lead = createSalesLeadSchema.parse(r.lead);
      const company = await this.companies.resolveForLead(tx, actor, { company: lead.company }, client);
      const row = await tx.salesLead.create({
        data: {
          fullName: lead.fullName,
          jobTitle: lead.jobTitle ?? null,
          companyId: company?.id ?? null,
          email: lead.email ?? null,
          emailNormalized: e,
          phone: null,
          linkedinUrl: null,
          country: lead.country ?? null,
          industry: null,
          source: lead.source,
          ownerId: batch.ownerId,
          importBatchId: batch.id,
          createdBy: actor.id,
          updatedBy: actor.id,
        },
        select: { id: true },
      });
      await this.audit.record(
        { actorId: actor.id, action: 'sales.lead.created', targetType: 'sales_lead', targetId: row.id, details: { source: lead.source, ownerId: batch.ownerId, companyId: company?.id ?? null, newCompany: company?.created ?? false, importBatch: batch.id, line: r.view.line }, ...client },
        tx,
      );
      if (e) existing.set(e, { empId: '', name: '' }); // a later row with the same email (never ok, but defensive)
      created++;
    }
    skipped.sort((x, y) => x.line - y.line);
    const now = this.clock.now();
    await tx.salesImportBatch.update({ where: { id: batch.id }, data: { status: 'committed', committedAt: now, rows: [], result: { created, skipped } } });
    await this.audit.record(
      { actorId: actor.id, action: 'sales.leads.imported', targetType: 'sales_import', targetId: batch.id, details: { file: batch.fileName, sha256: batch.fileSha256, created, skipped: skipped.length, ownerId: batch.ownerId, source: batch.source }, ...client },
      tx,
    );
    return created;
  }

  private async resultOf(batchId: string): Promise<SalesImportResultView> {
    const b = await this.prisma.salesImportBatch.findUniqueOrThrow({ where: { id: batchId }, include: { creator: { select: { empId: true, fullName: true } } } });
    const result = b.result as unknown as { created: number; skipped: SalesImportResultView['skipped'] };
    return { batchId: b.id, created: result.created, skipped: result.skipped, committedAt: b.committedAt!.toISOString(), committedBy: person(b.creator) };
  }

  // ----------------------------------------------------------------------------------------------------------- rows

  /** The rows of the file, each checked on its own (the checks against other rows and the database come after). */
  private rowsOf(text: string, fileSource: SalesLeadSource): StoredRow[] {
    const table = parseCsv(text);
    if (!table.length) badRequest('empty_file', 'The file has no rows');
    const first = table[0].map((c) => c.trim().toLowerCase());
    const hasHeader = first.some((c) => (SALES_IMPORT_COLUMNS as readonly string[]).includes(c));
    let columns: Array<SalesImportColumn | null>;
    if (hasHeader) {
      const unknown = first.filter((c) => c !== '' && !(SALES_IMPORT_COLUMNS as readonly string[]).includes(c));
      if (unknown.length) badRequest('unknown_columns', `Unknown column${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}. The columns are: ${SALES_IMPORT_COLUMNS.join(', ')}`);
      const named = first.filter((c) => c !== '');
      if (new Set(named).size !== named.length) badRequest('repeated_columns', 'A column name appears twice in the header');
      if (!named.includes('name')) badRequest('missing_name_column', 'The header has no "name" column');
      columns = first.map((c) => (c === '' ? null : (c as SalesImportColumn)));
    } else {
      columns = [...SALES_IMPORT_COLUMNS];
    }
    const data = hasHeader ? table.slice(1) : table;
    if (!data.length) badRequest('empty_file', 'The file has a header but no rows');
    if (data.length > SALES_IMPORT_MAX_ROWS) badRequest('too_many_rows', `At most ${SALES_IMPORT_MAX_ROWS} rows in one file (this one has ${data.length})`);
    return data.map((cells, i) => this.rowOf(cells, columns, i + (hasHeader ? 2 : 1), fileSource));
  }

  private rowOf(cells: string[], columns: Array<SalesImportColumn | null>, line: number, fileSource: SalesLeadSource): StoredRow {
    const value: Partial<Record<SalesImportColumn, string>> = {};
    const problems: string[] = [];
    if (cells.length > columns.length && cells.slice(columns.length).some((c) => c.trim() !== '')) problems.push(`More than ${columns.length} columns`);
    columns.forEach((col, i) => {
      if (col) value[col] = (cells[i] ?? '').trim();
    });
    // The row's own source overrides the file's; an unknown one is a problem (approved decision 5).
    let source: SalesLeadSource | null = fileSource;
    if (value.source) {
      const s = value.source.toLowerCase().replace(/[\s-]+/g, '_');
      if ((SALES_LEAD_SOURCES as readonly string[]).includes(s)) source = s as SalesLeadSource;
      else {
        source = null;
        problems.push(`Unknown source "${value.source}". Use one of: ${SALES_LEAD_SOURCES.join(', ')}`);
      }
    }
    if (value.website && !value.company) problems.push('A website needs a company name');
    const request: CreateSalesLeadRequest = {
      fullName: value.name ?? '',
      email: value.email || null,
      jobTitle: value.title || null,
      country: value.country || null,
      source: source ?? fileSource,
      ...(value.company ? { company: { name: value.company, website: value.website || null } } : {}),
    };
    const checked = createSalesLeadSchema.safeParse(request);
    if (!checked.success) {
      for (const issue of checked.error.issues) {
        const field = FIELD_COLUMN[String(issue.path[0])] ?? (issue.path[0] === 'company' && issue.path[1] === 'website' ? 'website' : String(issue.path[0]));
        problems.push(`${field}: ${issue.message === 'Required' ? 'required' : issue.message}`);
      }
    }
    const email = value.email ? value.email.trim() : '';
    const view: SalesImportRowView = {
      line,
      name: value.name ?? '',
      email: email || null,
      companyName: value.company || null,
      website: value.website || null,
      country: value.country || null,
      title: value.title || null,
      source,
      status: problems.length ? 'invalid' : 'ok',
      problems,
      owner: null,
    };
    return { view, lead: problems.length ? null : request, emailNormalized: !problems.length && email ? normalizeEmail(email) : null };
  }

  private async existingByEmail(db: PrismaService | Tx, emails: string[]): Promise<Map<string, SalesPersonRef>> {
    const found = new Map<string, SalesPersonRef>();
    for (let i = 0; i < emails.length; i += 1000) {
      const rows = await db.salesLead.findMany({ where: { emailNormalized: { in: emails.slice(i, i + 1000) }, archivedAt: null }, select: { emailNormalized: true, owner: { select: { empId: true, fullName: true } } } });
      for (const r of rows) found.set(r.emailNormalized!, person(r.owner));
    }
    return found;
  }
}

// ------------------------------------------------------------------------------------------------------------- helpers

function mark(r: StoredRow, status: SalesImportRowStatus, problem: string): void {
  r.view.status = status;
  r.view.problems = [problem];
  r.lead = status === 'ok' ? r.lead : null;
}

function countsOf(rows: SalesImportRowView[]): Record<SalesImportRowStatus, number> {
  const counts = Object.fromEntries(SALES_IMPORT_ROW_STATUSES.map((s) => [s, 0])) as Record<SalesImportRowStatus, number>;
  for (const r of rows) counts[r.status]++;
  return counts;
}

/** The uploaded file as text: a .csv file, at most 2 MB, UTF-8 text without NUL bytes. */
function readCsvFile(file: UploadedFileData | undefined): string {
  if (!file || !file.buffer) badRequest('file_required', 'Choose a CSV file');
  if (file.size > SALES_IMPORT_MAX_BYTES || file.buffer.length > SALES_IMPORT_MAX_BYTES) badRequest('file_too_large', 'The file is larger than 2 MB');
  if (!/\.csv$/i.test(file.originalname ?? '')) badRequest('not_csv', 'Only CSV files (.csv) can be imported');
  if (file.buffer.includes(0)) badRequest('not_csv', 'This is not a text CSV file');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(file.buffer);
  } catch {
    badRequest('not_csv', 'The file is not UTF-8 text. Save it as "CSV UTF-8"');
  }
}

/** The file's own name, without folders or control characters, at most 255 characters. */
function safeFileName(name: string): string {
  const base = (name ?? '').split(/[\\/]/).pop() ?? '';
  const clean = [...base].filter((c) => c.charCodeAt(0) > 0x1f && c.charCodeAt(0) !== 0x7f).join('').trim();
  return (clean || 'leads.csv').slice(0, 255);
}

/** A collision with a lead added at the same moment, or a deadlock between two imports: the commit is simply run again. */
function retryable(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return isUniqueViolation(error) || /deadlock detected|could not serialize/i.test(text);
}
