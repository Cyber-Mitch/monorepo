import type { Metadata } from "next";
import { privatePageMetadata } from "@/lib/seo";
import { GovernanceClient } from "./GovernanceClient";

export const metadata: Metadata = privatePageMetadata(
  "Governance",
  "Vote on platform parameter proposals with your connected wallet.",
);

export default function GovernancePage() {
  return <GovernanceClient />;
}
