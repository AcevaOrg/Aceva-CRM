import { Module } from '@nestjs/common';
import { SALES_SETTINGS, SALES_SETTINGS_DEFAULTS, salesSettingsSchema } from '@aceva/contracts';
import { ModuleSettingsService } from '../settings/module-settings.service';
import { CompaniesService } from './companies.service';
import { DuplicateCheckThrottle } from './duplicate-check-throttle';
import { LeadsService } from './leads.service';
import { SalesAccessService, SALES_OWN } from './sales-access.service';
import { SalesCompaniesController, SalesLeadsController } from './sales.controller';

/**
 * Module 15: sales and CRM (plan section 20). Owner: Developer B. M15.1: leads and companies.
 * It works on its own with manual entries (plan section 23); Module 16 adds the automatic counts later.
 */
@Module({
  controllers: [SalesLeadsController, SalesCompaniesController],
  providers: [SalesAccessService, CompaniesService, LeadsService, DuplicateCheckThrottle],
  exports: [SalesAccessService],
})
export class SalesModule {
  constructor(settings: ModuleSettingsService) {
    // Changed by the Director (settings.manage) and logged; the sales team reads them. The shared-domain list starts empty.
    settings.register({ module: SALES_SETTINGS, schema: salesSettingsSchema, defaults: SALES_SETTINGS_DEFAULTS, viewPermission: SALES_OWN, managePermission: 'settings.manage' });
  }
}
