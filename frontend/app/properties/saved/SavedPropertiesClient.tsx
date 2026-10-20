"use client";

/**
 * Tenant saved properties (#1915).
 *
 * Lists the listings a tenant has hearted. Unsaving removes the card at once
 * and puts it back if the request fails. Signed-out visitors are sent to log in.
 */

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Heart } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/data-state";
import { PropertyCard, propertyListingToCard } from "@/components/property-card";
import { PropertyCardSkeleton } from "@/components/property-card-skeleton";
import { isAuthenticated } from "@/lib/auth";
import { listPublicListings, type PropertyListing } from "@/lib/propertiesApi";
import { fetchSavedListingIds, setListingSaved } from "@/lib/savedPropertiesApi";

type AuthStatus = "checking" | "signed-in" | "signed-out";

type ListState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; listings: PropertyListing[] };

/** Saved ids come from the tenant endpoint; listings are fetched in the saved order. */
async function loadSavedListings(): Promise<PropertyListing[]> {
  const ids = await fetchSavedListingIds();
  if (ids.length === 0) return [];
  const res = await listPublicListings({ listingIds: ids, pageSize: ids.length });
  const byId = new Map(res.data.map((listing) => [listing.listingId, listing]));
  return ids
    .map((id) => byId.get(id))
    .filter((listing): listing is PropertyListing => listing !== undefined);
}

function SavedPropertiesContent() {
  const router = useRouter();
  const [auth, setAuth] = useState<AuthStatus>("checking");
  const [list, setList] = useState<ListState>({ status: "loading" });
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let cancelled = false;
    isAuthenticated()
      .catch(() => false)
      .then((signedIn) => {
        if (cancelled) return;
        if (signedIn) {
          setAuth("signed-in");
        } else {
          setAuth("signed-out");
          router.replace("/login");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [router]);

  useEffect(() => {
    if (auth !== "signed-in") return;
    let cancelled = false;
    loadSavedListings()
      .then((listings) => {
        if (!cancelled) setList({ status: "ready", listings });
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setList({
            status: "error",
            message: err instanceof Error ? err.message : "Could not load your saved properties.",
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [auth, reload]);

  const retry = () => {
    setList({ status: "loading" });
    setReload((n) => n + 1);
  };

  // Unsaving removes the card before the request completes. On failure the
  // previous list is restored and the error is rethrown, so PropertyCard shows
  // its own error toast and resets its heart state.
  const handleFavoriteChange = async (listingId: string, saved: boolean) => {
    if (list.status !== "ready") return;
    const previous = list.listings;

    if (!saved) {
      setList({ status: "ready", listings: previous.filter((l) => l.listingId !== listingId) });
    }

    try {
      await setListingSaved(listingId, saved);
    } catch (err) {
      if (!saved) setList({ status: "ready", listings: previous });
      throw err;
    }
  };

  if (auth === "checking" || auth === "signed-out") {
    return (
      <main className="container mx-auto px-4 py-12">
        <p role="status" aria-live="polite" className="font-mono font-bold text-muted-foreground">
          {auth === "checking" ? "Checking your session…" : "Redirecting to sign in…"}
        </p>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-background">
      <section className="container mx-auto px-4 py-12">
        <header className="mb-8">
          <h1 className="text-3xl font-black tracking-tight">Saved properties</h1>
          <p className="mt-2 text-muted-foreground">Homes you hearted, ready to compare or revisit.</p>
        </header>

        {list.status === "loading" && (
          <LoadingState
            label="Loading saved properties"
            className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
          >
            {Array.from({ length: 4 }).map((_, i) => (
              <PropertyCardSkeleton key={i} />
            ))}
          </LoadingState>
        )}

        {list.status === "error" && (
          <ErrorState
            title="Saved properties are unavailable"
            description={list.message}
            onRetry={retry}
          />
        )}

        {list.status === "ready" && list.listings.length === 0 && (
          <EmptyState
            icon={Heart}
            title="No saved properties yet"
            description="Tap the heart on any listing to save it here."
            action={{ label: "Browse properties", href: "/properties" }}
          />
        )}

        {list.status === "ready" && list.listings.length > 0 && (
          <>
            <p className="mb-6 text-muted-foreground">
              <span className="font-bold text-foreground">{list.listings.length}</span> saved
            </p>
            <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {list.listings.map((listing) => (
                <PropertyCard
                  key={listing.listingId}
                  property={propertyListingToCard(listing)}
                  isFavorited
                  onFavoriteChange={(saved) => handleFavoriteChange(listing.listingId, saved)}
                />
              ))}
            </div>
            <div className="mt-10 text-center">
              <Button asChild variant="outline" className="border-2 border-foreground font-bold">
                <Link href="/properties">Browse more properties</Link>
              </Button>
            </div>
          </>
        )}
      </section>
    </main>
  );
}

export default function SavedPropertiesClient() {
  return (
    <Suspense
      fallback={
        <main className="min-h-screen bg-background flex items-center justify-center">
          <p className="font-mono font-bold text-muted-foreground">Loading saved properties...</p>
        </main>
      }
    >
      <SavedPropertiesContent />
    </Suspense>
  );
}
