import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  completeSalesFollowUpSchema,
  createSalesCompanySchema,
  logSalesActivitySchema,
  salesFollowUpListQuerySchema,
  createSalesDealSchema,
  moveSalesDealSchema,
  rejectSalesWonSchema,
  salesDealListQuerySchema,
  salesDealVersionSchema,
  updateSalesDealSchema,
  createSalesLeadSchema,
  reassignSalesLeadSchema,
  salesCompanyListQuerySchema,
  salesDuplicateCheckSchema,
  salesLeadListQuerySchema,
  updateSalesCompanySchema,
  updateSalesLeadSchema,
} from '@aceva/contracts';
import type { Actor } from '../access/access.types';
import { ClientInfo, CurrentActor, RequirePermission, type RequestInfo } from '../access/decorators';
import { createZodDto } from '../common/zod-validation.pipe';
import { ActivitiesService } from './activities.service';
import { CompaniesService } from './companies.service';
import { DealsService } from './deals.service';
import { LeadsService } from './leads.service';
import { SALES_OWN } from './sales-access.service';

class LeadListQueryDto extends createZodDto(salesLeadListQuerySchema) {}
class CreateLeadDto extends createZodDto(createSalesLeadSchema) {}
class UpdateLeadDto extends createZodDto(updateSalesLeadSchema) {}
class ReassignLeadDto extends createZodDto(reassignSalesLeadSchema) {}
class DuplicateCheckDto extends createZodDto(salesDuplicateCheckSchema) {}
class CompanyListQueryDto extends createZodDto(salesCompanyListQuerySchema) {}
class CreateCompanyDto extends createZodDto(createSalesCompanySchema) {}
class UpdateCompanyDto extends createZodDto(updateSalesCompanySchema) {}
class LogActivityDto extends createZodDto(logSalesActivitySchema) {}
class CompleteFollowUpDto extends createZodDto(completeSalesFollowUpSchema) {}
class FollowUpListQueryDto extends createZodDto(salesFollowUpListQuerySchema) {}

/**
 * Module 15.1 leads (plan section 20). Every route needs sales.own; what each person sees and changes inside is decided
 * by SalesAccessService (own leads; the team for the sales manager; everything for sales.all). All routes are under
 * /sales, so Module 4 records them as the "Sales" module by itself.
 */
@ApiTags('sales')
@Controller('sales/leads')
export class SalesLeadsController {
  constructor(
    private readonly leads: LeadsService,
    private readonly activities: ActivitiesService,
  ) {}

  @Get(':id/activities')
  @RequirePermission(SALES_OWN)
  @ApiOperation({ summary: "The lead's timeline (its deals' entries too), newest first. Only for whoever sees the lead in full" })
  timeline(@CurrentActor() actor: Actor, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.activities.forLead(actor, id);
  }

  @Post(':id/activities')
  @RequirePermission(SALES_OWN)
  @ApiOperation({ summary: 'Log a contact by hand on the lead (the owner, or the sales manager for their team)' })
  logActivity(@CurrentActor() actor: Actor, @Param('id', new ParseUUIDPipe()) id: string, @Body() body: LogActivityDto, @ClientInfo() client: RequestInfo) {
    return this.activities.log(actor, { leadId: id }, body, client);
  }

  @Get()
  @RequirePermission(SALES_OWN)
  @ApiOperation({ summary: 'Leads the caller may see in full: own; the team (sales manager); all (sales.all). ?owner&source&country&companyId&q&status&page' })
  list(@CurrentActor() actor: Actor, @Query() q: LeadListQueryDto) {
    return this.leads.list(actor, q);
  }

  @Post()
  @RequirePermission(SALES_OWN)
  @ApiOperation({ summary: 'Add a lead. The same email (not archived) is refused with its owner (409 duplicate_lead); a company whose website domain exists is that company' })
  create(@CurrentActor() actor: Actor, @Body() body: CreateLeadDto, @ClientInfo() client: RequestInfo) {
    return this.leads.create(actor, body, client);
  }

  @Post('check-duplicate')
  @HttpCode(200)
  @RequirePermission(SALES_OWN)
  @ApiOperation({ summary: 'Before saving: does this email or company domain exist, and who owns it (limited per minute, logged)' })
  checkDuplicate(@CurrentActor() actor: Actor, @Body() body: DuplicateCheckDto, @ClientInfo() client: RequestInfo) {
    return this.leads.checkDuplicate(actor, body, client);
  }

