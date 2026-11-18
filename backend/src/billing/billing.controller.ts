import { Body, Controller, Get, Header, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import {
  billingCustomerSchema,
  billingInvoiceListQuerySchema,
  cancelInvoiceSchema,
  costMonthParamSchema,
  createBillingInvoiceSchema,
  dealHandoverListQuerySchema,
  issueInvoiceSchema,
  recordInvoicePaymentSchema,
  renewalDecisionSchema,
  resolveDealHandoverSchema,
  stopRecurringSchema,
  subscriptionCostSchema,
  subscriptionSchema,
  updateBillingCustomerSchema,
  updateBillingInvoiceSchema,
  updateSubscriptionSchema,
  usageReadingSchema,
} from '@aceva/contracts';
import type { Actor } from '../access/access.types';
import { ClientInfo, CurrentActor, CurrentSessionId, FinanceScreen, RequirePermission, type RequestInfo } from '../access/decorators';
import { createZodDto } from '../common/zod-validation.pipe';
import { BillingService } from './billing.service';
import { SubscriptionsService } from './subscriptions.service';

class InvoiceListQueryDto extends createZodDto(billingInvoiceListQuerySchema) {}
class CreateInvoiceDto extends createZodDto(createBillingInvoiceSchema) {}
class UpdateInvoiceDto extends createZodDto(updateBillingInvoiceSchema) {}
class IssueInvoiceDto extends createZodDto(issueInvoiceSchema) {}
class CancelInvoiceDto extends createZodDto(cancelInvoiceSchema) {}
class RecordPaymentDto extends createZodDto(recordInvoicePaymentSchema) {}
class CustomerDto extends createZodDto(billingCustomerSchema) {}
class UpdateCustomerDto extends createZodDto(updateBillingCustomerSchema) {}
class StopRecurringDto extends createZodDto(stopRecurringSchema) {}
class SubscriptionDto extends createZodDto(subscriptionSchema) {}
class UpdateSubscriptionDto extends createZodDto(updateSubscriptionSchema) {}
class RenewalDecisionDto extends createZodDto(renewalDecisionSchema) {}
class UsageReadingDto extends createZodDto(usageReadingSchema) {}
class SubscriptionCostDto extends createZodDto(subscriptionCostSchema) {}
class CostMonthDto extends createZodDto(costMonthParamSchema) {}
class HandoverListDto extends createZodDto(dealHandoverListQuerySchema) {}
class ResolveHandoverDto extends createZodDto(resolveDealHandoverSchema) {}

const VIEW = 'billing.view';
const MANAGE = 'billing.manage';
const SUB_VIEW = 'subscriptions.view';
const SUB_MANAGE = 'subscriptions.manage';

/**
 * Module 13 customer billing. Finance screens: people without access get "not found", and the 10-minute finance idle
 * limit applies (FinanceScreen). The finance duty person (billing.manage) creates invoices and records payments; issuing
 * creates a Module 9 entry that a different person approves.
 */
@ApiTags('billing')
@FinanceScreen()
@Controller('billing')
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  @Get('overview')
  @RequirePermission(VIEW)
  @ApiOperation({ summary: 'Billed and collected this month, outstanding, overdue, due soon, drafts from Won deals (PKR)' })
  overview() {
    return this.billing.overview();
  }

  @Get('invoices')
  @RequirePermission(VIEW)
  @ApiOperation({ summary: 'Invoices with the calculated status (draft, issued, part paid, paid, overdue, cancelled). ?partyId&status' })
  invoices(@Query() q: InvoiceListQueryDto) {
    return this.billing.invoices(q);
  }

  @Get('invoices/export')
  @RequirePermission(VIEW, 'finance.export')
  @ApiOperation({ summary: 'Invoices as CSV ("confirm again"; watermarked and logged)' })
  async export(@CurrentActor() actor: Actor, @CurrentSessionId() sessionId: string | null, @ClientInfo() client: RequestInfo, @Res({ passthrough: true }) res: Response) {
    const csv = await this.billing.exportCsv(actor, sessionId, client);
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="invoices.csv"', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
    return csv;
  }

  @Post('invoices')
  @RequirePermission(VIEW, MANAGE)
  @ApiOperation({ summary: 'A draft invoice (no ledger entry). Recurring and rental invoices also create their rule. requestKey makes a retry safe.' })
  create(@CurrentActor() actor: Actor, @Body() body: CreateInvoiceDto, @ClientInfo() client: RequestInfo) {
    return this.billing.createInvoice(actor, body, client);
  }

  @Get('invoices/:id')
  @RequirePermission(VIEW)
  @ApiOperation({ summary: 'An invoice with its client, payments, reminder history, emails and recurring rule' })
  get(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.billing.invoiceDetail(id);
  }

  @Patch('invoices/:id')
  @RequirePermission(VIEW, MANAGE)
  @ApiOperation({ summary: 'Edit a draft' })
  update(@CurrentActor() actor: Actor, @Param('id', new ParseUUIDPipe()) id: string, @Body() body: UpdateInvoiceDto, @ClientInfo() client: RequestInfo) {
    return this.billing.updateInvoice(actor, id, body, client);
  }

  @Post('invoices/:id/issue')
  @HttpCode(200)
  @RequirePermission(VIEW, MANAGE)
  @ApiOperation({ summary: 'Issue a draft: Module 9 numbers it and submits its entry (Dr receivable / Cr income) for approval; reminders are scheduled' })
  issue(@CurrentActor() actor: Actor, @Param('id', new ParseUUIDPipe()) id: string, @Body() body: IssueInvoiceDto, @ClientInfo() client: RequestInfo) {
    return this.billing.issueInvoice(actor, id, body, client);
  }

  @Post('invoices/:id/email')
  @HttpCode(200)
  @RequirePermission(VIEW, MANAGE)
  @ApiOperation({ summary: 'Email an issued invoice to the client (once; needs customer emails switched on in the settings)' })
  email(@CurrentActor() actor: Actor, @Param('id', new ParseUUIDPipe()) id: string, @ClientInfo() client: RequestInfo) {
    return this.billing.emailInvoice(actor, id, client);
  }

  @Post('invoices/:id/cancel')
  @HttpCode(200)
  @RequirePermission(VIEW, MANAGE)
  @ApiOperation({ summary: 'Cancel: a draft simply; a posted invoice by a reversing entry that waits for approval ("confirm again")' })
  cancel(@CurrentActor() actor: Actor, @Param('id', new ParseUUIDPipe()) id: string, @Body() body: CancelInvoiceDto, @CurrentSessionId() sessionId: string | null, @ClientInfo() client: RequestInfo) {
    return this.billing.cancelInvoice(actor, id, body.reason, sessionId, client);
  }

  @Post('invoices/:id/restore')
  @HttpCode(200)
  @RequirePermission(VIEW, MANAGE)
  @ApiOperation({ summary: 'Restore an invoice whose cancellation entry was rejected' })
  restore(@CurrentActor() actor: Actor, @Param('id', new ParseUUIDPipe()) id: string, @ClientInfo() client: RequestInfo) {
    return this.billing.restoreInvoice(actor, id, client);
  }

  @Post('invoices/:id/payments')
  @RequirePermission(VIEW, MANAGE, 'finance.entry_create')
  @ApiOperation({ summary: 'Record a payment for the invoice (a Module 9 payment; its entry waits for approval). Never a card number.' })
  pay(@CurrentActor() actor: Actor, @Param('id', new ParseUUIDPipe()) id: string, @Body() body: RecordPaymentDto, @ClientInfo() client: RequestInfo) {
    return this.billing.recordPayment(actor, id, body, client);
  }

  @Get('invoices/:id/document')
  @RequirePermission(VIEW)
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'")
  @Header('Cache-Control', 'private, no-store')
  @Header('X-Content-Type-Options', 'nosniff')
  @ApiOperation({ summary: 'Printable invoice with the company details from the billing settings' })
  document(@CurrentActor() actor: Actor, @Param('id', new ParseUUIDPipe()) id: string, @ClientInfo() client: RequestInfo) {
    return this.billing.invoiceDocument(actor, id, client);
  }

  @Get('payments')
  @RequirePermission(VIEW)
  @ApiOperation({ summary: 'Payments received against invoices (each payment and the part allocated to each invoice)' })
  payments() {
    return this.billing.paymentViews();
  }

  @Get('customers')
  @RequirePermission(VIEW)
  @ApiOperation({ summary: 'Clients with billing details, total billed, outstanding and last payment' })
  customers() {
    return this.billing.customerViews();
  }

  @Post('customers')
  @RequirePermission(VIEW, MANAGE, 'finance.entry_create')
  @ApiOperation({ summary: 'A new client (a Module 9 client with its billing details)' })
  createCustomer(@CurrentActor() actor: Actor, @Body() body: CustomerDto, @ClientInfo() client: RequestInfo) {
    return this.billing.createCustomer(actor, body, client);
  }

  @Patch('customers/:id')
  @RequirePermission(VIEW, MANAGE, 'finance.entry_create')
  updateCustomer(@CurrentActor() actor: Actor, @Param('id', new ParseUUIDPipe()) id: string, @Body() body: UpdateCustomerDto, @ClientInfo() client: RequestInfo) {
    return this.billing.updateCustomer(actor, id, body, client);
  }

  @Post('customers/:id/confirm')
  @HttpCode(200)
  @RequirePermission(VIEW, MANAGE)
  @ApiOperation({ summary: 'Confirm a client that was created automatically from a Won deal (its invoices can then be issued)' })
  confirmCustomer(@CurrentActor() actor: Actor, @Param('id', new ParseUUIDPipe()) id: string, @ClientInfo() client: RequestInfo) {
    return this.billing.confirmCustomer(actor, id, client);
  }

  @Get('deal-handovers')
  @RequirePermission(VIEW)
  @ApiOperation({ summary: 'Won deals received from sales. Default: the ones waiting for Finance to choose the client (?status=drafted|needs_client|all)' })
  handovers(@Query() q: HandoverListDto) {
    return this.billing.dealHandovers(q.status ?? 'needs_client');
  }

  @Post('deal-handovers/:id/resolve')
  @HttpCode(200)
  @RequirePermission(VIEW, MANAGE)
  @ApiOperation({ summary: 'Choose the client of a Won deal whose name matched several clients; its draft invoice is made (once)' })
  resolveHandover(@CurrentActor() actor: Actor, @Param('id', new ParseUUIDPipe()) id: string, @Body() body: ResolveHandoverDto, @ClientInfo() client: RequestInfo) {
    return this.billing.resolveDealHandover(actor, id, body.partyId, client);
  }

  @Get('recurring')
  @RequirePermission(VIEW)
  @ApiOperation({ summary: 'Recurring and rental billing rules' })
  recurring() {
    return this.billing.recurringRules();
  }

  @Post('recurring/:id/stop')
  @HttpCode(200)
  @RequirePermission(VIEW, MANAGE)
  stopRecurring(@CurrentActor() actor: Actor, @Param('id', new ParseUUIDPipe()) id: string, @Body() body: StopRecurringDto, @ClientInfo() client: RequestInfo) {
    return this.billing.stopRecurring(actor, id, body.reason, client);
  }
}

