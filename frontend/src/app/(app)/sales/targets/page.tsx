import type { Metadata } from "next";
import { TargetsScreen } from "@/features/sales/components/targets-screen";

export const metadata: Metadata = { title: "Targets and commission" };

export default function TargetsPage() {
  return <TargetsScreen />;
}
