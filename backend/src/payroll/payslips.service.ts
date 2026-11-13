import { Injectable } from '@nestjs/common';
import type { PayslipLineView, PayslipSummary, PayslipView } from '@aceva/contracts';
import type { Actor } from '../access/access.types';
import { AuditService } from '../access/audit.service';
import type { RequestInfo } from '../access/decorators';
import { PermissionService } from '../access/permission.service';
import { dec, money, sum } from '../common/money';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { grossOf } from './payroll-calc';
import { notFound, UUID_PATTERN } from './payroll-common';

const payslipInclude = {
  run: { select: { number: true } },
  line: true,
  employee: { select: { id: true, empId: true, fullName: true, designation: true, pay: { select: { bankName: true, bankAccountLast4: true } } } },
} as const;
type PayslipRow = Prisma.PayslipGetPayload<{ include: typeof payslipInclude }>;

/**
 * Payslips (plan section 12: "visible only to that employee and to finance and management"). A person always sees their own
 * (payroll.view_own); anyone else's needs payroll.view, is answered "not found" otherwise, and every such view is audited.
 * The document is printable HTML for now: no PDF library is approved yet (D15).
 */
@Injectable()
export class PayslipsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionService,
    private readonly audit: AuditService,
  ) {}

  async mine(actor: Actor): Promise<PayslipSummary[]> {
    return this.summaries(actor.id);
  }

  async mineFor(actor: Actor, month: string): Promise<PayslipView> {
    const slip = await this.prisma.payslip.findUnique({ where: { employeeId_month: { employeeId: actor.id, month } }, include: payslipInclude });
    if (!slip) notFound('Payslip not found');
    return this.view(slip);
  }

  /** Someone's payslips (payroll.view; the route answers 404 otherwise). Audited. */
  async forEmployee(actor: Actor, empId: string, client: RequestInfo): Promise<PayslipSummary[]> {
    const employee = await this.prisma.employee.findUnique({ where: { empId }, select: { id: true } });
    if (!employee) notFound('Employee not found');
    if (employee.id !== actor.id) await this.audit.record({ actorId: actor.id, action: 'payroll.payslip.viewed', targetType: 'employee', targetId: empId, details: { list: true }, ...client });
    return this.summaries(employee.id);
  }

  async byId(actor: Actor, id: string, client: RequestInfo): Promise<PayslipView> {
    return this.view(await this.readable(actor, id, client, 'view'));
  }

  async document(actor: Actor, id: string, client: RequestInfo): Promise<string> {
    return renderPayslip(await this.view(await this.readable(actor, id, client, 'document')));
  }

  /** Own payslip, or someone else's with payroll.view; "not found" otherwise (the same answer as a missing payslip). */
  private async readable(actor: Actor, id: string, client: RequestInfo, what: 'view' | 'document') {
    if (!UUID_PATTERN.test(id)) notFound('Payslip not found');
    const slip = await this.prisma.payslip.findUnique({ where: { id }, include: payslipInclude });
    if (!slip) notFound('Payslip not found');
    const access = await this.permissions.getEffectiveAccess(actor.id);
    if (slip.employeeId === actor.id) {
      if (!access.permissions.has('payroll.view_own')) notFound('Payslip not found');
      return slip;
    }
    if (!access.permissions.has('payroll.view')) {
      await this.audit.record({ actorId: actor.id, action: 'access.denied', targetType: 'payslip', targetId: id, outcome: 'denied', reason: 'missing_permission', details: { missing: 'payroll.view' }, ...client });
      notFound('Payslip not found');
    }
    await this.audit.record({ actorId: actor.id, action: 'payroll.payslip.viewed', targetType: 'employee', targetId: slip.employee.empId, details: { month: slip.month, what }, ...client });
    return slip;
  }

  private async summaries(employeeId: string): Promise<PayslipSummary[]> {
    const rows = await this.prisma.payslip.findMany({ where: { employeeId }, orderBy: { month: 'desc' }, include: { run: { select: { number: true } }, line: { select: { net: true } }, employee: { select: { empId: true } } } });
    return rows.map((r) => ({ id: r.id, empId: r.employee.empId, month: r.month, runNumber: r.run.number, net: money(r.line.net), issuedAt: r.issuedAt.toISOString() }));
  }

  private async view(slip: PayslipRow): Promise<PayslipView> {
    const l = slip.line;
    const items = await this.prisma.payrollItem.findMany({ where: { runId: slip.runId, employeeId: slip.employeeId }, orderBy: { createdAt: 'asc' } });
    const year = slip.month.slice(0, 4);
    const ytd = await this.prisma.payslip.findMany({ where: { employeeId: slip.employeeId, month: { gte: `${year}-01`, lte: slip.month } }, include: { line: { select: { net: true, tax: true } } } });
    const lines: PayslipLineView[] = [{ label: 'Basic salary', kind: 'earning', amount: money(l.baseSalary) }];
    if (dec(l.allowances).gt(0)) lines.push({ label: 'Allowances', kind: 'earning', amount: money(l.allowances) });
    for (const i of items.filter((x) => x.kind === 'bonus')) lines.push({ label: i.label, kind: 'earning', amount: money(i.amount) });
    if (dec(l.unpaidDeduction).gt(0)) lines.push({ label: `Unpaid leave (${dec(l.unpaidDays).toFixed(1)} days)`, kind: 'deduction', amount: money(l.unpaidDeduction) });
    if (dec(l.tax).gt(0)) lines.push({ label: 'Income tax', kind: 'deduction', amount: money(l.tax) });
    if (dec(l.advanceDeduction).gt(0)) lines.push({ label: 'Salary advance repayment', kind: 'deduction', amount: money(l.advanceDeduction) });
    for (const i of items.filter((x) => x.kind === 'deduction')) lines.push({ label: i.label, kind: 'deduction', amount: money(i.amount) });
    const earnings = dec(l.baseSalary).plus(dec(l.allowances)).plus(dec(l.bonus));
    const deductions = dec(l.unpaidDeduction).plus(dec(l.tax)).plus(dec(l.advanceDeduction)).plus(dec(l.otherDeductions));
    const last4 = slip.employee.pay?.bankAccountLast4;
    return {
      id: slip.id,
      empId: slip.employee.empId,
      month: slip.month,
      runNumber: slip.run.number,
      net: money(l.net),
      issuedAt: slip.issuedAt.toISOString(),
      name: slip.employee.fullName,
      designation: slip.employee.designation,
      lines,
      earnings: money(earnings),
      deductions: money(deductions),
      gross: money(grossOf(l)),
      tax: money(l.tax),
      ytdNet: money(sum(ytd.map((y) => y.line.net))),
      ytdTax: money(sum(ytd.map((y) => y.line.tax))),
      workingDays: l.workingDays,
      unpaidDays: dec(l.unpaidDays).toFixed(1),
      bankName: slip.employee.pay?.bankName ?? null,
      accountMasked: last4 ? `**** ${last4}` : null,
    };
  }

}

