import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/seo";

/**
 * Sitemap for public, indexable routes.
 *
 * This file generates a sitemap.xml for search engines, listing all genuinely
 * public pages that should be crawled and indexed. It deliberately excludes
 * any routes listed in robots.ts's disallow list to ensure consistency.
 *
 * Dynamic routes (e.g., /properties/[id]) are not included here; they would
 * require fetching real listing data from the API. This is tracked as a
 * follow-up improvement.
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const baseUrl = SITE_URL;

  // Static public routes - these are the genuinely indexable pages
  // Cross-referenced with robots.ts disallow list to ensure no overlap
  const staticRoutes = [
    "",
    "/about",
    "/contact",
    "/calculator",
    "/cookies",
    "/landlords",
    "/privacy",
    "/privacy-policy",
    "/properties",
    "/terms",
    "/terms-of-service",
  ];

  // Flag-gated public route (#1924): only indexable while the rent-to-own
  // feature is switched on. Best-effort; the static defaults apply when the
  // flags endpoint is unreachable.
  if (await isRentToOwnEnabled()) {
    staticRoutes.push("/calculator/rent-to-own");
  }

  return staticRoutes.map((route) => ({
    url: `${baseUrl}${route}`,
    lastModified: new Date(),
    changeFrequency: "weekly" as const,
    priority: route === "" ? 1 : 0.8,
  }));
}
/** Best-effort server-side flag read for the sitemap (#1924). */
async function isRentToOwnEnabled(): Promise<boolean> {
  try {
    const backendUrl = process.env.NEXT_PUBLIC_BACKEND_URL;
    if (!backendUrl) return false;
    const res = await fetch(`${backendUrl}/api/config/feature-flags`, {
      next: { revalidate: 3600 },
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { data?: Record<string, boolean> };
    return body.data?.RENT_TO_OWN_ENABLED === true;
  } catch {
    return false;
  }
}
