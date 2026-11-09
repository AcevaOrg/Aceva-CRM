import type { Metadata } from "next";
import { CloseScreen } from "@/features/ledger/components/close-screen";

export const metadata: Metadata = { title: "Month close" };

export default function Page() {
  return <CloseScreen />;
}
