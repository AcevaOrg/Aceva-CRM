import { Module } from '@nestjs/common';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env';
import { OrgModule } from '../org/org.module';
import { FILE_STORAGE } from '../storage/file-storage';
import { LocalFileStorage } from '../storage/local-file-storage';
import {
  AccountsController,
  BankAccountsController,
  BankStatementsController,
  BillsController,
  ExchangeRatesController,
  FinanceSettingsController,
  InvoicesController,
  LedgerReportsController,
  PartiesController,
  PaymentsController,
  PeriodsController,
  ProjectsController,
  ReceiptsController,
  TransfersController,
} from './finance.controller';
import { FinanceDocumentsService } from './finance-documents.service';
import { FinanceExportService } from './finance-export.service';
import { FinanceViews } from './finance-views';
import { InvoiceLifecycleService } from './invoice-lifecycle.service';
import { JournalController } from './journal.controller';
import { JournalService } from './journal.service';
import { LedgerPostingPort } from './ledger-posting.port';
import { LedgerPostingService } from './ledger-posting.service';
import { LedgerQueryService } from './ledger-query.service';
import { MasterDataService } from './master-data.service';
import { PeriodsService } from './periods.service';
import { ReconciliationService } from './reconciliation.service';

/**
 * Module 9: finance ledger (plan section 13). Owner: Track C.
 * Exports LedgerPostingPort for Module 8, LedgerQueryService for Module 10, and the invoice life cycle with the documents
 * service for Module 13 (customer billing extends Module 9's invoices; it never writes money itself). Imports nothing from Module 8.
 */
@Module({
  imports: [OrgModule],
  controllers: [
    JournalController,
    AccountsController,
    BankAccountsController,
    PartiesController,
    ProjectsController,
    ExchangeRatesController,
    InvoicesController,
    BillsController,
    ReceiptsController,
    PaymentsController,
    TransfersController,
    BankStatementsController,
    PeriodsController,
    FinanceSettingsController,
    LedgerReportsController,
  ],
  providers: [
    FinanceViews,
    JournalService,
    LedgerQueryService,
    MasterDataService,
    FinanceDocumentsService,
    ReconciliationService,
    PeriodsService,
    FinanceExportService,
    InvoiceLifecycleService,
    { provide: LedgerPostingPort, useClass: LedgerPostingService },
    // Private file storage for receipts (the same kind as employee documents: a private folder today, S3/R2 later).
    { provide: FILE_STORAGE, inject: [ENV], useFactory: (env: Env) => new LocalFileStorage(env.FILE_STORAGE_ROOT) },
  ],
  exports: [LedgerPostingPort, LedgerQueryService, InvoiceLifecycleService, FinanceDocumentsService, JournalService, MasterDataService],
})
export class FinanceModule {}
