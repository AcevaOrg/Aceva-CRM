import type { Metadata } from "next";
import { AccountScreen } from "@/features/auth/components/account-screen";

export const metadata: Metadata = { title: "My account" };

export default function AccountPage() {
  return <AccountScreen />;
}
