import type { Metadata } from "next";
import { privatePageMetadata } from "@/lib/seo";
import { ModerationClient } from "./ModerationClient";

export const metadata: Metadata = privatePageMetadata(
  "Moderation",
  "Work through listing reports and reported reviews.",
);

export default function ModerationPage() {
  return <ModerationClient />;
}
