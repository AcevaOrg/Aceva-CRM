import type { Metadata } from "next";
import { LeaveScreen } from "@/features/attendance/components/leave-screen";

export const metadata: Metadata = { title: "Leave" };

export default function LeavePage() {
  return <LeaveScreen />;
}
