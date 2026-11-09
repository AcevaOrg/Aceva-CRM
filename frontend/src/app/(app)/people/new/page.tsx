import type { Metadata } from "next";
import { OnboardingWizard } from "@/features/people/components/onboarding-wizard";

export const metadata: Metadata = { title: "Add an employee" };

export default function NewEmployeePage() {
  return <OnboardingWizard />;
}
