import { Module } from '@nestjs/common';
import { APP_PIPE } from '@nestjs/core';
import { ZodValidationPipe } from './common/zod-validation.pipe';
import { ConfigModule } from './config/config.module';
import { AccessModule } from './access/access.module';
import { HealthModule } from './health/health.module';
import { OrgModule } from './org/org.module';
import { PrismaModule } from './prisma/prisma.module';

@Module({
  imports: [ConfigModule, PrismaModule, AccessModule, HealthModule, OrgModule],
  providers: [{ provide: APP_PIPE, useClass: ZodValidationPipe }],
})
export class AppModule {}
