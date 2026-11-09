import type { Metadata } from "next";
import { OrgScreen } from "@/features/access/components/org-screen";

export const metadata: Metadata = { title: "Org and access" };

export default function OrgPage() {
  return <OrgScreen />;
}
