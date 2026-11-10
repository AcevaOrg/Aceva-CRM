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

/**
 * Aceva structure (development plan §5): L1 Owner → L2 CEO → L3 Director → L3 CTO (same-level line) and L4 Sales, Finance, HR
 * → L5 Development (under the CTO). Owner and CEO oversee; the Director approves and holds HR duty; the finance person
 * holds finance duty; a demo HR officer holds HR duty; the CTO heads Development.
 */
export const DEPARTMENTS: Department[] = [
  { id: "dep-mgmt", name: "Management", headEmpId: "ACV-0001", color: "var(--level-1)", officeIds: ["off-dadu"] },
  { id: "dep-eng", name: "Software Development", headEmpId: "ACV-0004", color: "var(--zone-work)", officeIds: ["off-dadu", "off-khi", "off-remote"] },
  { id: "dep-sales", name: "Sales", headEmpId: "ACV-0003", color: "var(--zone-sales)", officeIds: ["off-khi", "off-remote"] },
  { id: "dep-fin", name: "Finance", headEmpId: "ACV-0003", color: "var(--zone-finance)", officeIds: ["off-dadu"] },
  { id: "dep-hr", name: "Human Resources", headEmpId: "ACV-0003", color: "var(--chart-4)", officeIds: ["off-dadu"] },
];

type Seed = Omit<Employee, "id" | "officialEmail" | "status" | "weeklyCapacityHours" | "type"> &
  Partial<Pick<Employee, "status" | "weeklyCapacityHours" | "type">> & { email: string };

