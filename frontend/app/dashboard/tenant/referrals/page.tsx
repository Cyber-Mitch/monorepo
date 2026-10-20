import type { Metadata } from "next";
import { privatePageMetadata } from "@/lib/seo";
import { ReferralsClient } from "./ReferralsClient";

export const metadata: Metadata = privatePageMetadata(
  "Refer a friend",
  "Share your referral code and track your referred friends and rewards.",
);

export default function ReferralsPage() {
  return <ReferralsClient />;
}