/** Aceva's subscriptions and services: the Director manages them (subscriptions.manage); Finance, the CEO and the Owner view. */
@ApiTags('billing')
@FinanceScreen()
@Controller('billing/subscriptions')
export class SubscriptionsController {
  constructor(private readonly subs: SubscriptionsService) {}

  @Get()
  @RequirePermission(SUB_VIEW)
  @ApiOperation({ summary: 'The register with renewal status, the latest usage readings and costs' })
  list() {
    return this.subs.list();
  }

  @Get('renewal-events')
  @RequirePermission(SUB_VIEW)
  @ApiOperation({ summary: 'Renewal alerts and decisions, newest first' })
  events() {
    return this.subs.renewalEvents();
  }

  @Post()
  @RequirePermission(SUB_VIEW, SUB_MANAGE)
  create(@CurrentActor() actor: Actor, @Body() body: SubscriptionDto, @ClientInfo() client: RequestInfo) {
    return this.subs.create(actor, body, client);
  }

  @Get(':id')
  @RequirePermission(SUB_VIEW)
  get(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.subs.get(id);
  }

  @Patch(':id')
  @RequirePermission(SUB_VIEW, SUB_MANAGE)
  update(@CurrentActor() actor: Actor, @Param('id', new ParseUUIDPipe()) id: string, @Body() body: UpdateSubscriptionDto, @ClientInfo() client: RequestInfo) {
    return this.subs.update(actor, id, body, client);
  }

