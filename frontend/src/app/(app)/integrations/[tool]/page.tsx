import type { Metadata } from "next";
import { ConnectWizardScreen } from "@/features/integrations/components/connect-wizard";

export const metadata: Metadata = { title: "Connect a sales tool" };

export default async function IntegrationToolPage({ params }: { params: Promise<{ tool: string }> }) {
  const { tool } = await params;
  return <ConnectWizardScreen tool={tool} />;
}
