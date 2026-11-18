import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { payrollFinalSettlementRequestedV1 } from '@aceva/contracts';
import { Clock } from '../common/clock';
import { dbDate } from '../common/pakistan-time';
import { PrismaService } from '../prisma/prisma.service';

const EVENT_TYPE = 'payroll.final_settlement.requested';
const BATCH = 100;

/**
 * Consumer of the Module 3 event `payroll.final_settlement.requested` v1 (docs/EVENTS.md): every leaver gets one
 * `final_settlements` row. Their final salary is their normal line in the run of the month of their last working day,
 * flagged `final_settlement` (development default D11: no pro-rata). The row is marked settled when that run is approved.
 *
 * Rows are taken with FOR UPDATE SKIP LOCKED, so two server copies never take the same event; duplicates (same event, or a
 * second event for the same person) are ignored. Runs at the start of every calculation and once a minute.
 */
@Injectable()
export class FinalSettlementService {
  private readonly logger = new Logger('PayrollFinalSettlement');

  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
  ) {}

  @Interval(60_000)
  async scheduledConsume(): Promise<void> {
    await this.consume().catch((e) => this.logger.error(`Final settlement consumer failed: ${(e as Error).message}`));
  }

  /** Handles every waiting event. Returns how many final settlements were created. */
  async consume(): Promise<number> {
    let created = 0;
    for (;;) {
      const result = await this.prisma.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<Array<{ id: string; payload: unknown; occurred_at: Date; actor: string; version: number }>>`
          SELECT id, payload, occurred_at, actor, version FROM outbox_events
          WHERE type = ${EVENT_TYPE} AND version = 1 AND processed_at IS NULL
          ORDER BY occurred_at
          LIMIT ${BATCH}
          FOR UPDATE SKIP LOCKED`;
        if (!rows.length) return { taken: 0, created: 0 };
        let made = 0;
        for (const row of rows) {
          const parsed = payrollFinalSettlementRequestedV1.shape.payload.safeParse(row.payload);
          if (!parsed.success) {
            this.logger.warn(`Ignoring malformed ${EVENT_TYPE} event ${row.id}`);
            continue;
          }
          const employee = await tx.employee.findUnique({ where: { empId: parsed.data.empId }, select: { id: true } });
          if (!employee) {
            this.logger.warn(`Ignoring ${EVENT_TYPE} event ${row.id}: unknown employee`);
            continue;
          }
          const inserted = await tx.$executeRaw`
            INSERT INTO final_settlements (employee_id, last_working_day, source_event_id)
            VALUES (${employee.id}::uuid, ${dbDate(parsed.data.lastWorkingDay)}::date, ${row.id}::uuid)
            ON CONFLICT DO NOTHING`;
          made += inserted;
        }
        const ids = rows.map((r) => r.id);
        await tx.outboxEvent.updateMany({ where: { id: { in: ids } }, data: { processedAt: this.clock.now() } });
        return { taken: rows.length, created: made };
      });
      created += result.created;
      if (result.taken < BATCH) return created;
    }
  }
}
