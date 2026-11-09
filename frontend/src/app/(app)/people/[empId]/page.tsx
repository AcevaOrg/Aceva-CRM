import type { Metadata } from "next";
import { ProfileScreen } from "@/features/people/components/profile-screen";

export async function generateMetadata({ params }: { params: Promise<{ empId: string }> }): Promise<Metadata> {
  const { empId } = await params;
  return { title: empId };
}

export default async function ProfilePage({ params }: { params: Promise<{ empId: string }> }) {
  const { empId } = await params;
  return <ProfileScreen empId={decodeURIComponent(empId)} />;
}
