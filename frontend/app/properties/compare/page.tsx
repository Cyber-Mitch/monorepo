import type { Metadata } from "next";
import { buildPageMetadata } from "@/lib/seo";
import CompareClient from "./CompareClient";

/**
 * Server entry point for `/properties/compare`. The canonical URL is the bare
 * path: the selected ids live in the query string, and each combination would
 * otherwise look like a separate page.
 */
export const metadata: Metadata = buildPageMetadata({
  title: "Compare Properties",
  description:
    "Compare up to three rental properties side by side on price, instalments, location, bedrooms and amenities.",
  path: "/properties/compare",
});

export default function ComparePage() {
  return <CompareClient />;
}
