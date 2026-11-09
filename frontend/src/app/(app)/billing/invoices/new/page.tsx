import type { Metadata } from "next";
import { InvoiceEditor } from "@/features/billing/components/invoice-editor";

export const metadata: Metadata = { title: "New invoice" };

export default function NewInvoicePage() {
  return <InvoiceEditor />;
}