  @Get(':id')
  @RequirePermission(SALES_OWN)
  @ApiOperation({ summary: "A lead in full, or for someone else's lead only that it exists and who owns it (restricted: true)" })
  get(@CurrentActor() actor: Actor, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.leads.get(actor, id);
  }

  @Patch(':id')
  @RequirePermission(SALES_OWN)
  @ApiOperation({ summary: 'Change a lead (the owner, or the sales manager for their team). Name the version you read' })
  update(@CurrentActor() actor: Actor, @Param('id', new ParseUUIDPipe()) id: string, @Body() body: UpdateLeadDto, @ClientInfo() client: RequestInfo) {
    return this.leads.update(actor, id, body, client);
  }

  @Post(':id/owner')
  @HttpCode(200)
  @RequirePermission(SALES_OWN)
  @ApiOperation({ summary: 'The sales manager moves a lead to another salesperson in their team (reason required, logged)' })
  reassign(@CurrentActor() actor: Actor, @Param('id', new ParseUUIDPipe()) id: string, @Body() body: ReassignLeadDto, @ClientInfo() client: RequestInfo) {
    return this.leads.reassign(actor, id, body, client);
  }
}

@ApiTags('sales')
@Controller('sales/companies')
export class SalesCompaniesController {
  constructor(private readonly companies: CompaniesService) {}

  @Get()
  @RequirePermission(SALES_OWN)
  @ApiOperation({ summary: 'Companies that are not archived (name, website, country, industry). ?q&page' })
  list(@CurrentActor() actor: Actor, @Query() q: CompanyListQueryDto) {
    return this.companies.list(actor, q);
  }

  @Post()
  @RequirePermission(SALES_OWN)
  @ApiOperation({ summary: 'Add a company. A website domain that already belongs to a company is refused with that company (409 duplicate_company)' })
  create(@CurrentActor() actor: Actor, @Body() body: CreateCompanyDto, @ClientInfo() client: RequestInfo) {
    return this.companies.create(actor, body, client);
  }

  @Get(':id')
  @RequirePermission(SALES_OWN)
  @ApiOperation({ summary: 'A company with the leads there the caller may see in full, and how many others there are' })
  get(@CurrentActor() actor: Actor, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.companies.get(actor, id);
  }

  @Patch(':id')
  @RequirePermission(SALES_OWN)
  @ApiOperation({ summary: 'Change a company (the sales manager, whoever added it, or the owner of one of its leads). Name the version you read' })
  update(@CurrentActor() actor: Actor, @Param('id', new ParseUUIDPipe()) id: string, @Body() body: UpdateCompanyDto, @ClientInfo() client: RequestInfo) {
    return this.companies.update(actor, id, body, client);
  }
}

class DealListQueryDto extends createZodDto(salesDealListQuerySchema) {}
class CreateDealDto extends createZodDto(createSalesDealSchema) {}
class UpdateDealDto extends createZodDto(updateSalesDealSchema) {}
class MoveDealDto extends createZodDto(moveSalesDealSchema) {}
class DealVersionDto extends createZodDto(salesDealVersionSchema) {}
class RejectWonDto extends createZodDto(rejectSalesWonSchema) {}

/**
 * Module 15.2 deals and the pipeline (plan section 20). Every route needs sales.own; DealsService decides inside (own;
 * the team for the sales manager; all for sales.all; the Won confirmation for the sales manager, never the owner or the
 * person who asked). A deal is addressed by its id or its number (DL-2026-0001).
 */
@ApiTags('sales')
@Controller('sales/deals')
export class SalesDealsController {
  constructor(
    private readonly deals: DealsService,
    private readonly activities: ActivitiesService,
  ) {}

  @Get(':id/activities')
  @RequirePermission(SALES_OWN)
  @ApiOperation({ summary: "The deal's timeline (and its lead's entries about no deal), newest first" })
  timeline(@CurrentActor() actor: Actor, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.activities.forDeal(actor, id);
  }

  @Post(':id/activities')
  @RequirePermission(SALES_OWN)
  @ApiOperation({ summary: 'Log a contact on the deal; it moves the deal forward only (never a Won, Lost or pending-Won deal)' })
  logActivity(@CurrentActor() actor: Actor, @Param('id', new ParseUUIDPipe()) id: string, @Body() body: LogActivityDto, @ClientInfo() client: RequestInfo) {
    return this.activities.log(actor, { dealId: id }, body, client);
  }

