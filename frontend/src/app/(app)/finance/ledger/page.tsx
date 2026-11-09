import type { Metadata } from "next";
import { JournalListScreen } from "@/features/ledger/components/journal-list-screen";

export const metadata: Metadata = { title: "Ledger" };

export default function LedgerPage() {
  return <JournalListScreen />;
}
