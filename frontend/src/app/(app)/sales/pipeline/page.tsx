import type { Metadata } from "next";
import { PipelineScreen } from "@/features/sales/components/pipeline-screen";

export const metadata: Metadata = { title: "Pipeline" };

export default function PipelinePage() {
  return <PipelineScreen />;
}
