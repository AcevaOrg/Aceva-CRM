import { Module } from '@nestjs/common';
import { ApprovalsController } from '../approvals/approvals.controller';
import { ApprovalsService } from '../approvals/approvals.service';
import { StandInsController } from '../stand-ins/stand-ins.controller';
import { StandInsService } from '../stand-ins/stand-ins.service';
import { OrgController } from './org.controller';
import { OrgService } from './org.service';

/** M1 features: org chart, level and reporting-line changes, duties, stand-ins, approval routing. */
@Module({
  controllers: [OrgController, StandInsController, ApprovalsController],
  providers: [OrgService, StandInsService, ApprovalsService],
  exports: [ApprovalsService],
})
export class OrgModule {}
