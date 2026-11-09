import type { Metadata } from "next";
import { AccountsScreen } from "@/features/ledger/components/accounts-screen";

export const metadata: Metadata = { title: "Chart of accounts" };

export default function Page() {
  return <AccountsScreen />;
}
