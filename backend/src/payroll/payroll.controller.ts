import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { z } from 'zod';
import {
  addPayrollItemSchema,
  createPayrollAdjustmentSchema,
  createPayrollRunSchema,
  createSalaryAdvanceSchema,
  createTaxSlabSetSchema,
  empIdSchema,
  markPayrollPaidSchema,
  monthSchema,
  returnPayrollRunSchema,
} from '@aceva/contracts';
import type { Actor } from '../access/access.types';
import { Authenticated, ClientInfo, CurrentActor, CurrentSessionId, FinanceScreen, RequestInfo, RequirePermission } from '../access/decorators';
import { createZodDto } from '../common/zod-validation.pipe';
import { AdvancesService } from './advances.service';
import { PayrollRunsService } from './payroll-runs.service';
import { PayslipsService } from './payslips.service';
import { TaxSlabsService } from './tax-slabs.service';

class CreateRunDto extends createZodDto(createPayrollRunSchema) {}
class AddItemDto extends createZodDto(addPayrollItemSchema) {}
class ReturnRunDto extends createZodDto(returnPayrollRunSchema) {}
class MarkPaidDto extends createZodDto(markPayrollPaidSchema) {}
class CreateAdjustmentDto extends createZodDto(createPayrollAdjustmentSchema) {}
class CreateAdvanceDto extends createZodDto(createSalaryAdvanceSchema) {}
class CreateTaxSlabsDto extends createZodDto(createTaxSlabSetSchema) {}
class MonthFilterDto extends createZodDto(z.object({ month: monthSchema.optional() })) {}
class EmpFilterDto extends createZodDto(z.object({ empId: empIdSchema.optional() })) {}
class MonthParamDto extends createZodDto(z.object({ month: monthSchema })) {}
class EmpParamDto extends createZodDto(z.object({ empId: empIdSchema })) {}

/**
 * Module 8 management screens (plan section 12). Highly confidential (plan section 16): every route is a finance screen
 * (10-minute idle limit; a refused permission answers 404).
 */
@ApiTags('payroll')
@Controller('payroll')
export class PayrollController {
  constructor(
    private readonly runs: PayrollRunsService,
    private readonly advances: AdvancesService,
  ) {}

  @Get('runs')
  @FinanceScreen()
  @RequirePermission('payroll.view')
  @ApiOperation({ summary: 'Payroll runs, newest month first, with totals and the ledger entry status' })
  list() {
    return this.runs.list();
  }

  @Post('runs')
  @FinanceScreen()
  @RequirePermission('payroll.prepare')
  @ApiOperation({ summary: 'Start the run for a month (Finance). One run per month: PR-YYYY-MM' })
  create(@CurrentActor() actor: Actor, @Body() body: CreateRunDto, @ClientInfo() client: RequestInfo) {
    return this.runs.create(actor, body.month, client);
  }

  @Get('runs/:id')
  @FinanceScreen()
  @RequirePermission('payroll.view')
  @ApiOperation({ summary: 'One run (by id or PR-YYYY-MM): stage, totals, who prepared, reviewed and approved it, warnings' })
  get(@Param('id') id: string) {
    return this.runs.get(id);
  }

  @Get('runs/:id/lines')
  @FinanceScreen()
  @RequirePermission('payroll.view')
  @ApiOperation({ summary: 'The run with every salary line and its bonus/deduction items (audited sensitive view)' })
  lines(@CurrentActor() actor: Actor, @Param('id') id: string, @ClientInfo() client: RequestInfo) {
    return this.runs.lines(actor, id, client);
  }

  @Post('runs/:id/calculate')
  @FinanceScreen()
  @RequirePermission('payroll.prepare')
  @HttpCode(200)
  @ApiOperation({ summary: 'Lock the month in attendance (Module 7) and calculate every salary. Allowed again until prepared' })
  calculate(@CurrentActor() actor: Actor, @Param('id') id: string, @ClientInfo() client: RequestInfo) {
    return this.runs.calculate(actor, id, client);
  }

