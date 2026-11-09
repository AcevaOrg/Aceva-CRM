import type { Metadata } from "next";
import { TaskDetail } from "@/features/tasks/components/task-detail";

export const metadata: Metadata = { title: "Task" };

export default async function TaskPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <TaskDetail id={id} />;
}
