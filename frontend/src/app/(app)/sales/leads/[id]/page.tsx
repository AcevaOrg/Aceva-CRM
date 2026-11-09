import type { Metadata } from "next";
import { LeadDetailScreen } from "@/features/sales/components/lead-detail";

export const metadata: Metadata = { title: "Lead" };

export default async function LeadPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <LeadDetailScreen id={id} />;
}
