import type { Metadata } from "next";
import { MySalesDayScreen } from "@/features/sales/components/my-sales-day";

export const metadata: Metadata = { title: "My sales day" };

export default function MySalesDayPage() {
  return <MySalesDayScreen />;
}
