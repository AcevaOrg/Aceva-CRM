import { Module } from '@nestjs/common';
import { APP_PIPE } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { ZodValidationPipe } from './common/zod-validation.pipe';
import { ConfigModule } from './config/config.module';
import { AccessModule } from './access/access.module';
import { AuthModule } from './auth/auth.module';
import { CommonModule } from './common/common.module';
import { RedisModule } from './redis/redis.module';
import { HealthModule } from './health/health.module';
import { JobsModule } from './jobs/jobs.module';
import { AttendanceModule } from './attendance/attendance.module';
import { FinanceModule } from './finance/finance.module';
import { PayrollModule } from './payroll/payroll.module';
import { OrgModule } from './org/org.module';
import { PeopleModule } from './people/people.module';
import { PrismaModule } from './prisma/prisma.module';

@Module({
  imports: [ConfigModule, PrismaModule, RedisModule, CommonModule, ScheduleModule.forRoot(), JobsModule, AccessModule, AuthModule, HealthModule, OrgModule, PeopleModule, AttendanceModule, FinanceModule, PayrollModule],
  providers: [{ provide: APP_PIPE, useClass: ZodValidationPipe }],
})
export class AppModule {}
