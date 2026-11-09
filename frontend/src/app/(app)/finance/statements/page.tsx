import type { Metadata } from "next";
import { StatementsScreen } from "@/features/statements/components/statements-screen";

export const metadata: Metadata = { title: "Financial statements" };

export default function StatementsPage() {
  return <StatementsScreen />;
}
