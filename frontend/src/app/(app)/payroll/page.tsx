import type { Metadata } from "next";
import { PayrollScreen } from "@/features/payroll/components/payroll-screen";

export const metadata: Metadata = { title: "Payroll" };

export default function PayrollPage() {
  return <PayrollScreen />;
}
