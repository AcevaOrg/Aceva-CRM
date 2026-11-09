import type { Metadata } from "next";
import { PerformanceScreen } from "@/features/performance/components/performance-screen";

export const metadata: Metadata = { title: "Performance" };

export default function PerformancePage() {
  return <PerformanceScreen />;
}
