import type { Metadata } from "next";
import { TwoFactorSetupScreen } from "@/features/auth/components/two-factor-setup-screen";

export const metadata: Metadata = { title: "Set up two-step login" };

export default function TwoFactorSetupPage() {
  return <TwoFactorSetupScreen />;
}
