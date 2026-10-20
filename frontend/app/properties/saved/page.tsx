import type { Metadata } from "next";
import { privatePageMetadata } from "@/lib/seo";
import SavedPropertiesClient from "./SavedPropertiesClient";

/**
 * Server entry point for `/properties/saved`. The metadata export lives here
 * because the UI is a client component (see SEO_METADATA_CONVENTION.md).
 * The page is signed-in only, so it is excluded from indexing.
 */
export const metadata: Metadata = privatePageMetadata("Saved Properties");

export default function SavedPropertiesPage() {
  return <SavedPropertiesClient />;
}