  @Post(':id/follow-up')
  @HttpCode(200)
  @RequirePermission(SALES_OWN)
  @ApiOperation({ summary: 'The follow-up is done (a follow_up activity) and the next step is set. Name the version you read' })
  completeFollowUp(@CurrentActor() actor: Actor, @Param('id') id: string, @Body() body: CompleteFollowUpDto, @ClientInfo() client: RequestInfo) {
    return this.deals.completeFollowUp(actor, id, body, client);
  }

  @Get()
  @RequirePermission(SALES_OWN)
  @ApiOperation({ summary: 'Deals the caller may see in full. ?owner&stage&leadId&wonStatus&status(open|closed|all)&page' })
  list(@CurrentActor() actor: Actor, @Query() q: DealListQueryDto) {
    return this.deals.list(actor, q);
  }

  @Get('summary')
  @RequirePermission(SALES_OWN)
  @ApiOperation({ summary: 'Per stage: how many deals and their totals per currency (no conversion); pending Won requests' })
  summary(@CurrentActor() actor: Actor) {
    return this.deals.summary(actor);
  }

  @Post()
  @RequirePermission(SALES_OWN)
  @ApiOperation({ summary: "Add a deal for a lead (it starts in New, with a next step and a date). Refused while a lost deal's re-contact date has not come" })
  create(@CurrentActor() actor: Actor, @Body() body: CreateDealDto, @ClientInfo() client: RequestInfo) {
    return this.deals.create(actor, body, client);
  }

  @Get(':id')
  @RequirePermission(SALES_OWN)
  @ApiOperation({ summary: "A deal with its stage history and Module 13 handover, or for someone else's deal only that it exists and who owns it" })
  get(@CurrentActor() actor: Actor, @Param('id') id: string) {
    return this.deals.get(actor, id);
  }

  @Patch(':id')
  @RequirePermission(SALES_OWN)
  @ApiOperation({ summary: 'Change an open deal (service, value, currency, expected close, next step). Name the version you read' })
  update(@CurrentActor() actor: Actor, @Param('id') id: string, @Body() body: UpdateDealDto, @ClientInfo() client: RequestInfo) {
    return this.deals.update(actor, id, body, client);
  }

  @Post(':id/move')
  @HttpCode(200)
  @RequirePermission(SALES_OWN)
  @ApiOperation({ summary: 'Move to another open stage, or to Lost with a reason from the settings (the re-contact date follows). Never to Won' })
  move(@CurrentActor() actor: Actor, @Param('id') id: string, @Body() body: MoveDealDto, @ClientInfo() client: RequestInfo) {
    return this.deals.move(actor, id, body, client);
  }

  @Post(':id/request-won')
  @HttpCode(200)
  @RequirePermission(SALES_OWN)
  @ApiOperation({ summary: 'Mark the deal Won: it waits for the sales manager to confirm it' })
  requestWon(@CurrentActor() actor: Actor, @Param('id') id: string, @Body() body: DealVersionDto, @ClientInfo() client: RequestInfo) {
    return this.deals.requestWon(actor, id, body.version, client);
  }

  @Post(':id/confirm-won')
  @HttpCode(200)
  @RequirePermission(SALES_OWN)
  @ApiOperation({ summary: 'The sales manager confirms a Won request (never their own deal or request); Module 13 then makes the draft invoice' })
  confirmWon(@CurrentActor() actor: Actor, @Param('id') id: string, @Body() body: DealVersionDto, @ClientInfo() client: RequestInfo) {
    return this.deals.confirmWon(actor, id, body.version, client);
  }

  @Post(':id/reject-won')
  @HttpCode(200)
  @RequirePermission(SALES_OWN)
  @ApiOperation({ summary: 'The sales manager sends a Won request back with a reason; the deal stays open' })
  rejectWon(@CurrentActor() actor: Actor, @Param('id') id: string, @Body() body: RejectWonDto, @ClientInfo() client: RequestInfo) {
    return this.deals.rejectWon(actor, id, body, client);
  }
}

/** M15.3: an open deal's next step is its follow-up. Due today, or missed (its date has passed, Pakistan time). */
@ApiTags('sales')
@Controller('sales/follow-ups')
export class SalesFollowUpsController {
  constructor(private readonly deals: DealsService) {}

  @Get()
  @RequirePermission(SALES_OWN)
  @ApiOperation({ summary: "Follow-ups: ?scope=mine|team (team: the sales manager's team) &status=due|missed|all &owner" })
  list(@CurrentActor() actor: Actor, @Query() q: FollowUpListQueryDto) {
    return this.deals.followUps(actor, q);
  }
}
