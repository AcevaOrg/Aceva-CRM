import type { Metadata } from "next";
import { IntegrationsHealthScreen } from "@/features/integrations/components/health-screen";

export const metadata: Metadata = { title: "Integrations" };

export default function IntegrationsPage() {
  return <IntegrationsHealthScreen />;
}
