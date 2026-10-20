"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ShieldAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  EmptyState,
  ErrorState,
  ListRowSkeleton,
  LoadingAnnouncer,
} from "@/components/ui/data-state";
import {
  listListingReports,
  listReportedReviews,
  REPORT_CATEGORIES,
  setReviewHidden,
  type ListingReport,
  type ModerationPagination,
  type ReportCategory,
  type ReportedReview,
} from "@/lib/moderationApi";

type LoadState<T> =
  | { status: "loading" }
  | { status: "forbidden" }
  | { status: "error" }
  | { status: "ready"; items: T; pagination: ModerationPagination };

/** The API returns 403 for non-moderators. The page shows that state instead of a generic error. */
function statusOf(err: unknown): number | undefined {
  return (err as { status?: number }).status;
}

function ListingReportsTab() {
  const [propertyId, setPropertyId] = useState("");
  const [category, setCategory] = useState<ReportCategory | "all">("all");
  const [page, setPage] = useState(1);
  const [reload, setReload] = useState(0);
  const [state, setState] = useState<LoadState<ListingReport[]>>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    listListingReports({ propertyId: propertyId || undefined, category, page })
      .then((res) => {
        if (!cancelled)
          setState({ status: "ready", items: res.reports, pagination: res.pagination });
      })
      .catch((err: unknown) => {
        if (!cancelled)
          setState(statusOf(err) === 403 ? { status: "forbidden" } : { status: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [propertyId, category, page, reload]);

  const retry = useCallback(() => {
    setState({ status: "loading" });
    setReload((t) => t + 1);
  }, []);

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="report-property">Property ID</Label>
          <Input
            id="report-property"
            value={propertyId}
            onChange={(e) => {
              setState({ status: "loading" });
              setPage(1);
              setPropertyId(e.target.value.trim());
            }}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="report-category">Category</Label>
          <select
            id="report-category"
            className="w-full rounded-md border bg-background px-3 py-2 text-sm"
            value={category}
            onChange={(e) => {
              setState({ status: "loading" });
              setPage(1);
              setCategory(e.target.value as ReportCategory | "all");
            }}
          >
            <option value="all">All categories</option>
            {REPORT_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
      </div>

      {state.status === "loading" && (
        <div className="space-y-2">
          <LoadingAnnouncer label="Loading listing reports" />
          <ListRowSkeleton />
          <ListRowSkeleton />
        </div>
      )}
      {state.status === "forbidden" && <ForbiddenState />}
      {state.status === "error" && (
        <ErrorState title="Could not load listing reports" onRetry={retry} />
      )}
      {state.status === "ready" && state.items.length === 0 && (
        <EmptyState
          icon={ShieldAlert}
          title="No listing reports"
          description="Reports submitted from listing pages appear here."
        />
      )}
      {state.status === "ready" && state.items.length > 0 && (
        <>
          <ul className="divide-y rounded-lg border">
            {state.items.map((r) => (
              <li key={r.reportId} className="flex flex-col gap-2 p-4 sm:flex-row sm:justify-between">
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <Badge variant="outline">{r.category}</Badge>
                    <Link
                      href={`/properties/${encodeURIComponent(r.propertyId)}`}
                      className="text-sm underline"
                    >
                      {r.propertyTitle ?? r.propertyId}
                    </Link>
                  </div>
                  <p className="text-sm text-muted-foreground">{r.details}</p>
                </div>
                <time className="text-xs text-muted-foreground" dateTime={r.createdAt}>
                  {new Date(r.createdAt).toLocaleString()}
                </time>
              </li>
            ))}
          </ul>
          <Pager
            pagination={state.pagination}
            onPage={(p) => {
              setState({ status: "loading" });
              setPage(p);
            }}
          />
        </>
      )}
    </div>
  );
}

function ReportedReviewsTab() {
  const [page, setPage] = useState(1);
  const [reload, setReload] = useState(0);
  const [pending, setPending] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [state, setState] = useState<LoadState<ReportedReview[]>>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    listReportedReviews({ page })
      .then((res) => {
        if (!cancelled)
          setState({ status: "ready", items: res.reviews, pagination: res.pagination });
      })
      .catch((err: unknown) => {
        if (!cancelled)
          setState(statusOf(err) === 403 ? { status: "forbidden" } : { status: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [page, reload]);

  const retry = useCallback(() => {
    setState({ status: "loading" });
    setReload((t) => t + 1);
  }, []);

  const toggleHidden = async (review: ReportedReview) => {
    setPending(review.id);
    setActionError(null);
    try {
      await setReviewHidden(review.id, !review.isHidden);
      // Refresh so the list reflects the server state after the action.
      setReload((t) => t + 1);
    } catch {
      setActionError("Could not update this review. Try again.");
    } finally {
      setPending(null);
    }
  };

  return (
    <div className="space-y-4">
      {actionError && (
        <p role="alert" className="text-sm text-destructive">
          {actionError}
        </p>
      )}

      {state.status === "loading" && (
        <div className="space-y-2">
          <LoadingAnnouncer label="Loading reported reviews" />
          <ListRowSkeleton />
          <ListRowSkeleton />
        </div>
      )}
      {state.status === "forbidden" && <ForbiddenState />}
      {state.status === "error" && (
        <ErrorState title="Could not load reported reviews" onRetry={retry} />
      )}
      {state.status === "ready" && state.items.length === 0 && (
        <EmptyState
          icon={ShieldAlert}
          title="No reported reviews"
          description="Reviews that users report are listed here."
        />
      )}
      {state.status === "ready" && state.items.length > 0 && (
        <>
          <ul className="space-y-3">
            {state.items.map((r) => (
              <li key={r.id}>
                <Card>
                  <CardContent className="space-y-2 pt-6">
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      <span className="font-medium">{r.authorName}</span>
                      <span aria-label={`Rated ${r.rating} out of 5`}>{r.rating} / 5</span>
                      {r.isHidden && <Badge variant="secondary">Hidden</Badge>}
                    </div>
                    <p className="text-sm">{r.content}</p>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={pending === r.id}
                      onClick={() => toggleHidden(r)}
                    >
                      {r.isHidden ? "Unhide review" : "Hide review"}
                    </Button>
                  </CardContent>
                </Card>
              </li>
            ))}
          </ul>
          <Pager
            pagination={state.pagination}
            onPage={(p) => {
              setState({ status: "loading" });
              setPage(p);
            }}
          />
        </>
      )}
    </div>
  );
}

function Pager({
  pagination,
  onPage,
}: {
  pagination: ModerationPagination;
  onPage: (page: number) => void;
}) {
  return (
    <nav aria-label="Pagination" className="flex items-center justify-between">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={pagination.page <= 1}
        onClick={() => onPage(pagination.page - 1)}
      >
        Previous
      </Button>
      <span className="text-sm text-muted-foreground">
        Page {pagination.page} of {Math.max(1, pagination.totalPages)}
      </span>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={pagination.page >= pagination.totalPages}
        onClick={() => onPage(pagination.page + 1)}
      >
        Next
      </Button>
    </nav>
  );
}

function ForbiddenState() {
  return (
    <EmptyState
      icon={ShieldAlert}
      title="Access denied"
      description="You need moderation permission to view this queue."
    />
  );
}

export function ModerationClient() {
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-4 sm:p-6">
      <header>
        <h1 className="text-2xl font-bold tracking-tight">Moderation</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Review listing reports and reported reviews.
        </p>
      </header>

      <Tabs defaultValue="listings">
        <TabsList>
          <TabsTrigger value="listings">Listing reports</TabsTrigger>
          <TabsTrigger value="reviews">Reported reviews</TabsTrigger>
        </TabsList>
        <TabsContent value="listings">
          <ListingReportsTab />
        </TabsContent>
        <TabsContent value="reviews">
          <ReportedReviewsTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