  @Post('runs/:id/items')
  @FinanceScreen()
  @RequirePermission('payroll.prepare')
  @ApiOperation({ summary: 'Add a bonus or deduction line for one employee (before the run is prepared; a calculated run is recalculated)' })
  addItem(@CurrentActor() actor: Actor, @Param('id') id: string, @Body() body: AddItemDto, @ClientInfo() client: RequestInfo) {
    return this.runs.addItem(actor, id, body, client);
  }

  @Delete('runs/:id/items/:itemId')
  @FinanceScreen()
  @RequirePermission('payroll.prepare')
  @HttpCode(204)
  @ApiOperation({ summary: 'Remove a manual bonus or deduction line (before the run is prepared)' })
  async deleteItem(@CurrentActor() actor: Actor, @Param('id') id: string, @Param('itemId', new ParseUUIDPipe()) itemId: string, @ClientInfo() client: RequestInfo) {
    await this.runs.deleteItem(actor, id, itemId, client);
  }

  @Post('runs/:id/prepare')
  @FinanceScreen()
  @RequirePermission('payroll.prepare')
  @HttpCode(200)
  @ApiOperation({ summary: 'Finance prepares the calculated draft and sends it to the Director' })
  prepare(@CurrentActor() actor: Actor, @Param('id') id: string, @ClientInfo() client: RequestInfo) {
    return this.runs.prepare(actor, id, client);
  }

  @Post('runs/:id/review')
  @FinanceScreen()
  @RequirePermission('payroll.review')
  @HttpCode(200)
  @ApiOperation({ summary: 'The Director reviews a prepared run (never the preparer)' })
  review(@CurrentActor() actor: Actor, @Param('id') id: string, @ClientInfo() client: RequestInfo) {
    return this.runs.review(actor, id, client);
  }

  @Post('runs/:id/approve')
  @FinanceScreen()
  @RequirePermission('payroll.approve')
  @HttpCode(200)
  @ApiOperation({ summary: 'The CEO approves a reviewed run (confirm again; never the preparer). Issues payslips and creates the salary entry' })
  approve(@CurrentActor() actor: Actor, @CurrentSessionId() sessionId: string | null, @Param('id') id: string, @ClientInfo() client: RequestInfo) {
    return this.runs.approve(actor, sessionId, id, client);
  }

  @Post('runs/:id/return')
  @FinanceScreen()
  @RequirePermission('payroll.view')
  @HttpCode(200)
  @ApiOperation({ summary: 'Send a prepared or reviewed run back to Finance with a reason (Director or CEO)' })
  returnRun(@CurrentActor() actor: Actor, @Param('id') id: string, @Body() body: ReturnRunDto, @ClientInfo() client: RequestInfo) {
    return this.runs.returnRun(actor, id, body.reason, client);
  }

  @Post('runs/:id/mark-paid')
  @FinanceScreen()
  @RequirePermission('payroll.prepare')
  @HttpCode(200)
  @ApiOperation({ summary: 'Record the bank transfer: a payment entry clears salary payable (once per approved run)' })
  markPaid(@CurrentActor() actor: Actor, @Param('id') id: string, @Body() body: MarkPaidDto, @ClientInfo() client: RequestInfo) {
    return this.runs.markPaid(actor, id, body, client);
  }

  @Get('runs/:id/bank-sheet')
  @FinanceScreen()
  @RequirePermission('payroll.export')
  @ApiOperation({ summary: 'Bank transfer sheet (CSV, highly confidential, confirm again, logged). Approved runs only' })
  async bankSheet(
    @CurrentActor() actor: Actor,
    @CurrentSessionId() sessionId: string | null,
    @Param('id') id: string,
    @ClientInfo() client: RequestInfo,
    @Res({ passthrough: true }) res: Response,
  ) {
    const sheet = await this.runs.bankSheet(actor, sessionId, id, client);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${sheet.fileName}"`);
    res.setHeader('Cache-Control', 'no-store');
    return sheet.csv;
  }

  @Get('adjustments')
  @FinanceScreen()
  @RequirePermission('payroll.view')
  @ApiOperation({ summary: 'Adjustments (fixes to approved runs), optionally for one target month' })
  adjustments(@Query() query: MonthFilterDto) {
    return this.runs.listAdjustments(query.month);
  }

