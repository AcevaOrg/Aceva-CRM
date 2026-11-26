import type { Metadata } from "next";
import { ChannelsAdminScreen } from "@/features/comms/components/channels-admin-screen";

export const metadata: Metadata = { title: "Channels" };

export default function ChannelsPage() {
  return <ChannelsAdminScreen />;
}
