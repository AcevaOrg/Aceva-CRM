import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  createSalesCompanySchema,
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
import { CompaniesService } from './companies.service';
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

/**
 * Module 15.1 leads (plan section 20). Every route needs sales.own; what each person sees and changes inside is decided
 * by SalesAccessService (own leads; the team for the sales manager; everything for sales.all). All routes are under
 * /sales, so Module 4 records them as the "Sales" module by itself.
 */
@ApiTags('sales')
@Controller('sales/leads')
export class SalesLeadsController {
  constructor(private readonly leads: LeadsService) {}

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