  @Post('adjustments')
  @FinanceScreen()
  @RequirePermission('payroll.prepare')
  @ApiOperation({ summary: 'Fix a mistake in an approved run through a later month (never by editing the approved run)' })
  createAdjustment(@CurrentActor() actor: Actor, @Body() body: CreateAdjustmentDto, @ClientInfo() client: RequestInfo) {
    return this.runs.createAdjustment(actor, body, client);
  }

  @Get('advances/me')
  @RequirePermission('payroll.view_own')
  @ApiOperation({ summary: 'My own salary advances and what remains to repay' })
  myAdvances(@CurrentActor() actor: Actor) {
    return this.advances.mine(actor);
  }

  @Get('advances')
  @FinanceScreen()
  @RequirePermission('payroll.view')
  @ApiOperation({ summary: 'Salary advances (optionally one person) with repayments and the payout entry status' })
  listAdvances(@Query() query: EmpFilterDto) {
    return this.advances.list(query.empId);
  }

  @Post('advances')
  @FinanceScreen()
  @RequirePermission('payroll.prepare')
  @ApiOperation({ summary: 'Record a salary advance; its payout entry waits for ledger approval, repayments start once it is posted' })
  createAdvance(@CurrentActor() actor: Actor, @Body() body: CreateAdvanceDto, @ClientInfo() client: RequestInfo) {
    return this.advances.create(actor, body, client);
  }
}

/** Payslips: everyone sees their own; other people's need payroll.view (404 otherwise, audited). */
@ApiTags('payslips')
@Controller('payslips')
export class PayslipsController {
  constructor(private readonly payslips: PayslipsService) {}

  @Get('me')
  @RequirePermission('payroll.view_own')
  @ApiOperation({ summary: 'My payslips, newest first' })
  mine(@CurrentActor() actor: Actor) {
    return this.payslips.mine(actor);
  }

  @Get('me/:month')
  @RequirePermission('payroll.view_own')
  @ApiOperation({ summary: 'My payslip for a month: earnings, deductions, net, year-to-date net' })
  mineFor(@CurrentActor() actor: Actor, @Param() params: MonthParamDto) {
    return this.payslips.mineFor(actor, params.month);
  }

  @Get('employees/:empId')
  @FinanceScreen()
  @RequirePermission('payroll.view')
  @ApiOperation({ summary: "Someone's payslips (finance and management; audited)" })
  forEmployee(@CurrentActor() actor: Actor, @Param() params: EmpParamDto, @ClientInfo() client: RequestInfo) {
    return this.payslips.forEmployee(actor, params.empId, client);
  }

  @Get(':id')
  @Authenticated()
  @ApiOperation({ summary: 'One payslip: own, or anyone with payroll.view (audited); 404 otherwise' })
  byId(@CurrentActor() actor: Actor, @Param('id') id: string, @ClientInfo() client: RequestInfo) {
    return this.payslips.byId(actor, id, client);
  }

  @Get(':id/document')
  @Authenticated()
  @ApiOperation({ summary: 'The printable payslip (HTML until a PDF library is approved), same rules as GET /payslips/:id' })
  async document(@CurrentActor() actor: Actor, @Param('id') id: string, @ClientInfo() client: RequestInfo, @Res({ passthrough: true }) res: Response) {
    const html = await this.payslips.document(actor, id, client);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
    return html;
  }
}

/** Income tax slabs (Settings; plan section 12). */
@ApiTags('settings')
@Controller('settings/tax-slabs')
export class TaxSlabsController {
  constructor(private readonly taxSlabs: TaxSlabsService) {}

  @Get()
  @Authenticated()
  @ApiOperation({ summary: 'The tax slab version in force and every earlier version (payroll.view or settings.view)' })
  list(@CurrentActor() actor: Actor) {
    return this.taxSlabs.list(actor);
  }

  @Post()
  @RequirePermission('settings.manage')
  @ApiOperation({ summary: 'Enter a NEW version of the yearly tax slabs (contiguous, increasing, rate 0..1); audited' })
  create(@CurrentActor() actor: Actor, @Body() body: CreateTaxSlabsDto, @ClientInfo() client: RequestInfo) {
    return this.taxSlabs.create(actor, body, client);
  }
}
