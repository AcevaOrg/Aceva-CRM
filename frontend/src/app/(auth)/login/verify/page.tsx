import type { Metadata } from "next";
import { TwoFactorForm } from "@/features/auth/components/two-factor-form";

export const metadata: Metadata = { title: "Two-step sign in" };

export default function VerifyPage() {
  return <TwoFactorForm />;
}
