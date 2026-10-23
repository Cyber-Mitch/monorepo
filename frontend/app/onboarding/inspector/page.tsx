import type { Metadata } from "next";
import { privatePageMetadata } from "@/lib/seo";
import { InspectorOnboardingClient } from "./InspectorOnboardingClient";

export const metadata: Metadata = privatePageMetadata(
  "Inspector onboarding",
  "Apply to become a Shelterflex property inspector and track your verification status.",
);

export default function InspectorOnboardingPage() {
  return <InspectorOnboardingClient />;
}
