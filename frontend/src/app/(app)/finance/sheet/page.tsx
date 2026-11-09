import type { Metadata } from "next";
import { SheetScreen } from "@/features/analysis/components/sheet-screen";

export const metadata: Metadata = { title: "Spreadsheet" };

export default function SheetPage() {
  return <SheetScreen />;
}
