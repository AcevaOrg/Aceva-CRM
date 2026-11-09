import type { Metadata } from "next";
import { AdvancesScreen } from "@/features/payroll/components/advances-screen";

export const metadata: Metadata = { title: "Salary advances" };

export default function AdvancesPage() {
  return <AdvancesScreen />;
}
