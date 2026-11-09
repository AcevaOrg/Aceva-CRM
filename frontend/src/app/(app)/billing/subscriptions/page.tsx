import type { Metadata } from "next";
import { SubscriptionsScreen } from "@/features/billing/components/subscriptions-screen";

export const metadata: Metadata = { title: "Subscriptions" };

export default function SubscriptionsPage() {
  return <SubscriptionsScreen />;
}
