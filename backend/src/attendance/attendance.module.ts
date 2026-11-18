import { Module } from '@nestjs/common';
import { OrgModule } from '../org/org.module';
import { AttendanceDaysService } from './attendance-days.service';
import { AttendancePayrollAdapter } from './attendance-payroll.adapter';
import { AttendancePayrollPort } from './attendance-payroll.port';
import { AttendanceSettingsService } from './attendance-settings.service';
import { AttendanceController, AttendanceSettingsController, HolidaysController } from './attendance.controller';
import { AttendanceService } from './attendance.service';
import { CorrectionsService } from './corrections.service';
import { LeaveController } from './leave.controller';
import { LeaveService } from './leave.service';
import { RoutingHelper } from './routing.helper';
import { WorkCalendarService } from './work-calendar.service';

/**
 * Module 7: attendance and leave (plan section 11). Owner: Track A.
 * Exports AttendancePayrollPort for Module 8 and WorkCalendarService (THE source of "working day" for tasks and payroll).
 * Imports nothing from Module 8.
 */
@Module({
  imports: [OrgModule],
  controllers: [AttendanceController, HolidaysController, AttendanceSettingsController, LeaveController],
  providers: [
    WorkCalendarService,
    AttendanceDaysService,
    RoutingHelper,
    AttendanceService,
    CorrectionsService,
    LeaveService,
    AttendanceSettingsService,
    { provide: AttendancePayrollPort, useClass: AttendancePayrollAdapter },
  ],
  exports: [AttendancePayrollPort, WorkCalendarService],
})
export class AttendanceModule {}
