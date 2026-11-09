import type { Metadata } from "next";
import { MyPayslips } from "@/features/payroll/components/my-payslips";

export const metadata: Metadata = { title: "My payslips" };

export default function PayslipsPage() {
  return <MyPayslips />;
}
