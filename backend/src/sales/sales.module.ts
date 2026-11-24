import { Module } from '@nestjs/common';
import { SALES_SETTINGS, SALES_SETTINGS_DEFAULTS, salesSettingsSchema } from '@aceva/contracts';
import { OrgModule } from '../org/org.module';
import { ModuleSettingsService } from '../settings/module-settings.service';
import { CompaniesService } from './companies.service';
import { DealsService } from './deals.service';
import { DuplicateCheckThrottle } from './duplicate-check-throttle';
import { LeadsService } from './leads.service';
import { SalesAccessService, SALES_OWN } from './sales-access.service';
import { SalesApprovalsProvider } from './sales-approvals.provider';
import { SalesCompaniesController, SalesDealsController, SalesLeadsController } from './sales.controller';

/**
 * Module 15: sales and CRM (plan section 20). Owner: Developer B. M15.1: leads and companies. M15.2: deals and the pipeline
 * (Won requests in the approvals inbox; a confirmed Won deal goes to Module 13 through sales.deal.won_confirmed).
 * It works on its own with manual entries (plan section 23); Module 16 adds the automatic counts later.
 */
@Module({
  imports: [OrgModule],
  controllers: [SalesLeadsController, SalesCompaniesController, SalesDealsController],
  providers: [SalesAccessService, CompaniesService, LeadsService, DealsService, DuplicateCheckThrottle, SalesApprovalsProvider],
  exports: [SalesAccessService],
})
export class SalesModule {
  constructor(settings: ModuleSettingsService) {
    // Changed by the Director (settings.manage) and logged; the sales team reads them. The shared-domain list starts empty.
    settings.register({ module: SALES_SETTINGS, schema: salesSettingsSchema, defaults: SALES_SETTINGS_DEFAULTS, viewPermission: SALES_OWN, managePermission: 'settings.manage' });
  }
}
