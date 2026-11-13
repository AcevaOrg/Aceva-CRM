import { Body, Controller, Get, Header, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query, Res, StreamableFile, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { z } from 'zod';
import {
  approvalLimitsSchema,
  autoMatchSchema,
  bankDetailsSchema,
  createAccountSchema,
  createBankAccountSchema,
  createBillSchema,
  createInvoiceSchema,
  createPartySchema,
  createPaymentSchema,
  createProjectSchema,
  createRateSchema,
  createTransferSchema,
  documentListQuerySchema,
  financeSettingsSchema,
  generalLedgerQuerySchema,
  ledgerDayQuerySchema,
  matchLineSchema,
  monthSchema,
  pageQuerySchema,
  partyListQuerySchema,
  rateQuerySchema,
  rejectSchema,
  reopenSchema,
  reportRangeQuerySchema,
  revaluationSchema,
  statementEntrySchema,
  statementQuerySchema,
  updateAccountSchema,
  ownerApprovalSchema,
  updatePartySchema,
  updateProjectSchema,
} from '@aceva/contracts';
import type { Actor } from '../access/access.types';
import { ClientInfo, CurrentActor, CurrentSessionId, FinanceScreen, RequirePermission, type RequestInfo } from '../access/decorators';
import { createZodDto } from '../common/zod-validation.pipe';
import { FinanceDocumentsService, MAX_RECEIPT_BYTES, type UploadedFileData } from './finance-documents.service';
import { FinanceExportService } from './finance-export.service';
import { JournalService } from './journal.service';
import { LedgerQueryService } from './ledger-query.service';
import { MasterDataService } from './master-data.service';
import { PeriodsService } from './periods.service';
import { MAX_STATEMENT_BYTES, ReconciliationService } from './reconciliation.service';

class CreateAccountDto extends createZodDto(createAccountSchema) {}
class UpdateAccountDto extends createZodDto(updateAccountSchema) {}
class OwnerApprovalDto extends createZodDto(ownerApprovalSchema) {}
class CreateBankAccountDto extends createZodDto(createBankAccountSchema) {}
class BankDetailsDto extends createZodDto(bankDetailsSchema) {}
class PartyListQueryDto extends createZodDto(partyListQuerySchema) {}
class CreatePartyDto extends createZodDto(createPartySchema) {}
class UpdatePartyDto extends createZodDto(updatePartySchema) {}
class CreateProjectDto extends createZodDto(createProjectSchema) {}
class UpdateProjectDto extends createZodDto(updateProjectSchema) {}
class ProjectListQueryDto extends createZodDto(z.object({ includeArchived: z.enum(['true', 'false']).optional() })) {}
class RateQueryDto extends createZodDto(rateQuerySchema) {}
class CreateRateDto extends createZodDto(createRateSchema) {}
class CreateInvoiceDto extends createZodDto(createInvoiceSchema) {}
class DocumentListQueryDto extends createZodDto(documentListQuerySchema) {}
class CreateBillDto extends createZodDto(createBillSchema) {}
class CreatePaymentDto extends createZodDto(createPaymentSchema) {}
class PaymentListQueryDto extends createZodDto(pageQuerySchema.extend({ partyId: z.uuid().optional(), direction: z.enum(['received', 'made']).optional() })) {}
class CreateTransferDto extends createZodDto(createTransferSchema) {}
class TransferListQueryDto extends createZodDto(pageQuerySchema.extend({ month: monthSchema.optional() })) {}
class StatementQueryDto extends createZodDto(statementQuerySchema) {}
class MatchLineDto extends createZodDto(matchLineSchema) {}
class AutoMatchDto extends createZodDto(autoMatchSchema) {}
class StatementEntryDto extends createZodDto(statementEntrySchema) {}
class RevaluationDto extends createZodDto(revaluationSchema) {}
class RevaluationQueryDto extends createZodDto(revaluationSchema) {}
class ReasonDto extends createZodDto(rejectSchema) {}
class ReopenDto extends createZodDto(reopenSchema) {}
class ApprovalLimitsDto extends createZodDto(approvalLimitsSchema) {}
class FinanceSettingsDto extends createZodDto(financeSettingsSchema) {}
class DayQueryDto extends createZodDto(ledgerDayQuerySchema) {}
class RangeQueryDto extends createZodDto(reportRangeQuerySchema) {}
class GeneralLedgerQueryDto extends createZodDto(generalLedgerQuerySchema) {}
class MonthParamDto extends createZodDto(z.object({ month: monthSchema })) {}

const VIEW = 'finance.view';
const CREATE = 'finance.entry_create';

/** Chart of accounts. Development default: the finance duty person (finance.entry_create) changes it; the accountant owns the real chart. */
@ApiTags('finance')
@FinanceScreen()
@Controller('accounts')
export class AccountsController {
  constructor(private readonly data: MasterDataService) {}

  @Get()
  @RequirePermission(VIEW)
  @ApiOperation({ summary: 'Chart of accounts with posted balances' })
  list() {
    return this.data.accounts();
  }

  @Post()
  @RequirePermission(VIEW, CREATE)
  @ApiOperation({ summary: 'Add an account (code in its group: 1xxx assets ... 5xxx expenses)' })
  create(@CurrentActor() actor: Actor, @Body() body: CreateAccountDto, @ClientInfo() client: RequestInfo) {
    return this.data.createAccount(actor, body, client);
  }

  @Patch(':id')
  @RequirePermission(VIEW, CREATE)
  @ApiOperation({ summary: 'Rename, archive or flag an account (reason required, logged)' })
  update(@CurrentActor() actor: Actor, @Param('id', new ParseUUIDPipe()) id: string, @Body() body: UpdateAccountDto, @ClientInfo() client: RequestInfo) {
    return this.data.updateAccount(actor, id, body, client);
  }

  @Put(':id/owner-approval')
  @RequirePermission(VIEW, 'finance.authority_manage')
  @ApiOperation({ summary: 'Add or remove the "Owner approves" rule on an account. Owner only, reason and "confirm again" required, logged' })
  ownerApproval(
    @CurrentActor() actor: Actor,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: OwnerApprovalDto,
    @CurrentSessionId() sessionId: string | null,
    @ClientInfo() client: RequestInfo,
  ) {
    return this.data.setOwnerApproval(actor, id, body, sessionId, client);
  }
}

/** Bank accounts: ledger accounts marked as bank, with the account number encrypted and shown masked. */
@ApiTags('finance')
@FinanceScreen()
@Controller('bank-accounts')
export class BankAccountsController {
  constructor(private readonly data: MasterDataService) {}

  @Get()
  @RequirePermission(VIEW)
  @ApiOperation({ summary: 'Bank accounts with masked numbers and posted balances' })
  list() {
    return this.data.bankAccounts();
  }

  @Post()
  @RequirePermission(VIEW, CREATE)
  @ApiOperation({ summary: 'Add a bank account (the number is encrypted; only the last 4 digits are kept in clear)' })
  create(@CurrentActor() actor: Actor, @Body() body: CreateBankAccountDto, @ClientInfo() client: RequestInfo) {
    return this.data.createBankAccount(actor, body, client);
  }

  @Put(':id/details')
  @RequirePermission(VIEW, CREATE)
  @ApiOperation({ summary: 'Set the bank name and account number of a bank account (reason required; the number is never logged)' })
  details(@CurrentActor() actor: Actor, @Param('id', new ParseUUIDPipe()) id: string, @Body() body: BankDetailsDto, @ClientInfo() client: RequestInfo) {
    return this.data.setBankDetails(actor, id, body, client);
  }

  @Post(':id/reveal')
  @HttpCode(200)
  @RequirePermission(VIEW)
  @ApiOperation({ summary: 'Show the full account number: needs "confirm again"; every reveal is logged' })
  reveal(@CurrentActor() actor: Actor, @Param('id', new ParseUUIDPipe()) id: string, @CurrentSessionId() sessionId: string | null, @ClientInfo() client: RequestInfo) {
    return this.data.revealBankNumber(actor, id, sessionId, client);
  }
}

@ApiTags('finance')
@FinanceScreen()
@Controller('parties')
export class PartiesController {
  constructor(private readonly data: MasterDataService) {}

  @Get()
  @RequirePermission(VIEW)
  @ApiOperation({ summary: 'Clients and vendors (paged). ?kind=client|vendor&q' })
  list(@Query() query: PartyListQueryDto) {
    return this.data.parties(query);
  }

  @Get(':id')
  @RequirePermission(VIEW)
  get(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.data.party(id);
  }

  @Post()
  @RequirePermission(VIEW, CREATE)
  @ApiOperation({ summary: 'Add a client or vendor' })
  create(@CurrentActor() actor: Actor, @Body() body: CreatePartyDto, @ClientInfo() client: RequestInfo) {
    return this.data.createParty(actor, body, client);
  }

  @Patch(':id')
  @RequirePermission(VIEW, CREATE)
  @ApiOperation({ summary: 'Change or archive a client or vendor (never deleted)' })
  update(@CurrentActor() actor: Actor, @Param('id', new ParseUUIDPipe()) id: string, @Body() body: UpdatePartyDto, @ClientInfo() client: RequestInfo) {
    return this.data.updateParty(actor, id, body, client);
  }
}

@ApiTags('finance')
@FinanceScreen()
@Controller('projects')
export class ProjectsController {
  constructor(private readonly data: MasterDataService) {}

  @Get()
  @RequirePermission(VIEW)
  @ApiOperation({ summary: 'Projects for tagging entries, invoices and bills' })
  list(@Query() query: ProjectListQueryDto) {
    return this.data.projects(query.includeArchived === 'true');
  }

  @Post()
  @RequirePermission(VIEW, CREATE)
  create(@CurrentActor() actor: Actor, @Body() body: CreateProjectDto, @ClientInfo() client: RequestInfo) {
    return this.data.createProject(actor, body, client);
  }

  @Patch(':id')
  @RequirePermission(VIEW, CREATE)
  update(@CurrentActor() actor: Actor, @Param('id', new ParseUUIDPipe()) id: string, @Body() body: UpdateProjectDto, @ClientInfo() client: RequestInfo) {
    return this.data.updateProject(actor, id, body, client);
  }
}

@ApiTags('finance')
@FinanceScreen()
@Controller('exchange-rates')
export class ExchangeRatesController {
  constructor(private readonly data: MasterDataService) {}

  @Get()
  @RequirePermission(VIEW)
  @ApiOperation({ summary: 'Saved USD rates (PKR per 1 USD). ?from&to' })
  list(@Query() query: RateQueryDto) {
    return this.data.rates(query.from, query.to);
  }

  @Post()
  @RequirePermission(VIEW, CREATE)
  @ApiOperation({ summary: 'Save the USD rate of a day (one per day)' })
  create(@CurrentActor() actor: Actor, @Body() body: CreateRateDto, @ClientInfo() client: RequestInfo) {
    return this.data.createRate(actor, body, client);
  }
}

@ApiTags('finance')
@FinanceScreen()
@Controller('invoices')
export class InvoicesController {
  constructor(private readonly docs: FinanceDocumentsService) {}

  @Get()
  @RequirePermission(VIEW)
  @ApiOperation({ summary: 'Client invoices (paged) with the calculated status. ?partyId&status' })
  list(@Query() query: DocumentListQueryDto) {
    return this.docs.invoices(query);
  }

  @Get(':id')
  @RequirePermission(VIEW)
  get(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.docs.invoice(id);
  }

  @Get(':id/document')
  @RequirePermission(VIEW)
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'")
  @Header('Cache-Control', 'private, no-store')
  @Header('X-Content-Type-Options', 'nosniff')
  @ApiOperation({ summary: 'Printable invoice (HTML; no PDF library is approved yet)' })
  document(@CurrentActor() actor: Actor, @Param('id', new ParseUUIDPipe()) id: string, @ClientInfo() client: RequestInfo) {
    return this.docs.invoiceDocument(actor, id, client);
  }

  @Post()
  @RequirePermission(VIEW, CREATE)
  @ApiOperation({ summary: 'Create an invoice: its entry (Dr receivable / Cr income) is created and submitted for approval' })
  create(@CurrentActor() actor: Actor, @Body() body: CreateInvoiceDto, @ClientInfo() client: RequestInfo) {
    return this.docs.createInvoice(actor, body, client);
  }
}

@ApiTags('finance')
@FinanceScreen()
@Controller('bills')
export class BillsController {
  constructor(private readonly docs: FinanceDocumentsService) {}

  @Get()
  @RequirePermission(VIEW)
  @ApiOperation({ summary: 'Vendor bills (paged) with the calculated status. ?partyId&status' })
  list(@Query() query: DocumentListQueryDto) {
    return this.docs.bills(query);
  }

  @Get(':id')
  @RequirePermission(VIEW)
  get(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.docs.bill(id);
  }

  @Post()
  @RequirePermission(VIEW, CREATE)
  @ApiOperation({ summary: 'Create a bill: its entry (Dr expense / Cr payable) is created and submitted for approval' })
  create(@CurrentActor() actor: Actor, @Body() body: CreateBillDto, @ClientInfo() client: RequestInfo) {
    return this.docs.createBill(actor, body, client);
  }

  @Post(':id/receipt')
  @RequirePermission(VIEW, CREATE)
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_RECEIPT_BYTES + 1, files: 1 } }))
  @ApiOperation({ summary: 'Upload the receipt (PDF, PNG or JPEG by content, 10 MB). Stored privately.' })
  receipt(@CurrentActor() actor: Actor, @Param('id', new ParseUUIDPipe()) id: string, @UploadedFile() file: UploadedFileData | undefined, @ClientInfo() client: RequestInfo) {
    return this.docs.uploadReceipt(actor, { billId: id }, file, client);
  }
}

