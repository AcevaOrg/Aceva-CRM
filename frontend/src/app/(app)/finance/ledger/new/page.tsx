import type { Metadata } from "next";
import { EntryComposerScreen } from "@/features/ledger/components/entry-composer";

export const metadata: Metadata = { title: "New journal entry" };

export default function NewEntryPage() {
  return <EntryComposerScreen />;
}
