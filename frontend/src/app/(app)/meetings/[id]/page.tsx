import type { Metadata } from "next";
import { MeetingDetail } from "@/features/comms/components/meeting-detail";

export const metadata: Metadata = { title: "Meeting" };

export default async function MeetingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <MeetingDetail id={id} />;
}