const escapeHtml = (v: string) => v.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const monthName = (month: string) => {
  const [y, m] = month.split('-').map(Number);
  return `${['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][m - 1]} ${y}`;
};

const pkr = (amount: string) => {
  const [whole, paisa] = amount.split('.');
  return `PKR ${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${paisa}`;
};

/** A printable payslip (the browser's "Print / Save as PDF" makes the PDF until a PDF library is approved, D15). */
export function renderPayslip(p: PayslipView): string {
  const rows = (kind: 'earning' | 'deduction') =>
    p.lines
      .filter((l) => l.kind === kind)
      .map((l) => `<tr><td>${escapeHtml(l.label)}</td><td class="n">${pkr(l.amount)}</td></tr>`)
      .join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Payslip ${escapeHtml(p.empId)} ${escapeHtml(p.month)}</title>
<style>
body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color:#1d2433;margin:32px;max-width:760px}
h1{font-size:20px;margin:0 0 4px}.muted{color:#5b6577;font-size:13px}.seal{float:right;border:1px solid #b42318;color:#b42318;padding:2px 8px;font-size:11px;letter-spacing:.08em;text-transform:uppercase}
table{width:100%;border-collapse:collapse;margin-top:16px;font-size:14px}td,th{padding:6px 4px;border-bottom:1px solid #e4e7ec;text-align:left}.n{text-align:right;font-variant-numeric:tabular-nums}
.net td{font-weight:700;font-size:16px;border-top:2px solid #1d2433}@media print{body{margin:12mm}}
</style></head><body>
<span class="seal">Confidential</span>
<h1>Payslip, ${escapeHtml(monthName(p.month))}</h1>
<p class="muted">Aceva Digital · ${escapeHtml(p.runNumber)} · issued ${escapeHtml(p.issuedAt.slice(0, 10))}</p>
<p><strong>${escapeHtml(p.name)}</strong> (${escapeHtml(p.empId)}) · ${escapeHtml(p.designation)}<br>
<span class="muted">${p.workingDays} working days · ${escapeHtml(p.unpaidDays)} unpaid leave days${p.bankName ? ` · ${escapeHtml(p.bankName)}` : ''}${p.accountMasked ? ` ${escapeHtml(p.accountMasked)}` : ''}</span></p>
<table><thead><tr><th>Earnings</th><th class="n">Amount</th></tr></thead><tbody>${rows('earning')}<tr><td><strong>Total earnings</strong></td><td class="n"><strong>${pkr(p.earnings)}</strong></td></tr></tbody></table>
<table><thead><tr><th>Deductions</th><th class="n">Amount</th></tr></thead><tbody>${rows('deduction')}<tr><td><strong>Total deductions</strong></td><td class="n"><strong>${pkr(p.deductions)}</strong></td></tr></tbody></table>
<table><tbody><tr class="net"><td>Net pay</td><td class="n">${pkr(p.net)}</td></tr>
<tr><td class="muted">Net pay this year to date</td><td class="n muted">${pkr(p.ytdNet)}</td></tr>
<tr><td class="muted">Income tax this year to date</td><td class="n muted">${pkr(p.ytdTax)}</td></tr></tbody></table>
<p class="muted">Net pay = base + allowances + bonus − unpaid leave − tax − other deductions.</p>
</body></html>`;
}
