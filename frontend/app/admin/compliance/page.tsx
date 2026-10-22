import type { Metadata } from "next";

import { privatePageMetadata } from "@/lib/seo";
import { ComplianceReportsClient } from "./ComplianceReportsClient";

/**
 * Admin compliance reports (#1982).
 *
 * The UI is interactive (forms, polling, downloads) so it lives in a client
 * component; this server route owns the page metadata so crawlers and
 * unfurlers see it in the initial HTML. The whole /admin segment is
 * `noindex`, and this page reaffirms it via `privatePageMetadata`.
 */
export const metadata: Metadata = privatePageMetadata(
  "Compliance reports",
  "Generate, download, and verify integrity hashes for compliance exports.",
);

export default function AdminCompliancePage() {
  return <ComplianceReportsClient />;
}
