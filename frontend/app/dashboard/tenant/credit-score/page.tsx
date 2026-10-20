import type { Metadata } from "next";
import { privatePageMetadata } from "@/lib/seo";
import { CreditScoreClient } from "./CreditScoreClient";

export const metadata: Metadata = privatePageMetadata(
  "Credit Score",
  "View your tenant credit score, factors, and history.",
);

export default function CreditScorePage() {
  return <CreditScoreClient />;
}
