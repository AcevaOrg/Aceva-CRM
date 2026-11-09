import { AuthFrame } from "@/features/auth/components/auth-frame";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return <AuthFrame>{children}</AuthFrame>;
}
