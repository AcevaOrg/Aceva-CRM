import type { Metadata } from "next";
import { BankingScreen } from "@/features/ledger/components/banking-screen";

export const metadata: Metadata = { title: "Banking" };

export default function Page() {
  return <BankingScreen />;
}
