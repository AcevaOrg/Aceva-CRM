import type { PrismaClient } from '../src/generated/prisma/client';

type Tx = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];

/**
 * Demo reference data for Module 5 (the same lists the demo screens use). Projects and clients are only a read-only list
 * until their own module exists. The holidays are the company calendar tasks skip when they suggest a deadline; the real
 * calendar is edited by the Director later. No personal data. Safe to run again (projects are upserted; a holiday is
 * added only when no active holiday is on that date, and an active one gets the demo name).
 */
export const DEMO_PROJECTS: Array<{ code: string; name: string; client: string }> = [
  { code: 'prj-ads', name: 'Aceva Digital System', client: 'Internal' },
  { code: 'prj-northwind', name: 'Northwind Studio website', client: 'Northwind Studio' },
  { code: 'prj-brightpath', name: 'Bright Path Academy LMS', client: 'Bright Path Academy' },
  { code: 'prj-harbor', name: 'Harbor & Co e-commerce', client: 'Harbor & Co' },
  { code: 'prj-ops', name: 'Operations', client: 'Internal' },
];

export const DEMO_HOLIDAYS: Array<{ date: string; name: string }> = [
  { date: '2026-11-09', name: 'Iqbal Day' },
  { date: '2026-12-25', name: 'Quaid-e-Azam Day' },
  { date: '2027-02-05', name: 'Kashmir Solidarity Day' },
  { date: '2027-03-10', name: 'Eid ul-Fitr (expected)' },
  { date: '2027-03-11', name: 'Eid ul-Fitr (expected)' },
  { date: '2027-03-23', name: 'Pakistan Day' },
  { date: '2027-05-01', name: 'Labour Day' },
  { date: '2027-05-17', name: 'Eid ul-Adha (expected)' },
  { date: '2027-08-14', name: 'Independence Day' },
];

export async function seedTaskReferenceData(tx: Tx): Promise<void> {
  for (const p of DEMO_PROJECTS) {
    await tx.project.upsert({ where: { code: p.code }, update: { name: p.name, client: p.client }, create: p });
  }
  for (const h of DEMO_HOLIDAYS) {
    const date = new Date(`${h.date}T00:00:00.000Z`);
    // The date is unique only among the active rows (an archived holiday may share it), so there is no upsert by date.
    const active = await tx.holiday.findFirst({ where: { date, archivedAt: null }, select: { id: true } });
    if (active) await tx.holiday.update({ where: { id: active.id }, data: { name: h.name } });
    else await tx.holiday.create({ data: { date, name: h.name } });
  }
}
