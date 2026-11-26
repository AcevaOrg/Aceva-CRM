import { Module } from '@nestjs/common';
import { BILLING_SETTINGS_DEFAULTS, billingSettingsSchema } from '@aceva/contracts';
import { FinanceModule } from '../finance/finance.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { ModuleSettingsService } from '../settings/module-settings.service';
import { BillingDailyService } from './billing-daily.service';
import { BillingEventsConsumer } from './billing-events.consumer';
import { BillingController, SubscriptionsController } from './billing.controller';
import { BILLING_SETTINGS, BillingService } from './billing.service';
import { CustomerEmailService } from './customer-email.service';
import { SubscriptionsService } from './subscriptions.service';

/**
 * Module 13: customer billing, subscriptions and renewal management (plan section 18). Owner: Developer A.
 * Builds on Module 9 (one invoice and payment system; only Module 9 writes money), the notification core and the
 * module-owned settings of the Cycle 3 foundation. Module 15 reaches it only through the sales.deal.won_confirmed event.
 */
@Module({
  imports: [FinanceModule, NotificationsModule],
  controllers: [BillingController, SubscriptionsController],
  providers: [BillingService, SubscriptionsService, BillingDailyService, CustomerEmailService, BillingEventsConsumer],
})
export class BillingModule {
  constructor(settings: ModuleSettingsService) {
    // Company details and the sending address are empty until management enters the real ones (nothing is invented);
    // changing them needs settings.manage (the Director) and "confirm again".
    settings.register({ module: BILLING_SETTINGS, schema: billingSettingsSchema, defaults: BILLING_SETTINGS_DEFAULTS, viewPermission: 'billing.view', managePermission: 'settings.manage', stepUp: true });
  }
}
