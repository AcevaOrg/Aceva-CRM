import type { Metadata } from "next";
import { EntryDetailScreen } from "@/features/ledger/components/entry-detail";

export const metadata: Metadata = { title: "Journal entry" };

export default async function EntryPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <EntryDetailScreen id={id} />;
}
