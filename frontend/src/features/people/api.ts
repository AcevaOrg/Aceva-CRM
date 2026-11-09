/**
 * Module 3 service functions. Mock today; each JSDoc names the real endpoint (spec §7.3).
 * Employee records live in the shared directory table (employeesTable).
 */
import { recordActivity, sessionsFor } from "@/features/activity/api";
import { tasksTable } from "@/features/tasks/api";
import { isOpen } from "@/features/tasks/logic";
import { ApiError, mock, notFound } from "@/lib/api/mock";
import { descendantsOf } from "@/lib/auth/scope";
import { getViewer } from "@/lib/auth/viewer";
import { departmentsTable, employeeName, employeesTable, officesTable } from "@/lib/directory";
import { formatMoney, maskTail, money } from "@/lib/format";
import { formatDate } from "@/lib/dates";
import { uid } from "@/lib/utils";
import { table } from "@/mocks/db";
import { seedDocuments, seedHistory, seedPay, seedPersonal } from "@/mocks/seed/people-profiles";
import type { Employee } from "@/types";
import { capacityFor, nextEmpId, profileAccess, TYPE_LABEL } from "./logic";
import type {
  BasicPatch, DocumentKind, EmployeeDocument, FieldChange, JobPatch, OffboardInput, OffboardPreview, OnboardingInput, PayDetails,
  PayPatch, PersonalDetails, PersonalPatch, ProfileSection, ProfileView,
} from "./types";

const personalTable = () => table<PersonalDetails & { empId: string }>("people.personal", seedPersonal);
const payTable = () => table<PayDetails & { empId: string }>("people.pay", seedPay);
const documentsTable = () => table<EmployeeDocument>("people.documents", seedDocuments);
const historyTable = () => table<FieldChange>("people.history", seedHistory);

function findEmp(empId: string) {
  const e = employeesTable().find((x) => x.empId === empId);
  if (!e) notFound("Employee");
  return e;
}

function accessFor(target: Employee) {
  const v = getViewer();
  const isAbove = descendantsOf(v.employee.empId, employeesTable()).includes(target.empId);
  return { viewer: v, access: profileAccess(v, target, isAbove) };
}

function logField(empId: string, section: ProfileSection, field: string, oldValue: string, newValue: string, reason?: string) {
  if (oldValue === newValue) return;
  historyTable().unshift({ id: uid("fc"), empId, section, field, oldValue, newValue, changedBy: getViewer().employee.empId, changedAt: new Date().toISOString(), reason });
}

const deptName = (id: string) => departmentsTable().find((d) => d.id === id)?.name ?? id;
const officeName = (id: string) => officesTable().find((o) => o.id === id)?.name ?? id;

