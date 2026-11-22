import { Module } from '@nestjs/common';
import { ApprovalsController } from '../approvals/approvals.controller';
import { ApprovalsInboxController } from '../approvals/approvals-inbox.controller';
import { ApprovalsInbox } from '../approvals/approvals-inbox.service';
import { ApprovalsService } from '../approvals/approvals.service';
import { StandInsController } from '../stand-ins/stand-ins.controller';
import { StandInsService } from '../stand-ins/stand-ins.service';
import { OrgController } from './org.controller';
import { OrgService } from './org.service';
import { StructureService } from './structure.service';

/** M1 features: org chart, level and reporting-line changes, duties, stand-ins, approval routing, and the approvals inbox every module plugs into (Module 5 adds task reviews and extensions). */
@Module({
  controllers: [OrgController, StandInsController, ApprovalsController, ApprovalsInboxController],
  providers: [OrgService, StructureService, StandInsService, ApprovalsService, ApprovalsInbox],
  exports: [ApprovalsService, ApprovalsInbox, OrgService],
})
export class OrgModule {}
