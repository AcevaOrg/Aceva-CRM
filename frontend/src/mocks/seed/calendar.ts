/**
 * Company holiday calendar (Module 7, also used by Tasks and Payroll).
 * Pakistan public holidays; Eid dates move with the moon and are confirmed by management each year.
 */
export interface HolidaySeed {
  date: string;
  name: string;
}

export const HOLIDAYS: HolidaySeed[] = [
  { date: "2026-11-09", name: "Iqbal Day" },
  { date: "2026-12-25", name: "Quaid-e-Azam Day" },
  { date: "2027-02-05", name: "Kashmir Solidarity Day" },
  { date: "2027-03-10", name: "Eid ul-Fitr (expected)" },
  { date: "2027-03-11", name: "Eid ul-Fitr (expected)" },
  { date: "2027-03-23", name: "Pakistan Day" },
  { date: "2027-05-01", name: "Labour Day" },
  { date: "2027-05-17", name: "Eid ul-Adha (expected)" },
  { date: "2027-08-14", name: "Independence Day" },
];

export const HOLIDAY_DATES = HOLIDAYS.map((h) => h.date);
