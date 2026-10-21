import type { Metadata } from "next";
import { privatePageMetadata } from "@/lib/seo";
import { RentToOwnClient } from "./RentToOwnClient";

export const metadata: Metadata = privatePageMetadata(
  "Rent-to-Own Equity",
  "Track the equity you have built on your rent-to-own deal.",
);

export default async function RentToOwnPage({
  params,
}: {
  params: Promise<{ dealId: string }>;
}) {
  const { dealId } = await params;
  return <RentToOwnClient dealId={dealId} />;
}
