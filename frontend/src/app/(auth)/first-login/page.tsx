import type { Metadata } from "next";
import { FirstLoginWizard } from "@/features/auth/components/first-login-wizard";

export const metadata: Metadata = { title: "Welcome" };

export default function FirstLoginPage() {
  return <FirstLoginWizard />;
}
