import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { approveEntrySchema, createEntrySchema, entryListQuerySchema, rejectSchema, reverseEntrySchema, updateEntrySchema } from '@aceva/contracts';
import type { Actor } from '../access/access.types';
import { ClientInfo, CurrentActor, CurrentSessionId, FinanceScreen, RequirePermission, type RequestInfo } from '../access/decorators';
import { createZodDto } from '../common/zod-validation.pipe';
import { JournalService } from './journal.service';

class CreateEntryDto extends createZodDto(createEntrySchema) {}
class UpdateEntryDto extends createZodDto(updateEntrySchema) {}
class EntryListQueryDto extends createZodDto(entryListQuerySchema) {}
class ApproveEntryDto extends createZodDto(approveEntrySchema) {}
class RejectEntryDto extends createZodDto(rejectSchema) {}
class ReverseEntryDto extends createZodDto(reverseEntrySchema) {}

/** Journal entries (plan section 13). Every route is a finance screen: 10-minute idle limit, and "not found" for anyone else. */
@ApiTags('finance')
@FinanceScreen()
@Controller('journal-entries')
export class JournalController {
  constructor(private readonly journal: JournalService) {}

  @Get()
  @RequirePermission('finance.view')
  @ApiOperation({ summary: 'Journal entries (paged). ?status&month&source&accountId&partyId&projectId&awaitingMe&q' })
  list(@CurrentActor() actor: Actor, @Query() query: EntryListQueryDto) {
    return this.journal.list(actor, query);
  }

  @Get(':id')
  @RequirePermission('finance.view')
  @ApiOperation({ summary: 'One entry with lines, history and receipts' })
  get(@CurrentActor() actor: Actor, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.journal.view(actor, id);
  }

  @Post()
  @RequirePermission('finance.view', 'finance.entry_create')
  @ApiOperation({ summary: 'Create a draft entry (submit: true also submits it). Debits must equal credits.' })
  create(@CurrentActor() actor: Actor, @Body() body: CreateEntryDto, @ClientInfo() client: RequestInfo) {
    return this.journal.create(actor, body, client);
  }

  @Patch(':id')
  @RequirePermission('finance.view', 'finance.entry_create')
  @ApiOperation({ summary: 'Change a draft (the lines are replaced). Only the maker; only drafts.' })
  update(@CurrentActor() actor: Actor, @Param('id', new ParseUUIDPipe()) id: string, @Body() body: UpdateEntryDto, @ClientInfo() client: RequestInfo) {
    return this.journal.update(actor, id, body, client);
  }

  @Post(':id/submit')
  @HttpCode(200)
  @RequirePermission('finance.view', 'finance.entry_create')
  @ApiOperation({ summary: 'Submit a draft for approval; the approval tier is fixed now' })
  submit(@CurrentActor() actor: Actor, @Param('id', new ParseUUIDPipe()) id: string, @ClientInfo() client: RequestInfo) {
    return this.journal.submit(actor, id, client);
  }

  @Post(':id/approve')
  @HttpCode(200)
  @RequirePermission('finance.view', 'finance.entry_approve')
  @ApiOperation({ summary: 'Approve = post. Not the maker; the approver level must cover the tier; large entries need "confirm again".' })
  approve(@CurrentActor() actor: Actor, @Param('id', new ParseUUIDPipe()) id: string, @Body() body: ApproveEntryDto, @CurrentSessionId() sessionId: string | null, @ClientInfo() client: RequestInfo) {
    return this.journal.approve(actor, id, body.note, sessionId, client);
  }

  @Post(':id/reject')
  @HttpCode(200)
  @RequirePermission('finance.view', 'finance.entry_approve')
  @ApiOperation({ summary: 'Reject with a reason. A rejected entry never changes; the maker makes a new one.' })
  reject(@CurrentActor() actor: Actor, @Param('id', new ParseUUIDPipe()) id: string, @Body() body: RejectEntryDto, @ClientInfo() client: RequestInfo) {
    return this.journal.reject(actor, id, body.reason, client);
  }

  @Post(':id/reverse')
  @RequirePermission('finance.view', 'finance.entry_create')
  @ApiOperation({ summary: 'Create a reversing DRAFT of a posted entry (once). It follows the normal approval.' })
  reverse(@CurrentActor() actor: Actor, @Param('id', new ParseUUIDPipe()) id: string, @Body() body: ReverseEntryDto, @ClientInfo() client: RequestInfo) {
    return this.journal.reverse(actor, id, body.reason, body.date, client);
  }
}
