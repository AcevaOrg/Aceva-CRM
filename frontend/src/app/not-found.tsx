import Link from "next/link";
import { AcevaMark } from "@/components/layout/logo";

export default function NotFound() {
  return (
    <main className="layer-lines grid min-h-dvh place-content-center px-6 text-center">
      <div className="grid justify-items-center gap-3 rounded-2xl bg-background/85 p-8">
        <AcevaMark size={40} />
        <p className="font-mono text-sm text-muted-foreground">404</p>
        <h1 className="text-2xl font-semibold tracking-tight">Page not found</h1>
        <p className="max-w-sm text-[13.5px] text-muted-foreground">The page you&apos;re looking for doesn&apos;t exist or you don&apos;t have access to it.</p>
        <Link href="/" className="mt-2 text-[13px] font-medium text-primary hover:underline">
          Go to Home
        </Link>
      </div>
    </main>
  );
}
