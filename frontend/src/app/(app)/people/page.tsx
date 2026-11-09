import type { Metadata } from "next";
import { PeopleDirectory } from "@/features/people/components/people-directory";

export const metadata: Metadata = { title: "People" };

export default function PeoplePage() {
  return <PeopleDirectory />;
}
