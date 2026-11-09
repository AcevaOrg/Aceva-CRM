import type { Metadata } from "next";
import { AttendanceScreen } from "@/features/attendance/components/attendance-screen";

export const metadata: Metadata = { title: "Attendance" };

export default function AttendancePage() {
  return <AttendanceScreen />;
}