@ApiTags('finance')
@FinanceScreen()
@Controller('receipts')
export class ReceiptsController {
  constructor(private readonly docs: FinanceDocumentsService) {}

  @Post('journal-entries/:id')
  @RequirePermission(VIEW, CREATE)
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_RECEIPT_BYTES + 1, files: 1 } }))
  @ApiOperation({ summary: 'Attach a receipt to an entry (PDF, PNG or JPEG, 10 MB)' })
  forEntry(@CurrentActor() actor: Actor, @Param('id', new ParseUUIDPipe()) id: string, @UploadedFile() file: UploadedFileData | undefined, @ClientInfo() client: RequestInfo) {
    return this.docs.uploadReceipt(actor, { entryId: id }, file, client);
  }

  @Get(':id')
  @RequirePermission(VIEW)
  @ApiOperation({ summary: 'Download a receipt (logged)' })
  async download(@CurrentActor() actor: Actor, @Param('id', new ParseUUIDPipe()) id: string, @ClientInfo() client: RequestInfo, @Res({ passthrough: true }) res: Response) {
    const file = await this.docs.downloadReceipt(actor, id, client);
    res.set({ 'Content-Type': file.mimeType, 'Content-Disposition': `attachment; filename="${encodeURIComponent(file.fileName)}"`, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store' });
    return new StreamableFile(file.buffer);
  }
}

@ApiTags('finance')
@FinanceScreen()
@Controller('payments')
export class PaymentsController {
  constructor(private readonly docs: FinanceDocumentsService) {}

  @Get()
  @RequirePermission(VIEW)
  list(@Query() query: PaymentListQueryDto) {
    return this.docs.payments(query);
  }

  @Get(':id')
  @RequirePermission(VIEW)
  get(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.docs.payment(id);
  }

  @Post()
  @RequirePermission(VIEW, CREATE)
  @ApiOperation({ summary: 'Payment received (Dr bank / Cr receivable) or made (Dr payable / Cr bank), allocated to invoices or bills; waits for approval' })
  create(@CurrentActor() actor: Actor, @Body() body: CreatePaymentDto, @ClientInfo() client: RequestInfo) {
    return this.docs.createPayment(actor, body, client);
  }
}

@ApiTags('finance')
@FinanceScreen()
@Controller('transfers')
export class TransfersController {
  constructor(
    private readonly docs: FinanceDocumentsService,
    private readonly journal: JournalService,
  ) {}

  @Get()
  @RequirePermission(VIEW)
  @ApiOperation({ summary: 'Transfers between bank accounts (entries with source transfer)' })
  list(@CurrentActor() actor: Actor, @Query() query: TransferListQueryDto) {
    return this.journal.list(actor, { page: query.page, pageSize: query.pageSize, month: query.month, source: 'transfer' });
  }

  @Post()
  @RequirePermission(VIEW, CREATE)
  @ApiOperation({ summary: 'Move money between two bank accounts (Dr to / Cr from); waits for approval' })
  create(@CurrentActor() actor: Actor, @Body() body: CreateTransferDto, @ClientInfo() client: RequestInfo) {
    return this.docs.createTransfer(actor, body, client);
  }
}

@ApiTags('finance')
@FinanceScreen()
@Controller('bank-statements')
export class BankStatementsController {
  constructor(private readonly recon: ReconciliationService) {}

  @Get()
  @RequirePermission(VIEW)
  @ApiOperation({ summary: 'Reconciliation of a bank account for a month: statement lines with suggestions, ledger lines, what is missing' })
  view(@Query() query: StatementQueryDto) {
    return this.recon.view(query.bankAccountId, query.month);
  }

  @Post()
  @RequirePermission(VIEW, CREATE)
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_STATEMENT_BYTES + 1, files: 1 } }))
  @ApiOperation({ summary: 'Import a statement CSV (header: date,description,amount[,reference]). The same file twice is refused.' })
  import(@CurrentActor() actor: Actor, @UploadedFile() file: UploadedFileData | undefined, @Body() body: { bankAccountId?: string }, @ClientInfo() client: RequestInfo) {
    return this.recon.import(actor, typeof body?.bankAccountId === 'string' ? body.bankAccountId : undefined, file, client);
  }

  @Post('auto-match')
  @HttpCode(200)
  @RequirePermission(VIEW, CREATE)
  @ApiOperation({ summary: 'Accept every unambiguous suggestion of a month' })
  autoMatch(@CurrentActor() actor: Actor, @Body() body: AutoMatchDto, @ClientInfo() client: RequestInfo) {
    return this.recon.autoMatch(actor, body.bankAccountId, body.month, client);
  }

  @Post('lines/:id/match')
  @HttpCode(200)
  @RequirePermission(VIEW, CREATE)
  match(@CurrentActor() actor: Actor, @Param('id', new ParseUUIDPipe()) id: string, @Body() body: MatchLineDto, @ClientInfo() client: RequestInfo) {
    return this.recon.match(actor, id, body.journalLineId, client);
  }

  @Post('lines/:id/unmatch')
  @HttpCode(200)
  @RequirePermission(VIEW, CREATE)
  unmatch(@CurrentActor() actor: Actor, @Param('id', new ParseUUIDPipe()) id: string, @ClientInfo() client: RequestInfo) {
    return this.recon.unmatch(actor, id, client);
  }

  @Post('lines/:id/create-entry')
  @RequirePermission(VIEW, CREATE)
  @ApiOperation({ summary: '"Missing in ledger": create a draft entry prefilled from the statement line' })
  createEntry(@CurrentActor() actor: Actor, @Param('id', new ParseUUIDPipe()) id: string, @Body() body: StatementEntryDto, @ClientInfo() client: RequestInfo) {
    return this.recon.createEntry(actor, id, body, client);
  }
}

