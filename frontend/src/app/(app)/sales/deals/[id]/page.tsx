import type { Metadata } from "next";
import { DealDetailScreen } from "@/features/sales/components/deal-detail";

export const metadata: Metadata = { title: "Deal" };

export default async function DealPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <DealDetailScreen id={id} />;
}
