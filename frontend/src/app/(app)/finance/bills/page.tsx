import type { Metadata } from "next";
import { BillsScreen } from "@/features/ledger/components/bills-screen";

export const metadata: Metadata = { title: "Bills and expenses" };

export default function Page() {
  return <BillsScreen />;
}
