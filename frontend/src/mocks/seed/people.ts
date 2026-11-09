/**
 * Seed: people, departments, offices (Module 3) and the demo personas (spec §2.2).
 * Every other module's seed refers to these Emp-IDs.
 */
import type { Department, Employee, Office } from "@/types";
import { daysFromNow } from "../time";

export const OFFICES: Office[] = [
  { id: "off-dadu", name: "Dadu HQ", city: "Dadu" },
  { id: "off-khi", name: "Karachi Studio", city: "Karachi" },
  { id: "off-remote", name: "Remote", city: "Remote" },
];

export const DEPARTMENTS: Department[] = [
  { id: "dep-mgmt", name: "Management", headEmpId: "ACV-0001", color: "var(--level-1)", officeIds: ["off-dadu"] },
  { id: "dep-eng", name: "Engineering", headEmpId: "ACV-0004", color: "var(--zone-work)", officeIds: ["off-dadu", "off-khi", "off-remote"] },
  { id: "dep-sales", name: "Sales", headEmpId: "ACV-0014", color: "var(--zone-sales)", officeIds: ["off-khi", "off-remote"] },
  { id: "dep-fin", name: "Finance and Accounts", headEmpId: "ACV-0003", color: "var(--zone-finance)", officeIds: ["off-dadu"] },
  { id: "dep-hr", name: "Human Resources", headEmpId: "ACV-0005", color: "var(--zone-control)", officeIds: ["off-dadu"] },
];

type Seed = Omit<Employee, "id" | "officialEmail" | "status" | "weeklyCapacityHours" | "type"> &
  Partial<Pick<Employee, "status" | "weeklyCapacityHours" | "type">> & { email: string };

const RAW: Seed[] = [
  { empId: "ACV-0001", name: "Hamza Qureshi", designation: "Founder and Owner", departmentId: "dep-mgmt", officeId: "off-dadu", email: "hamza", level: 1, role: "owner", duties: [], reportsTo: null, joiningDate: daysFromNow(-1460), avatarHue: 85 },
  { empId: "ACV-0002", name: "Ayesha Siddiqui", designation: "Chief Executive Officer", departmentId: "dep-mgmt", officeId: "off-dadu", email: "ayesha", level: 2, role: "ceo", duties: [], reportsTo: "ACV-0001", joiningDate: daysFromNow(-1300), avatarHue: 300 },
  { empId: "ACV-0003", name: "Bilal Ahmed", designation: "Director", departmentId: "dep-fin", officeId: "off-dadu", email: "bilal", level: 3, role: "director", duties: ["sales_manager"], reportsTo: "ACV-0002", joiningDate: daysFromNow(-1100), avatarHue: 264 },
  { empId: "ACV-0004", name: "Omar Farooq", designation: "Chief Technology Officer", departmentId: "dep-eng", officeId: "off-dadu", email: "omar", level: 3, role: "cto", duties: [], reportsTo: "ACV-0002", joiningDate: daysFromNow(-1050), avatarHue: 220 },
  { empId: "ACV-0005", name: "Zainab Hussain", designation: "HR Lead", departmentId: "dep-hr", officeId: "off-dadu", email: "zainab", level: 4, role: "hr_lead", duties: ["hr"], reportsTo: "ACV-0003", joiningDate: daysFromNow(-800), avatarHue: 330 },
  { empId: "ACV-0006", name: "Fahad Khan", designation: "Engineering Team Lead", departmentId: "dep-eng", officeId: "off-khi", email: "fahad", level: 4, role: "team_lead", duties: [], reportsTo: "ACV-0004", joiningDate: daysFromNow(-760), avatarHue: 180 },
  { empId: "ACV-0007", name: "Mariam Shah", designation: "Software Developer", departmentId: "dep-eng", officeId: "off-khi", email: "mariam", level: 5, role: "employee", duties: [], reportsTo: "ACV-0006", joiningDate: daysFromNow(-420), avatarHue: 150 },
  { empId: "ACV-0008", name: "Ali Raza", designation: "Software Developer", departmentId: "dep-eng", officeId: "off-remote", email: "ali", level: 5, role: "employee", duties: [], reportsTo: "ACV-0006", joiningDate: daysFromNow(-380), avatarHue: 30 },
  { empId: "ACV-0009", name: "Hira Baig", designation: "Sales Executive", departmentId: "dep-sales", officeId: "off-khi", email: "hira", level: 5, role: "sales_exec", duties: [], reportsTo: "ACV-0014", joiningDate: daysFromNow(-300), avatarHue: 52 },
  { empId: "ACV-0010", name: "Sana Malik", designation: "Accounts Officer", departmentId: "dep-fin", officeId: "off-dadu", email: "sana", level: 5, role: "employee", duties: ["finance"], reportsTo: "ACV-0003", joiningDate: daysFromNow(-640), avatarHue: 292 },
  { empId: "ACV-0011", name: "Danish Iqbal", designation: "UI Designer", departmentId: "dep-eng", officeId: "off-khi", email: "danish", level: 5, role: "employee", duties: [], reportsTo: "ACV-0006", joiningDate: daysFromNow(-260), avatarHue: 200 },
  { empId: "ACV-0012", name: "Kamran Javed", designation: "Sales Executive", departmentId: "dep-sales", officeId: "off-remote", email: "kamran", level: 5, role: "sales_exec", duties: [], reportsTo: "ACV-0014", joiningDate: daysFromNow(-150), avatarHue: 15 },
  { empId: "ACV-0013", name: "Nida Aslam", designation: "Software Intern", departmentId: "dep-eng", officeId: "off-dadu", email: "nida", level: 5, role: "employee", duties: [], reportsTo: "ACV-0006", joiningDate: daysFromNow(-60), avatarHue: 120, type: "intern", weeklyCapacityHours: 20 },
  { empId: "ACV-0014", name: "Saad Mirza", designation: "Sales Team Lead", departmentId: "dep-sales", officeId: "off-khi", email: "saad", level: 4, role: "sales_lead", duties: ["sales_manager"], reportsTo: "ACV-0003", joiningDate: daysFromNow(-500), avatarHue: 40 },
];