/* Emp-IDs are never reused (plan §6), so the roster keeps its original numbers; 0005 is not used. 0002 (CEO) and 0015 (demo HR) are the additions. */
const RAW: Seed[] = [
  // L1 Owner: sees everything, approves nothing
  { empId: "ACV-0001", name: "Hamza Qureshi", designation: "Owner and Founder", departmentId: "dep-mgmt", officeId: "off-dadu", email: "hamza", level: 1, role: "owner", duties: [], reportsTo: null, joiningDate: daysFromNow(-1460), avatarHue: 85 },
  // L2 CEO: a different person from the Owner
  { empId: "ACV-0002", name: "Ayesha Siddiqui", designation: "Chief Executive Officer", departmentId: "dep-mgmt", officeId: "off-dadu", email: "ayesha", level: 2, role: "ceo", duties: [], reportsTo: "ACV-0001", joiningDate: daysFromNow(-1300), avatarHue: 330 },
  // L3 Director: the approver for the whole company; also HR duty and sales manager
  { empId: "ACV-0003", name: "Bilal Ahmed", designation: "Director", departmentId: "dep-mgmt", officeId: "off-dadu", email: "bilal", level: 3, role: "director", duties: ["hr", "sales_manager"], reportsTo: "ACV-0002", joiningDate: daysFromNow(-1100), avatarHue: 264 },
  // L3 CTO (reports to the Director: the one documented same-level line)
  { empId: "ACV-0004", name: "Omar Farooq", designation: "Chief Technology Officer", departmentId: "dep-eng", officeId: "off-dadu", email: "omar", level: 3, role: "cto", duties: [], reportsTo: "ACV-0003", joiningDate: daysFromNow(-1050), avatarHue: 220 },
  // L4 demo HR officer (HR duty): clearly labelled demo person
  { empId: "ACV-0015", name: "Rabia Anwar (DEMO HR)", designation: "HR Officer", departmentId: "dep-hr", officeId: "off-dadu", email: "rabia", level: 4, role: "lead", duties: ["hr"], reportsTo: "ACV-0003", joiningDate: daysFromNow(-200), avatarHue: 10 },
  // L4 Sales (report to the Director)
  { empId: "ACV-0009", name: "Hira Baig", designation: "Sales Executive", departmentId: "dep-sales", officeId: "off-khi", email: "hira", level: 4, role: "sales", duties: [], reportsTo: "ACV-0003", joiningDate: daysFromNow(-300), avatarHue: 52 },
  { empId: "ACV-0012", name: "Kamran Javed", designation: "Sales Executive", departmentId: "dep-sales", officeId: "off-remote", email: "kamran", level: 4, role: "sales", duties: [], reportsTo: "ACV-0003", joiningDate: daysFromNow(-150), avatarHue: 15 },
  { empId: "ACV-0014", name: "Saad Mirza", designation: "Senior Sales Executive", departmentId: "dep-sales", officeId: "off-khi", email: "saad", level: 4, role: "sales", duties: [], reportsTo: "ACV-0003", joiningDate: daysFromNow(-500), avatarHue: 40 },
  // L4 Finance (reports to the Director): prepares entries, payroll, bills and the month close
  { empId: "ACV-0010", name: "Sana Malik", designation: "Finance Officer", departmentId: "dep-fin", officeId: "off-dadu", email: "sana", level: 4, role: "finance", duties: ["finance"], reportsTo: "ACV-0003", joiningDate: daysFromNow(-640), avatarHue: 292 },
  // L5 Software Development (report to the CTO)
  { empId: "ACV-0006", name: "Fahad Khan", designation: "Senior Backend Developer", departmentId: "dep-eng", officeId: "off-khi", email: "fahad", level: 5, role: "developer", duties: [], reportsTo: "ACV-0004", joiningDate: daysFromNow(-760), avatarHue: 180 },
  { empId: "ACV-0007", name: "Mariam Shah", designation: "Software Developer", departmentId: "dep-eng", officeId: "off-khi", email: "mariam", level: 5, role: "developer", duties: [], reportsTo: "ACV-0004", joiningDate: daysFromNow(-420), avatarHue: 150 },
  { empId: "ACV-0008", name: "Ali Raza", designation: "Backend Developer", departmentId: "dep-eng", officeId: "off-remote", email: "ali", level: 5, role: "developer", duties: [], reportsTo: "ACV-0004", joiningDate: daysFromNow(-380), avatarHue: 30 },
  { empId: "ACV-0011", name: "Danish Iqbal", designation: "SQA Engineer", departmentId: "dep-eng", officeId: "off-khi", email: "danish", level: 5, role: "developer", duties: [], reportsTo: "ACV-0004", joiningDate: daysFromNow(-260), avatarHue: 200 },
  { empId: "ACV-0013", name: "Nida Aslam", designation: "SQA Intern", departmentId: "dep-eng", officeId: "off-dadu", email: "nida", level: 5, role: "developer", duties: [], reportsTo: "ACV-0004", joiningDate: daysFromNow(-60), avatarHue: 120, type: "intern", weeklyCapacityHours: 20 },
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
  "ACV-0002": { base: 550000, allowances: [{ name: "Car", amount: 50000 }], bank: "Meezan Bank", account: "0101-0045870002" },
  "ACV-0015": { base: 130000, allowances: [{ name: "Transport", amount: 8000 }], bank: "HBL", account: "1234-0000150015" },
  "ACV-0001": { base: 650000, allowances: [{ name: "Car", amount: 60000 }], bank: "Meezan Bank", account: "0101-0045872214" },
  "ACV-0003": { base: 450000, allowances: [{ name: "Car", amount: 40000 }], bank: "HBL", account: "1234-7865540921" },
  "ACV-0004": { base: 480000, allowances: [{ name: "Internet", amount: 10000 }], bank: "Meezan Bank", account: "0101-0045879931" },
  "ACV-0006": { base: 300000, allowances: [{ name: "Internet", amount: 8000 }], bank: "Bank Alfalah", account: "5501-9987123344" },
  "ACV-0007": { base: 180000, allowances: [{ name: "Internet", amount: 5000 }], bank: "Meezan Bank", account: "0101-0045811187" },
  "ACV-0008": { base: 160000, allowances: [{ name: "Internet", amount: 5000 }], bank: "HBL", account: "1234-1122334455" },
  "ACV-0010": { base: 140000, allowances: [{ name: "Transport", amount: 10000 }], bank: "Meezan Bank", account: "0101-0045833321" },
  "ACV-0009": { base: 120000, allowances: [{ name: "Transport", amount: 10000 }], bank: "MCB", account: "0987-6543210012" },
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
