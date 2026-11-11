/**
 * Module 3 against the REAL API (NEXT_PUBLIC_LIVE_MODULES contains m3). Same function names and result shapes as the
 * mock in api.ts, so the screens do not change. The server decides everything (who sees and edits what); these
 * functions only translate between the API and the shapes the screens use.
 */
import type {
  CreateEmployeeResponse, DocumentView, RevealResponse, FieldChangeView, OffboardResponse, PayView, PersonalView, ProfileResponse,
} from "@aceva/contracts";
import { http } from "@/lib/api/http";
import { directoryApi } from "@/lib/directory";
import { roleFromApi, fetchLiveOrgNodes } from "@/lib/live-org";
import { isoDay } from "@/lib/dates";
import { money } from "@/lib/format";
import type { Duty, Employee, Level } from "@/types";
import type {
  BasicPatch, DocumentKind, EmployeeDocument, FieldChange, JobPatch, OffboardInput, OffboardPreview, OnboardingInput,
  PayDetails, PayPatch, PersonalDetails, PersonalPatch, ProfileView,
} from "./types";

const API_KIND: Record<DocumentKind, DocumentView["kind"] | null> = { cv: "cv", contract: "contract", cnic: "cnic_copy", certificate: "certificate", other: null };
const UI_KIND: Record<DocumentView["kind"], DocumentKind> = { cv: "cv", contract: "contract", cnic_copy: "cnic", certificate: "certificate" };

const hueFor = (empId: string) => (Number(empId.replace(/\D/g, "")) * 47) % 360;

function mapPersonal(p: PersonalView): PersonalDetails {
  return {
    cnic: p.cnicMasked ?? "", // masked; the full number comes only from the logged reveal
    phone: p.phone ?? "",
    address: p.homeAddress ?? "",
    emergencyContact: p.emergencyContact ?? { name: "", relation: "", phone: "" },
  };
}

function mapPay(p: PayView): PayDetails {
  // Salary amounts are NOT in the profile (placeholders only); they come from the logged reveal. The server keeps one
  // allowances total, so the screen shows it as a single line.
  return { salaryOnFile: p.salaryOnFile, baseSalary: money(0), allowances: p.salaryOnFile ? [{ name: "Allowances", amount: money(0) }] : [], bankName: p.bankName ?? "", accountNumber: p.accountMasked ?? "" };
}

const mapDocument = (empId: string) => (d: DocumentView): EmployeeDocument => ({
  id: d.id, empId, kind: UI_KIND[d.kind], fileName: d.fileName, sizeBytes: d.sizeBytes, uploadedAt: d.uploadedAt, uploadedBy: d.uploadedBy ?? "",
});

const mapChange = (empId: string) => (h: FieldChangeView): FieldChange => ({
  id: h.id, empId, section: h.section, field: h.field, oldValue: h.oldValue, newValue: h.newValue, changedBy: h.changedBy ?? "", changedAt: h.changedAt, reason: h.reason,
});

const totalOf = (list: { amount: number }[] | undefined) => (list ?? []).reduce((s, a) => s + (Number.isFinite(a.amount) ? a.amount : 0), 0);

