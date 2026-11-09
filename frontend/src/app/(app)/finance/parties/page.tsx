import type { Metadata } from "next";
import { PartiesScreen } from "@/features/ledger/components/parties-screen";

export const metadata: Metadata = { title: "Clients and vendors" };

export default function Page() {
  return <PartiesScreen />;
}