export function seedEmployees(): Employee[] {
  return RAW.map(({ email, ...e }) => ({
    ...e,
    id: `emp_${e.empId.slice(-4)}`,
    officialEmail: `${email}@acevatech.com`,
    status: e.status ?? "active",
    type: e.type ?? "full_time",
    weeklyCapacityHours: e.weeklyCapacityHours ?? 40,
  }));
}

/** Static copy for synchronous lookups (personas, scope). */
export const EMPLOYEES: Employee[] = seedEmployees();

/** Monthly pay (PKR) used by Payroll and the profile Pay tab. Highly confidential. */
export const PAY: Record<string, { base: number; allowances: { name: string; amount: number }[]; bank: string; account: string }> = {
  "ACV-0002": { base: 650000, allowances: [{ name: "Car", amount: 60000 }], bank: "Meezan Bank", account: "0101-0045872214" },
  "ACV-0003": { base: 450000, allowances: [{ name: "Car", amount: 40000 }], bank: "HBL", account: "1234-7865540921" },
  "ACV-0004": { base: 480000, allowances: [{ name: "Internet", amount: 10000 }], bank: "Meezan Bank", account: "0101-0045879931" },
  "ACV-0005": { base: 220000, allowances: [{ name: "Transport", amount: 15000 }], bank: "UBL", account: "2201-3345120098" },
  "ACV-0006": { base: 300000, allowances: [{ name: "Internet", amount: 8000 }], bank: "Bank Alfalah", account: "5501-9987123344" },
  "ACV-0007": { base: 180000, allowances: [{ name: "Internet", amount: 5000 }], bank: "Meezan Bank", account: "0101-0045811187" },
  "ACV-0008": { base: 160000, allowances: [{ name: "Internet", amount: 5000 }], bank: "HBL", account: "1234-1122334455" },
  "ACV-0009": { base: 120000, allowances: [{ name: "Transport", amount: 10000 }], bank: "MCB", account: "0987-6543210012" },
  "ACV-0010": { base: 140000, allowances: [{ name: "Transport", amount: 10000 }], bank: "Meezan Bank", account: "0101-0045833321" },
  "ACV-0011": { base: 150000, allowances: [{ name: "Internet", amount: 5000 }], bank: "UBL", account: "2201-7788990011" },
  "ACV-0012": { base: 110000, allowances: [{ name: "Transport", amount: 10000 }], bank: "Bank Alfalah", account: "5501-1239874560" },
  "ACV-0013": { base: 40000, allowances: [], bank: "Easypaisa Bank", account: "0345-1112223334" },
  "ACV-0014": { base: 230000, allowances: [{ name: "Transport", amount: 15000 }], bank: "HBL", account: "1234-5566778899" },
};

export const PERSONAL: Record<string, { cnic: string; phone: string; address: string; emergency: { name: string; relation: string; phone: string } }> =
  Object.fromEntries(
    EMPLOYEES.map((e, i) => [
      e.empId,
      {
        cnic: `4${(i % 3) + 1}10${i}-${String(1234567 + i * 7919).slice(0, 7)}-${(i % 9) + 1}`,
        phone: `+92 3${(i % 4) + 0}${i % 10} ${String(1000000 + i * 104729).slice(0, 7)}`,
        address: ["House 12, Block B, Dadu", "Flat 4, Clifton Block 5, Karachi", "Street 7, Latifabad, Hyderabad", "House 88, Gulshan-e-Iqbal, Karachi"][i % 4],
        emergency: { name: ["Imran", "Fatima", "Kashif", "Rabia"][i % 4] + " " + e.name.split(" ")[1], relation: ["Father", "Mother", "Brother", "Spouse"][i % 4], phone: `+92 30${i % 10} ${String(2000000 + i * 3571).slice(0, 7)}` },
      },
    ]),
  );