  @Post(':id/renewal-decision')
  @HttpCode(200)
  @RequirePermission(SUB_VIEW, SUB_MANAGE)
  @ApiOperation({ summary: 'Renewed, changed (plan, cost or period) or cancelled' })
  decide(@CurrentActor() actor: Actor, @Param('id', new ParseUUIDPipe()) id: string, @Body() body: RenewalDecisionDto, @ClientInfo() client: RequestInfo) {
    return this.subs.decide(actor, id, body, client);
  }

  @Post(':id/usage')
  @RequirePermission(SUB_VIEW, SUB_MANAGE)
  @ApiOperation({ summary: 'A usage reading typed in by hand (a cost on it is an estimate)' })
  usage(@CurrentActor() actor: Actor, @Param('id', new ParseUUIDPipe()) id: string, @Body() body: UsageReadingDto, @ClientInfo() client: RequestInfo) {
    return this.subs.addUsage(actor, id, body, client);
  }

  @Put(':id/costs/:month')
  @RequirePermission(SUB_VIEW, SUB_MANAGE)
  @ApiOperation({ summary: 'The cost of a month: estimated, or actual when backed by a Module 9 bill or the provider invoice reference' })
  cost(@CurrentActor() actor: Actor, @Param('id', new ParseUUIDPipe()) id: string, @Param() p: CostMonthDto, @Body() body: SubscriptionCostDto, @ClientInfo() client: RequestInfo) {
    return this.subs.setCost(actor, id, p.month, body, client);
  }
}
