import type { Metadata } from "next";
import { ScorecardView } from "@/features/performance/components/scorecard-view";

export const metadata: Metadata = { title: "Scorecard" };

export default async function ScorecardPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ScorecardView id={id} />;
}
