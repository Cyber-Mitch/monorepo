"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Home } from "lucide-react";
import { DashboardHeader } from "@/components/dashboard-header";
import { DashboardSidebar } from "@/components/dashboard/DashboardSidebar";
import { RentToOwnEquityCard } from "@/components/tenant/RentToOwnEquityCard";
import {
  EmptyState,
  ErrorState,
  LoadingState,
  StatCardSkeleton,
} from "@/components/ui/data-state";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError } from "@/lib/apiClient";
import { useFeatureFlag } from "@/lib/featureFlags";
import useAuthStore from "@/store/useAuthStore";
import { getRentToOwnEquity, type RentToOwnEquity } from "@/lib/rentToOwnApi";

export function RentToOwnClient({ dealId }: { dealId: string }) {
  const user = useAuthStore((state) => state.user);
  const userName = user?.name ?? user?.email ?? "User";
  const isEnabled = useFeatureFlag("RENT_TO_OWN_ENABLED");
  const [equity, setEquity] = useState<RentToOwnEquity | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadEquity = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await getRentToOwnEquity(dealId);
      setEquity(res.data ?? null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        // Not a rent-to-own deal (or not this tenant's) — an empty state, not a failure.
        setEquity(null);
      } else {
        setError(err instanceof Error ? err.message : "Failed to load equity");
      }
    } finally {
      setLoading(false);
    }
  }, [dealId]);

  useEffect(() => {
    if (!isEnabled) return;
    loadEquity();
  }, [isEnabled, loadEquity]);

  return (
    <div className="min-h-screen bg-background">
      <DashboardHeader />
      <DashboardSidebar
        role="tenant"
        userInfo={{ name: userName, roleLabel: "Tenant" }}
      />
      <main id="main-content" className="min-h-screen pt-20 lg:ml-64">
        <div className="mx-auto max-w-4xl space-y-6 px-4 py-6 sm:px-6">
          <div className="space-y-2">
            <Link
              href="/dashboard/tenant/lease"
              className="inline-flex items-center gap-1 text-sm font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <ArrowLeft className="h-4 w-4" aria-hidden="true" />
              Back to lease
            </Link>
            <h1 className="text-3xl font-black tracking-tight sm:text-4xl">
              Rent-to-Own Equity
            </h1>
            <p className="text-muted-foreground">
              Every payment builds your share of the home. Here is where you
              stand.
            </p>
          </div>

          {!isEnabled ? (
            <EmptyState
              icon={Home}
              title="Rent-to-own isn't available yet"
              description="Equity tracking will appear here once rent-to-own is enabled for your account."
              action={{
                label: "Back to lease",
                href: "/dashboard/tenant/lease",
              }}
            />
          ) : loading ? (
            <LoadingState label="Loading your equity" className="space-y-4">
              <Skeleton className="h-48 w-full" />
              <div className="grid gap-4 sm:grid-cols-2">
                <StatCardSkeleton />
                <StatCardSkeleton />
              </div>
            </LoadingState>
          ) : error ? (
            <ErrorState
              title="Your equity is unavailable"
              description={error}
              onRetry={loadEquity}
            />
          ) : !equity ? (
            <EmptyState
              icon={Home}
              title="No rent-to-own deal found"
              description="This lease isn't a rent-to-own deal, so there's no equity to track."
              action={{
                label: "Back to lease",
                href: "/dashboard/tenant/lease",
              }}
            />
          ) : (
            <RentToOwnEquityCard equity={equity} />
          )}
        </div>
      </main>
    </div>
  );
}
