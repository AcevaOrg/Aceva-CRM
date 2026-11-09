import type { Metadata } from "next";
import { MeetingsScreen } from "@/features/comms/components/meetings-screen";

export const metadata: Metadata = { title: "Meetings" };

export default function MeetingsPage() {
  return <MeetingsScreen />;
}
