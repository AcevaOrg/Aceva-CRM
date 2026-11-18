import { Module } from '@nestjs/common';
import { APP_PIPE } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { ZodValidationPipe } from './common/zod-validation.pipe';
import { ConfigModule } from './config/config.module';
import { AccessModule } from './access/access.module';
import { ActivityModule } from './activity/activity.module';
import { AuthModule } from './auth/auth.module';
import { CommonModule } from './common/common.module';
import { RedisModule } from './redis/redis.module';
import { HealthModule } from './health/health.module';
import { AttendanceModule } from './attendance/attendance.module';
import { FinanceModule } from './finance/finance.module';
import { PayrollModule } from './payroll/payroll.module';
import { OrgModule } from './org/org.module';
import { PeopleModule } from './people/people.module';
import { PerformanceModule } from './performance/performance.module';
import { PrismaModule } from './prisma/prisma.module';
import { SettingsModule } from './settings/settings.module';
import { TasksModule } from './tasks/tasks.module';

@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    RedisModule,
    CommonModule,
    SettingsModule,
    ScheduleModule.forRoot(),
    AccessModule,
    AuthModule,
    HealthModule,
    OrgModule,
    PeopleModule,
    ActivityModule,
    TasksModule,
    PerformanceModule,
    AttendanceModule,
    FinanceModule,
    PayrollModule,
  ],
  providers: [{ provide: APP_PIPE, useClass: ZodValidationPipe }],
})
export class AppModule {}
