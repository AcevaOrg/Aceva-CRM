import type { Metadata } from "next";
import { MessagesScreen } from "@/features/comms/components/messages-screen";

export const metadata: Metadata = { title: "Messages" };

export default async function ConversationPage({ params }: { params: Promise<{ conversationId: string }> }) {
  const { conversationId } = await params;
  return <MessagesScreen conversationId={conversationId} />;
}
