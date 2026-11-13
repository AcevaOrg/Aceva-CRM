import { Module } from '@nestjs/common';
import { AttendanceModule } from '../attendance/attendance.module';
import { FinanceModule } from '../finance/finance.module';
import { OrgModule } from '../org/org.module';
import { PeopleModule } from '../people/people.module';
import { AdvancesService } from './advances.service';
import { FinalSettlementService } from './final-settlement.service';
import { PayrollController, PayslipsController, TaxSlabsController } from './payroll.controller';
import { PayrollRunsService } from './payroll-runs.service';
import { PayslipsService } from './payslips.service';
import { TaxSlabsService } from './tax-slabs.service';

/**
 * Module 8: payroll (plan section 12). Owner: Track B.
 * Depends on Module 7 (AttendancePayrollPort) and Module 9 (LedgerPostingPort); neither of them depends on this module.
 */
@Module({
  imports: [OrgModule, PeopleModule, AttendanceModule, FinanceModule],
  controllers: [PayrollController, PayslipsController, TaxSlabsController],
  providers: [PayrollRunsService, AdvancesService, PayslipsService, TaxSlabsService, FinalSettlementService],
})
export class PayrollModule {}