@ApiTags('finance')
@FinanceScreen()
@Controller('periods')
export class PeriodsController {
  constructor(private readonly periods: PeriodsService) {}

  @Get()
  @RequirePermission(VIEW)
  @ApiOperation({ summary: 'Months with their live close checklist' })
  list(@CurrentActor() actor: Actor) {
    return this.periods.list(actor);
  }

  @Get(':month')
  @RequirePermission(VIEW)
  get(@CurrentActor() actor: Actor, @Param() p: MonthParamDto) {
    return this.periods.get(actor, p.month);
  }

  @Get(':month/revaluation')
  @RequirePermission(VIEW)
  @ApiOperation({ summary: 'USD revaluation preview. ?rate (default: the saved month-end rate)' })
  previewGet(@Param() p: MonthParamDto, @Query() query: RevaluationQueryDto) {
    return this.periods.revaluationPreview(p.month, query.rate);
  }

  @Post(':month/revaluation-preview')
  @HttpCode(200)
  @RequirePermission(VIEW, CREATE)
  preview(@Param() p: MonthParamDto, @Body() body: RevaluationDto) {
    return this.periods.revaluationPreview(p.month, body.rate);
  }

  @Post(':month/revalue')
  @RequirePermission(VIEW, CREATE)
  @ApiOperation({ summary: 'Create the month-end USD revaluation entry (one per month; waits for approval)' })
  revalue(@CurrentActor() actor: Actor, @Param() p: MonthParamDto, @Body() body: RevaluationDto, @ClientInfo() client: RequestInfo) {
    return this.periods.revalue(actor, p.month, body.rate, client);
  }

