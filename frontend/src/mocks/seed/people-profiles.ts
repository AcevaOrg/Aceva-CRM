/** Seed: personal details, pay, documents and change history (Module 3). */
import type { DocumentKind, EmployeeDocument, FieldChange, PayDetails, PersonalDetails } from "@/features/people/types";
import { money } from "@/lib/format";
import { EMPLOYEES, PAY, PERSONAL } from "./people";
import { daysFromNow, minutesAgo } from "../time";

export function seedPersonal(): (PersonalDetails & { empId: string })[] {
  return Object.entries(PERSONAL).map(([empId, p]) => ({ empId, cnic: p.cnic, phone: p.phone, address: p.address, emergencyContact: p.emergency }));
}

export function seedPay(): (PayDetails & { empId: string })[] {
  return Object.entries(PAY).map(([empId, p]) => ({
    empId,
    baseSalary: money(p.base),
    allowances: p.allowances.map((a) => ({ name: a.name, amount: money(a.amount) })),
    bankName: p.bank,
    accountNumber: p.account,
  }));
}

const DOCS: [DocumentKind, string, number][] = [
  ["cv", "CV.pdf", 248_000],
  ["contract", "Employment contract (signed).pdf", 412_000],
  ["cnic", "CNIC front and back.jpg", 1_240_000],
  ["certificate", "BS Computer Science degree.pdf", 690_000],
];

export function seedDocuments(): EmployeeDocument[] {
  return EMPLOYEES.flatMap((e, i) =>
    DOCS.slice(0, e.role === "ceo" ? 2 : i % 2 === 0 ? 4 : 3).map(([kind, fileName, sizeBytes], j) => ({
      id: `doc_${e.empId}_${j}`,
      empId: e.empId,
      kind,
      fileName: kind === "cv" ? `${e.name.replace(/\s/g, "_")}_CV.pdf` : fileName,
      sizeBytes,
      uploadedAt: new Date(new Date(e.joiningDate).getTime() + j * 86_400_000).toISOString(),
      // HR duty (the Director) files documents; the CEO / Founder / Owner files nothing, so the Director files their own.
      uploadedBy: kind === "cv" ? e.empId : "ACV-0003",
    })),
  );
}

export function seedHistory(): FieldChange[] {
  return [
    { id: "fc_1", empId: "ACV-0007", section: "job", field: "Designation", oldValue: "Junior Developer", newValue: "Software Developer", changedBy: "ACV-0003", changedAt: daysFromNow(-120, "11:10"), reason: "Promotion after probation review" },
    { id: "fc_2", empId: "ACV-0007", section: "personal", field: "Phone", oldValue: "+92 300 5550101", newValue: "+92 300 1104729", changedBy: "ACV-0007", changedAt: daysFromNow(-40, "19:02") },
    { id: "fc_3", empId: "ACV-0007", section: "pay", field: "Base salary", oldValue: "PKR 160,000", newValue: "PKR 180,000", changedBy: "ACV-0003", changedAt: daysFromNow(-120, "11:30"), reason: "Promotion" },
    { id: "fc_4", empId: "ACV-0013", section: "job", field: "Reports to", oldValue: "Fahad Khan", newValue: "Omar Farooq", changedBy: "ACV-0003", changedAt: daysFromNow(-12, "10:00"), reason: "Every engineer reports to the CTO" },
    { id: "fc_5", empId: "ACV-0013", section: "job", field: "Weekly capacity", oldValue: "40 h", newValue: "20 h", changedBy: "ACV-0003", changedAt: daysFromNow(-60, "09:40"), reason: "Part-time internship" },
    { id: "fc_6", empId: "ACV-0009", section: "personal", field: "Address", oldValue: "House 3, Saddar, Hyderabad", newValue: "Flat 4, Clifton Block 5, Karachi", changedBy: "ACV-0009", changedAt: daysFromNow(-25, "21:15") },
    { id: "fc_7", empId: "ACV-0008", section: "basic", field: "Office", oldValue: "Karachi Studio", newValue: "Remote", changedBy: "ACV-0003", changedAt: daysFromNow(-70, "12:00"), reason: "Moved to Lahore, works remotely" },
    { id: "fc_8", empId: "ACV-0010", section: "pay", field: "Allowances", oldValue: "None", newValue: "Transport PKR 10,000", changedBy: "ACV-0003", changedAt: daysFromNow(-90, "10:20"), reason: "Transport allowance for Dadu HQ" },
    { id: "fc_10", empId: "ACV-0010", section: "personal", field: "Phone", oldValue: "+92 301 4410022", newValue: "+92 326 1628374", changedBy: "ACV-0010", changedAt: daysFromNow(-33, "18:40") },
    { id: "fc_9", empId: "ACV-0012", section: "job", field: "Status", oldValue: "Probation", newValue: "Active", changedBy: "ACV-0003", changedAt: minutesAgo(60 * 24 * 30), reason: "Probation completed" },
  ];
}
