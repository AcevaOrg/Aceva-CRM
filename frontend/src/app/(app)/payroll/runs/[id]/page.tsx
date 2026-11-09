import type { Metadata } from "next";
import { RunDetail } from "@/features/payroll/components/run-detail";

export const metadata: Metadata = { title: "Payroll run" };

export default async function PayrollRunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <RunDetail id={id} />;
}
