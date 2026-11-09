import { AppShell } from "@/components/layout/app-shell";

export default function SignedInLayout({ children }: { children: React.ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
