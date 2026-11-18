import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { OutboxEvent } from '@aceva/contracts';
import { OutboxConsumerRunner } from '../events/outbox-consumer-runner.service';
import { Prisma } from '../generated/prisma/client';
import { NotificationService, type NewNotification } from './notification.service';

/** The reader's name in outbox_consumers. Never rename it (a new name would start reading from "now" again). */
export const NOTIFICATIONS_CONSUMER = 'notifications';

type Tx = Prisma.TransactionClient;
type Person = { id: string; empId: string; fullName: string };

/**
 * Turns the events Modules 7, 8 and 9 already write into notifications (plan section 17: "leave asked or answered,
 * approval waiting, payroll ready, payslip available, security alert"). Nobody is notified about their own action.
 * Each notification's dedupe key is "<event id>:<type>", so a retried event never notifies anyone twice.
 * New modules add their events here (or in their own reader) when they are built.
 */
@Injectable()
export class NotificationEventsConsumer implements OnModuleInit {
  constructor(
    private readonly runner: OutboxConsumerRunner,
    private readonly notifications: NotificationService,
  ) {}

  onModuleInit(): void {
    this.runner.register({
      name: NOTIFICATIONS_CONSUMER,
      types: ['leave.requested', 'leave.decided', 'attendance.correction.decided', 'payroll.run.ready', 'payslip.issued', 'finance.period.reopened'],
      handle: (event, tx) => this.handle(event, tx),
    });
  }

  async handle(event: OutboxEvent, tx: Tx): Promise<void> {
    // Nobody is told about their own action, except a payslip (the person who approved payroll still gets theirs).
    const notify = (to: Person | null, n: Omit<NewNotification, 'recipientId' | 'dedupeKey' | 'sourceEventId'>, ownAction = false) =>
      to && (ownAction || to.empId !== event.actor) ? this.notifications.create(tx, { ...n, recipientId: to.id, dedupeKey: `${event.id}:${n.type}`, sourceEventId: event.id }) : Promise.resolve(false);

    switch (event.type) {
      case 'leave.requested': {
        const p = event.payload;
        if (!p.approverEmpId || p.approverEmpId === p.empId) return;
        const who = await this.person(tx, p.empId);
        await notify(await this.person(tx, p.approverEmpId), {
          type: 'leave_requested',
          title: 'A leave request is waiting for your approval',
          body: `${this.label(who, p.empId)} asked for leave from ${p.from} to ${p.to} (${p.requestNumber}).`,
          link: '/approvals',
        });
        return;
      }
      case 'leave.decided': {
        const p = event.payload;
        if (p.decision === 'forwarded') {
          if (!p.nextApproverEmpId) return;
          const who = await this.person(tx, p.empId);
          await notify(await this.person(tx, p.nextApproverEmpId), {
            type: 'leave_requested',
            title: 'A leave request is waiting for your approval',
            body: `${this.label(who, p.empId)}: ${p.requestNumber}.`,
            link: '/approvals',
          });
          return;
        }
        if (p.decision === 'cancelled') return;
        await notify(await this.person(tx, p.empId), {
          type: 'leave_answered',
          title: `Your leave request ${p.requestNumber} was ${p.decision}`,
          body: null,
          link: '/leave',
        });
        return;
      }
      case 'attendance.correction.decided': {
        const p = event.payload;
        await notify(await this.person(tx, p.empId), {
          type: 'correction_answered',
          title: `Your attendance correction for ${p.date} was ${p.decision}`,
          body: null,
          link: '/attendance',
        });
        return;
      }
      case 'payroll.run.ready': {
        const p = event.payload;
        for (const approver of await this.holders(tx, 'payroll.approve')) {
          await notify(approver, {
            type: 'payroll_ready',
            title: `${p.runNumber} payroll is ready for your approval`,
            body: `Payroll for ${p.month} was prepared and waits for approval.`,
            link: `/payroll/runs/${p.runNumber}`,
          });
        }
        return;
      }
      case 'payslip.issued': {
        const p = event.payload;
        await notify(await this.person(tx, p.empId), { type: 'payslip_available', title: `Your payslip for ${p.month} is available`, body: null, link: '/payroll/payslips' }, true);
        return;
      }
      case 'finance.period.reopened': {
        const p = event.payload;
        const by = await this.person(tx, p.byEmpId);
        for (const person of await this.withRoles(tx, ['owner', 'ceo', 'director'])) {
          await notify(person, {
            type: 'security_alert',
            title: `Finance month ${p.month} was reopened`,
            body: `Reopened by ${this.label(by, p.byEmpId)}. Reason: ${p.reason}`,
            link: '/finance/close',
          });
        }
        return;
      }
      default:
        return;
    }
  }

  private label(p: Person | null, empId: string): string {
    return p ? `${p.fullName} (${p.empId})` : empId;
  }

  private person(tx: Tx, empId: string): Promise<Person | null> {
    return tx.employee.findFirst({ where: { empId, status: { not: 'left' } }, select: { id: true, empId: true, fullName: true } });
  }

  /** Everyone (not left) who holds a permission through their role or a current duty. */
  private holders(tx: Tx, permission: string): Promise<Person[]> {
    return tx.$queryRaw<Person[]>`
      SELECT DISTINCT e.id, e.emp_id AS "empId", e.full_name AS "fullName"
      FROM employees e
      WHERE e.status <> 'left' AND (
        EXISTS (SELECT 1 FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id WHERE rp.role_id = e.role_id AND p.key = ${permission})
        OR EXISTS (SELECT 1 FROM employee_duties ed JOIN duty_permissions dp ON dp.duty_id = ed.duty_id JOIN permissions p ON p.id = dp.permission_id
                   WHERE ed.employee_id = e.id AND ed.ended_at IS NULL AND p.key = ${permission}))
      ORDER BY "empId"`;
  }

  private withRoles(tx: Tx, roles: string[]): Promise<Person[]> {
    return tx.employee.findMany({ where: { status: { not: 'left' }, role: { key: { in: roles } } }, select: { id: true, empId: true, fullName: true }, orderBy: { empId: 'asc' } });
  }
}