  @Post(':month/close')
  @HttpCode(200)
  @RequirePermission(VIEW, 'finance.close')
  @ApiOperation({ summary: 'Run the close (finance duty): every checklist item must be done' })
  close(@CurrentActor() actor: Actor, @Param() p: MonthParamDto, @ClientInfo() client: RequestInfo) {
    return this.periods.close(actor, p.month, client);
  }

  @Post(':month/approve-close')
  @HttpCode(200)
  @RequirePermission(VIEW, 'finance.close_approve')
  @ApiOperation({ summary: 'Approve the close (CEO; not the person who ran it). The month is then locked.' })
  approveClose(@CurrentActor() actor: Actor, @Param() p: MonthParamDto, @ClientInfo() client: RequestInfo) {
    return this.periods.approveClose(actor, p.month, client);
  }

  @Post(':month/reject-close')
  @HttpCode(200)
  @RequirePermission(VIEW, 'finance.close_approve')
  rejectClose(@CurrentActor() actor: Actor, @Param() p: MonthParamDto, @Body() body: ReasonDto, @ClientInfo() client: RequestInfo) {
    return this.periods.rejectClose(actor, p.month, body.reason, client);
  }

  @Post(':month/reopen')
  @HttpCode(200)
  @RequirePermission(VIEW, 'finance.reopen')
  @ApiOperation({ summary: 'Reopen a closed month (Owner or CEO): reason and "confirm again"; logged and alerted' })
  reopen(@CurrentActor() actor: Actor, @Param() p: MonthParamDto, @Body() body: ReopenDto, @CurrentSessionId() sessionId: string | null, @ClientInfo() client: RequestInfo) {
    return this.periods.reopen(actor, p.month, body.reason, sessionId, client);
  }
}

