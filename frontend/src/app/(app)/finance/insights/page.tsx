import type { Metadata } from "next";
import { InsightsScreen } from "@/features/analysis/components/insights-screen";

export const metadata: Metadata = { title: "Insights" };

export default function InsightsPage() {
  return <InsightsScreen />;
}