export const livePeopleApi = {
  /** GET /employees merged with GET /org/tree (see lib/directory.ts) */
  list: async () => (await directoryApi.get()).employees,

  /** There is no live presence feed yet (the sessions are real, but only the owner can list their own). */
  presence: async () => [] as { empId: string; state: "online" | "idle" | "offline" }[],

  /** GET /employees/:empId: only the sections the server allows */
  profile: async (empId: string): Promise<ProfileView> => {
    const [res, nodes] = await Promise.all([http.get<ProfileResponse>(`/employees/${empId}`), fetchLiveOrgNodes().catch(() => [])]);
    const node = nodes.find((n) => n.empId === empId);
    const job = res.job;
    const level = (job?.level ?? node?.level ?? 5) as Level;
    const duties = (node?.duties ?? []) as Duty[];
    const departmentId = res.basic.departmentId;
    const employee: Employee = {
      id: empId,
      empId,
      name: res.basic.name,
      designation: res.basic.designation,
      departmentId,
      officeId: res.basic.officeId,
      officialEmail: res.basic.officialEmail ?? "",
      level,
      role: node?.role ?? roleFromApi(job?.roleKey ?? "employee", level, departmentId, duties),
      duties,
      reportsTo: job ? job.reportsTo : (node?.reportsTo ?? null),
      joiningDate: job?.joiningDate ?? "",
      type: job?.type ?? "full_time",
      status: job?.status ?? node?.status ?? "active",
      weeklyCapacityHours: job?.weeklyCapacityHours ?? 40,
      avatarHue: hueFor(empId),
      lastWorkingDay: job?.lastWorkingDay ?? undefined,
    };
    return {
      employee,
      access: res.access,
      personal: res.personal ? mapPersonal(res.personal) : undefined,
      pay: res.pay ? mapPay(res.pay) : undefined,
      documents: res.documents?.map(mapDocument(empId)),
      history: res.history?.map(mapChange(empId)),
      hasPhoto: res.basic.hasPhoto,
    };
  },

  updateBasic: async (empId: string, patch: BasicPatch, reason?: string) => {
    await http.patch(`/employees/${empId}/basic`, { ...patch, ...(reason ? { reason } : {}) });
  },

  updateJob: async (empId: string, patch: JobPatch, reason: string) => {
    const { reportsTo, joiningDate, ...rest } = patch;
    await http.patch(`/employees/${empId}/job`, {
      ...rest,
      ...(joiningDate !== undefined ? { joiningDate: isoDay(joiningDate) } : {}),
      ...(reportsTo !== undefined ? { reportsToEmpId: reportsTo } : {}),
      reason,
    });
  },

  updatePersonal: async (empId: string, patch: PersonalPatch) => {
    const { address, cnic, ...rest } = patch;
    // A masked CNIC ("*****1234") means "unchanged": it is never sent back.
    await http.patch(`/employees/${empId}/personal`, { ...rest, ...(address !== undefined ? { homeAddress: address } : {}), ...(cnic && !cnic.includes("*") ? { cnic } : {}) });
  },

  updatePay: async (empId: string, patch: PayPatch, reason: string) => {
    const { allowances, accountNumber, ...rest } = patch;
    await http.patch(`/employees/${empId}/pay`, {
      ...rest,
      ...(allowances ? { allowances: totalOf(allowances) } : {}),
      ...(accountNumber && !accountNumber.includes("*") ? { accountNumber } : {}),
      reason,
    });
  },

  /** POST /employees/:empId/reveal: the full value, logged on the server every time */
  reveal: async (empId: string, field: "cnic" | "salary" | "account") => (await http.post<RevealResponse>(`/employees/${empId}/reveal`, { field })).value,

  /** The salary (base and allowances total): permission-checked and audited on the server each time. */
  revealSalary: async (empId: string) => {
    const r = await http.post<RevealResponse>(`/employees/${empId}/reveal`, { field: "salary" });
    return { value: r.value, allowances: r.allowances ?? "0.00" };
  },

  create: async (input: OnboardingInput) => {
    const res = await http.post<CreateEmployeeResponse>("/employees", {
      name: input.name,
      designation: input.designation,
      departmentId: input.departmentId,
      officeId: input.officeId,
      officialEmail: input.officialEmail,
      level: input.level,
      reportsToEmpId: input.reportsTo,
      joiningDate: isoDay(input.joiningDate),
      type: input.type,
      ...(input.pay ? { pay: { baseSalary: input.pay.baseSalary, allowances: input.pay.allowanceAmount ?? 0, bankName: input.pay.bankName, accountNumber: input.pay.accountNumber } } : {}),
    });
    return res.status === "created"
      ? { status: "created" as const, empId: res.empId, payPending: res.payPending, welcomeEmailSent: res.welcomeEmailSent }
      : { status: "pending_approval" as const, empId: "", requestId: res.requestId, payPending: res.payPending, welcomeEmailSent: true };
  },

  resendWelcome: async (empId: string) => http.post<{ welcomeEmailSent: boolean }>(`/employees/${empId}/resend-welcome`, {}),

  /** What will happen on the last day. Tasks and payroll belong to later modules, so only requests are prepared. */
  offboardPreview: async (empId: string): Promise<OffboardPreview> => {
    const employees = (await directoryApi.get()).employees;
    const e = employees.find((x) => x.empId === empId);
    return {
      openTasks: 0,
      manager: e?.reportsTo ?? undefined,
      directReports: employees.filter((x) => x.reportsTo === empId && x.status !== "left").length,
      isSales: e?.departmentId === "dep-sales",
      activeSessions: 0,
    };
  },

  offboard: async (empId: string, input: OffboardInput) => {
    await http.post<OffboardResponse>(`/employees/${empId}/offboard`, { lastWorkingDay: isoDay(input.lastWorkingDay), reason: input.reason });
  },

  /** POST /employees/:empId/documents (multipart): stored in private storage */
  uploadDocument: async (empId: string, file: { kind: DocumentKind; fileName: string; sizeBytes: number; blob?: File }) => {
    const kind = API_KIND[file.kind];
    if (!kind) throw new Error("This kind of document is not supported.");
    if (!file.blob) throw new Error("Choose a file to upload.");
    const form = new FormData();
    form.set("type", kind);
    form.set("file", file.blob, file.fileName);
    return mapDocument(empId)(await http.upload<DocumentView>(`/employees/${empId}/documents`, form));
  },

  /** DELETE /employees/:empId/documents/:id: archived (kept, never deleted), the reason is audited */
  archiveDocument: async (empId: string, documentId: string, reason: string) => {
    await http.delete(`/employees/${empId}/documents/${documentId}`, { reason });
  },

  /** GET /employees/:empId/documents/:id/download: permission-checked and logged on the server */
  downloadDocument: async (empId: string, documentId: string, fileName: string) => {
    const blob = await http.blob(`/employees/${empId}/documents/${documentId}/download`);
    const href = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = href;
    a.download = fileName;
    document.body.appendChild(a); // some browsers only honour the click when the link is in the page
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(href), 10_000);
  },
};