export const peopleApi = {
  /** GET /employees (directory fields only) */
  list: () => mock(() => employeesTable()),

  /** GET /employees/presence — who is signed in right now (shown as a dot; never a metric) */
  presence: () => mock(() => sessionsFor().map((s) => ({ empId: s.empId, state: s.state })), { delay: 80 }),

  /** GET /employees/:empId (sections the viewer may see) */
  profile: (empId: string) =>
    mock<ProfileView>(() => {
      const employee = findEmp(empId);
      const { access } = accessFor(employee);
      const personal = personalTable().find((p) => p.empId === empId);
      const pay = payTable().find((p) => p.empId === empId);
      return {
        employee,
        access,
        personal: access.see.personal && personal ? personal : undefined,
        pay: access.see.pay && pay ? pay : undefined,
        documents: access.see.documents ? documentsTable().filter((d) => d.empId === empId) : undefined,
        history: access.see.history
          ? historyTable()
              .filter((h) => h.empId === empId)
              .filter((h) => (h.section === "pay" ? access.see.pay : h.section === "personal" ? access.see.personal : true))
          : undefined,
      };
    }),

  /** PATCH /employees/:empId/basic */
  updateBasic: (empId: string, patch: BasicPatch, reason?: string) =>
    mock(() => {
      const e = findEmp(empId);
      if (!accessFor(e).access.edit.basic) throw new ApiError("forbidden", "Only HR or the Director can change these fields.", 403);
      if (patch.name !== undefined) logField(empId, "basic", "Name", e.name, patch.name, reason);
      if (patch.designation !== undefined) logField(empId, "basic", "Designation", e.designation, patch.designation, reason);
      if (patch.departmentId !== undefined) logField(empId, "basic", "Department", deptName(e.departmentId), deptName(patch.departmentId), reason);
      if (patch.officeId !== undefined) logField(empId, "basic", "Office", officeName(e.officeId), officeName(patch.officeId), reason);
      if (patch.officialEmail !== undefined) logField(empId, "basic", "Official email", e.officialEmail, patch.officialEmail, reason);
      Object.assign(e, patch);
    }),

  /** PATCH /employees/:empId/job { …, reason } */
  updateJob: (empId: string, patch: JobPatch, reason: string) =>
    mock(() => {
      const e = findEmp(empId);
      if (!accessFor(e).access.edit.job) throw new ApiError("forbidden", "Only HR or the Director can change job fields.", 403);
      if (patch.level !== undefined) logField(empId, "job", "Level", `Level ${e.level}`, `Level ${patch.level}`, reason);
      if (patch.reportsTo !== undefined) logField(empId, "job", "Reports to", employeeName(e.reportsTo), employeeName(patch.reportsTo), reason);
      if (patch.joiningDate !== undefined) logField(empId, "job", "Joining date", formatDate(e.joiningDate), formatDate(patch.joiningDate), reason);
      if (patch.type !== undefined) logField(empId, "job", "Type", TYPE_LABEL[e.type], TYPE_LABEL[patch.type], reason);
      if (patch.status !== undefined) logField(empId, "job", "Status", e.status, patch.status, reason);
      if (patch.weeklyCapacityHours !== undefined) logField(empId, "job", "Weekly capacity", `${e.weeklyCapacityHours} h`, `${patch.weeklyCapacityHours} h`, reason);
      Object.assign(e, patch);
    }),

  /** PATCH /employees/:empId/personal */
  updatePersonal: (empId: string, patch: PersonalPatch) =>
    mock(() => {
      const e = findEmp(empId);
      const mode = accessFor(e).access.edit.personal;
      if (mode === "none") throw new ApiError("forbidden", "You can't change these details.", 403);
      if (mode === "contact" && patch.cnic !== undefined) throw new ApiError("forbidden", "Ask HR to change your CNIC.", 403);
      const rec = personalTable().find((p) => p.empId === empId);
      if (!rec) notFound("Personal details");
      if (patch.cnic !== undefined) logField(empId, "personal", "CNIC", maskTail(rec.cnic), maskTail(patch.cnic));
      if (patch.phone !== undefined) logField(empId, "personal", "Phone", rec.phone, patch.phone);
      if (patch.address !== undefined) logField(empId, "personal", "Address", rec.address, patch.address);
      if (patch.emergencyContact) {
        const o = rec.emergencyContact;
        const n = patch.emergencyContact;
        logField(empId, "personal", "Emergency contact", `${o.name} (${o.relation}) ${o.phone}`, `${n.name} (${n.relation}) ${n.phone}`);
      }
      Object.assign(rec, patch);
    }),

  /** PATCH /employees/:empId/pay — Director only, after step-up */
  updatePay: (empId: string, patch: PayPatch, reason: string) =>
    mock(() => {
      const e = findEmp(empId);
      if (!accessFor(e).access.edit.pay) throw new ApiError("forbidden", "Only the Director can change pay.", 403);
      let rec = payTable().find((p) => p.empId === empId);
      if (!rec) {
        rec = { empId, baseSalary: money(0), allowances: [], bankName: "", accountNumber: "" };
        payTable().push(rec);
      }
      if (patch.baseSalary !== undefined) {
        logField(empId, "pay", "Base salary", formatMoney(rec.baseSalary), formatMoney(patch.baseSalary), reason);
        rec.baseSalary = money(patch.baseSalary);
      }
      if (patch.allowances) {
        const fmt = (list: { name: string; amount: number }[]) => list.map((a) => `${a.name} ${formatMoney(a.amount)}`).join(", ") || "None";
        logField(empId, "pay", "Allowances", fmt(rec.allowances.map((a) => ({ name: a.name, amount: Number(a.amount.amount) }))), fmt(patch.allowances), reason);
        rec.allowances = patch.allowances.map((a) => ({ name: a.name, amount: money(a.amount) }));
      }
      if (patch.bankName !== undefined) {
        logField(empId, "pay", "Bank", rec.bankName, patch.bankName, reason);
        rec.bankName = patch.bankName;
      }
      if (patch.accountNumber !== undefined) {
        logField(empId, "pay", "Bank account", maskTail(rec.accountNumber || "0000"), maskTail(patch.accountNumber), reason);
        rec.accountNumber = patch.accountNumber;
      }
    }),

  /** POST /employees/:empId/reveal { field } — logged as a sensitive view (plan §16) */
  reveal: (empId: string, field: "cnic" | "salary" | "account") =>
    mock(() => {
      const label = { cnic: "CNIC", salary: "salary", account: "bank account" }[field];
      recordActivity({ action: "sensitive_view", module: "People", target: empId, description: `Viewed ${label} of ${employeeName(empId)} (${empId})` });
    }, { delay: 60 }),

  /** POST /employees (onboarding) → new Emp-ID; a welcome email with a temporary password is sent */
  create: (input: OnboardingInput) =>
    mock(() => {
      const v = getViewer();
      if (!v.can("people.manage")) throw new ApiError("forbidden", "Only HR or the Director can add employees.", 403);
      const list = employeesTable();
      if (list.some((e) => e.officialEmail === input.officialEmail)) throw new ApiError("validation", "That official email is already used.");
      const empId = nextEmpId(list.map((e) => e.empId));
      const employee: Employee = {
        id: uid("emp"),
        empId,
        name: input.name,
        designation: input.designation,
        departmentId: input.departmentId,
        officeId: input.officeId,
        officialEmail: input.officialEmail,
        level: input.level,
        role: input.level === 4 ? "team_lead" : input.departmentId === "dep-sales" ? "sales_exec" : "employee",
        duties: [],
        reportsTo: input.reportsTo,
        joiningDate: input.joiningDate,
        type: input.type,
        status: "active",
        weeklyCapacityHours: capacityFor(input.type),
        avatarHue: Math.floor(Math.random() * 360),
      };
      list.push(employee);
      personalTable().push({ empId, cnic: "", phone: "", address: "", emergencyContact: { name: "", relation: "", phone: "" } });
      if (input.pay && v.can("people.manage_pay")) {
        payTable().push({
          empId,
          baseSalary: money(input.pay.baseSalary),
          allowances: input.pay.allowanceName && input.pay.allowanceAmount ? [{ name: input.pay.allowanceName, amount: money(input.pay.allowanceAmount) }] : [],
          bankName: input.pay.bankName,
          accountNumber: input.pay.accountNumber,
        });
      }
      historyTable().unshift({ id: uid("fc"), empId, section: "job", field: "Joined", oldValue: "—", newValue: `${input.designation}, ${deptName(input.departmentId)}`, changedBy: v.employee.empId, changedAt: new Date().toISOString(), reason: "Onboarding" });
      recordActivity({ action: "create", module: "People", target: empId, description: `Added employee ${input.name} (${empId})` });
      return { empId, payPending: !input.pay };
    }, { delay: 600 }),

  /** GET /employees/:empId/offboard-preview */
  offboardPreview: (empId: string) =>
    mock<OffboardPreview>(() => {
      const e = findEmp(empId);
      return {
        openTasks: tasksTable().filter((t) => t.assignee === empId && !t.personal && isOpen(t.status)).length,
        manager: e.reportsTo ?? undefined,
        directReports: employeesTable().filter((x) => x.reportsTo === empId && x.status !== "left").length,
        isSales: e.departmentId === "dep-sales",
        activeSessions: sessionsFor().filter((s) => s.empId === empId).length,
      };
    }),

  /** POST /employees/:empId/offboard { lastWorkingDay, reason } */
  offboard: (empId: string, input: OffboardInput) =>
    mock(() => {
      const v = getViewer();
      if (!v.can("people.manage")) throw new ApiError("forbidden", "Only HR or the Director can set a last working day.", 403);
      const e = findEmp(empId);
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const leavesNow = new Date(input.lastWorkingDay) <= today;
      logField(empId, "job", "Last working day", "—", formatDate(input.lastWorkingDay), input.reason);
      logField(empId, "job", "Status", e.status, leavesNow ? "left" : "on_notice", input.reason);
      e.lastWorkingDay = input.lastWorkingDay;
      e.status = leavesNow ? "left" : "on_notice";
      if (leavesNow && e.reportsTo) {
        tasksTable()
          .filter((t) => t.assignee === empId && !t.personal && isOpen(t.status))
          .forEach((t) => (t.assignee = e.reportsTo!));
      }
    }),

  /** POST /employees/:empId/documents (multipart) */
  uploadDocument: (empId: string, file: { kind: DocumentKind; fileName: string; sizeBytes: number }) =>
    mock(() => {
      const e = findEmp(empId);
      if (!accessFor(e).access.edit.documents) throw new ApiError("forbidden", "You can't add documents to this profile.", 403);
      const doc: EmployeeDocument = { id: uid("doc"), empId, ...file, uploadedAt: new Date().toISOString(), uploadedBy: getViewer().employee.empId };
      documentsTable().unshift(doc);
      return doc;
    }, { delay: 700 }),
};