/** Approval limits and finance settings: a temporary home until Module 12. */
@ApiTags('finance')
@FinanceScreen()
@Controller('settings')
export class FinanceSettingsController {
  constructor(private readonly data: MasterDataService) {}

  @Get('approval-limits')
  @RequirePermission(VIEW)
  limits() {
    return this.data.approvalLimits();
  }

  @Put('approval-limits')
  @RequirePermission(VIEW, 'finance.authority_manage')
  @ApiOperation({ summary: 'Replace the approval tiers. Owner only, reason and "confirm again" required, logged; level 1 is the unlimited tier' })
  setLimits(@CurrentActor() actor: Actor, @Body() body: ApprovalLimitsDto, @CurrentSessionId() sessionId: string | null, @ClientInfo() client: RequestInfo) {
    return this.data.setApprovalLimits(actor, body, sessionId, client);
  }

  @Get('finance')
  @RequirePermission(VIEW)
  settings() {
    return this.data.financeSettings();
  }

  @Put('finance')
  @RequirePermission(VIEW, 'finance.authority_manage')
  @ApiOperation({ summary: 'Change the "confirm again" threshold and the finance year start. Owner only, reason and "confirm again" required, logged' })
  setSettings(@CurrentActor() actor: Actor, @Body() body: FinanceSettingsDto, @CurrentSessionId() sessionId: string | null, @ClientInfo() client: RequestInfo) {
    return this.data.setFinanceSettings(actor, body, sessionId, client);
  }
}

