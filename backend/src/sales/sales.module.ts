import { Module } from '@nestjs/common';
import { SALES_SETTINGS, SALES_SETTINGS_DEFAULTS, salesSettingsSchema } from '@aceva/contracts';
import { NotificationsModule } from '../notifications/notifications.module';
import { OrgModule } from '../org/org.module';
import { ModuleSettingsService } from '../settings/module-settings.service';
import { ActivitiesService } from './activities.service';
import { CompaniesService } from './companies.service';
import { DealsService } from './deals.service';
import { DncService } from './dnc.service';
import { DuplicateCheckThrottle } from './duplicate-check-throttle';
import { FollowUpRemindersService } from './follow-up-reminders.service';
import { LeadImportService } from './lead-import.service';
import { LeadsService } from './leads.service';
import { SalesAccessService, SALES_OWN } from './sales-access.service';
import { SalesApprovalsProvider } from './sales-approvals.provider';
import { SalesCompaniesController, SalesDealsController, SalesDncController, SalesFollowUpsController, SalesLeadsController } from './sales.controller';

/**
 * Module 15: sales and CRM (plan section 20). Owner: Developer B. M15.1: leads and companies. M15.2: deals and the pipeline
 * (Won requests in the approvals inbox; a confirmed Won deal goes to Module 13 through sales.deal.won_confirmed). M15.3:
 * activities, follow-ups (daily reminder at 09:00 Pakistan time) and proposal links. M15.4: the do-not-contact list and the
 * lead import (CSV, preview first).
 * It works on its own with manual entries (plan section 23); Module 16 adds the automatic counts later.
 */
@Module({
  imports: [OrgModule, NotificationsModule],
  controllers: [SalesLeadsController, SalesCompaniesController, SalesDealsController, SalesFollowUpsController, SalesDncController],
  providers: [SalesAccessService, CompaniesService, LeadsService, DealsService, ActivitiesService, DuplicateCheckThrottle, SalesApprovalsProvider, FollowUpRemindersService, DncService, LeadImportService],
  exports: [SalesAccessService],
})
export class SalesModule {
  constructor(settings: ModuleSettingsService) {
    // Changed by the Director (settings.manage) and logged; the sales team reads them. The shared-domain list starts empty.
    settings.register({ module: SALES_SETTINGS, schema: salesSettingsSchema, defaults: SALES_SETTINGS_DEFAULTS, viewPermission: SALES_OWN, managePermission: 'settings.manage' });
  }
}
