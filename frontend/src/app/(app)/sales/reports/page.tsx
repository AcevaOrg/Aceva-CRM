import type { Metadata } from "next";
import { SalesReportsScreen } from "@/features/sales/components/reports-screen";

export const metadata: Metadata = { title: "Sales reports" };

export default function SalesReportsPage() {
  return <SalesReportsScreen />;
}