/** Read-only ledger reports (Module 10 adds the five statements). */
@ApiTags('finance')
@FinanceScreen()
@Controller('ledger')
export class LedgerReportsController {
  constructor(
    private readonly ledger: LedgerQueryService,
    private readonly exports: FinanceExportService,
    private readonly journal: JournalService,
  ) {}

  @Get('reports/trial-balance')
  @RequirePermission(VIEW)
  trialBalance(@Query() q: DayQueryDto) {
    return this.ledger.trialBalance(q.date ?? this.journal.today());
  }

  @Get('reports/general-ledger')
  @RequirePermission(VIEW)
  generalLedger(@Query() q: GeneralLedgerQueryDto) {
    return this.ledger.generalLedger(q.accountId, q.from, q.to);
  }

  @Get('reports/ar-aging')
  @RequirePermission(VIEW)
  arAging(@Query() q: DayQueryDto) {
    return this.ledger.receivablesAging(q.date ?? this.journal.today());
  }

  @Get('reports/ap-due')
  @RequirePermission(VIEW)
  apDue(@Query() q: DayQueryDto) {
    return this.ledger.billsToPay(q.date ?? this.journal.today());
  }

  @Get('reports/profit-by-project')
  @RequirePermission(VIEW)
  profitByProject(@Query() q: RangeQueryDto) {
    return this.ledger.profitByProject(q.from, q.to);
  }

  @Get('reports/profit-by-client')
  @RequirePermission(VIEW)
  profitByClient(@Query() q: RangeQueryDto) {
    return this.ledger.profitByClient(q.from, q.to);
  }

  @Get('export')
  @RequirePermission(VIEW, 'finance.export')
  @ApiOperation({ summary: 'Export posted ledger lines as CSV (levels 1-3 only; "confirm again"; watermarked and logged)' })
  async export(@CurrentActor() actor: Actor, @Query() q: RangeQueryDto, @CurrentSessionId() sessionId: string | null, @ClientInfo() client: RequestInfo, @Res({ passthrough: true }) res: Response) {
    const csv = await this.exports.ledgerCsv(actor, q.from, q.to, sessionId, client);
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="ledger-${q.from}-${q.to}.csv"`, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
    return csv;
  }
}
