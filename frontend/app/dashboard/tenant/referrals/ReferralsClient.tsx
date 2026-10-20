"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, Copy, Gift, MessageCircle, Share2, Users } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  EmptyState,
  ErrorState,
  ListRowSkeleton,
  LoadingAnnouncer,
  MoneyValue,
  StatCardSkeleton,
} from "@/components/ui/data-state";
import { formatNgn } from "@/lib/currency";
import {
  getMyReferralConversions,
  getMyReferrals,
  type ReferralConversion,
  type ReferralConversionStatus,
  type ReferralConversionsResponse,
  type ReferralSummary,
} from "@/lib/referralsApi";

const PAGE_SIZE = 10;

const STATUS_LABEL: Record<ReferralConversionStatus, string> = {
  pending: "Pending",
  credited: "Credited",
  rejected: "Not eligible",
};

type SummaryState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; summary: ReferralSummary };

type ConversionsState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; data: ReferralConversionsResponse };

export function ReferralsClient() {
  const [summaryState, setSummaryState] = useState<SummaryState>({ status: "loading" });
  const [summaryReload, setSummaryReload] = useState(0);

  const [conversionsState, setConversionsState] = useState<ConversionsState>({
    status: "loading",
  });
  const [page, setPage] = useState(1);
  const [conversionsReload, setConversionsReload] = useState(0);

  const [copied, setCopied] = useState<"code" | "link" | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getMyReferrals()
      .then((summary) => {
        if (!cancelled) setSummaryState({ status: "ready", summary });
      })
      .catch(() => {
        if (!cancelled) setSummaryState({ status: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [summaryReload]);

  useEffect(() => {
    let cancelled = false;
    getMyReferralConversions({ page, limit: PAGE_SIZE })
      .then((data) => {
        if (!cancelled) setConversionsState({ status: "ready", data });
      })
      .catch(() => {
        if (!cancelled) setConversionsState({ status: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [page, conversionsReload]);

  const retrySummary = useCallback(() => {
    setSummaryState({ status: "loading" });
    setSummaryReload((t) => t + 1);
  }, []);

  const retryConversions = useCallback(() => {
    setConversionsState({ status: "loading" });
    setConversionsReload((t) => t + 1);
  }, []);

  const copy = useCallback(async (value: string, which: "code" | "link") => {
    try {
      await navigator.clipboard.writeText(value);
      setCopyError(null);
      setCopied(which);
      window.setTimeout(() => setCopied(null), 2000);
    } catch {
      setCopyError("Copy failed. Select the text and copy it manually.");
    }
  }, []);

  const handleNativeShare = useCallback(async (summary: ReferralSummary) => {
    const text = `Join Shelterflex with my referral code ${summary.code}`;
    try {
      await navigator.share({ title: "Shelterflex", text, url: summary.shareUrl });
    } catch (err) {
      // The user dismissing the share sheet is not an error.
      if (err instanceof DOMException && err.name === "AbortError") return;
      setCopyError("Sharing is not available here. Copy the link instead.");
    }
  }, []);

  const summary = summaryState.status === "ready" ? summaryState.summary : null;
  const canNativeShare =
    typeof navigator !== "undefined" && typeof navigator.share === "function";

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 p-4 sm:p-6">
      <header>
        <h1 className="text-2xl font-bold tracking-tight">Refer a friend</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Share your code. When a friend signs up and qualifies, you earn a reward credit.
        </p>
      </header>

      {/* Code and share */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <Gift className="h-5 w-5" aria-hidden="true" />
            Your referral code
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {summaryState.status === "loading" && (
            <>
              <LoadingAnnouncer label="Loading your referral code" />
              <div className="h-12 w-full animate-pulse rounded-md bg-muted" />
            </>
          )}

          {summaryState.status === "error" && (
            <ErrorState
              title="Could not load your referral code"
              onRetry={retrySummary}
            />
          )}

          {summary && (
            <>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                <code
                  data-testid="referral-code"
                  className="flex-1 rounded-md border bg-muted px-4 py-3 font-mono text-lg tracking-widest"
                >
                  {summary.code}
                </code>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => copy(summary.code, "code")}
                  className="gap-2"
                >
                  {copied === "code" ? (
                    <Check className="h-4 w-4" aria-hidden="true" />
                  ) : (
                    <Copy className="h-4 w-4" aria-hidden="true" />
                  )}
                  {copied === "code" ? "Copied" : "Copy code"}
                </Button>
              </div>

              <div className="flex flex-col gap-3 sm:flex-row">
                {canNativeShare ? (
                  <Button
                    type="button"
                    onClick={() => handleNativeShare(summary)}
                    className="gap-2"
                  >
                    <Share2 className="h-4 w-4" aria-hidden="true" />
                    Share
                  </Button>
                ) : (
                  <>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => copy(summary.shareUrl, "link")}
                      className="gap-2"
                    >
                      {copied === "link" ? (
                        <Check className="h-4 w-4" aria-hidden="true" />
                      ) : (
                        <Copy className="h-4 w-4" aria-hidden="true" />
                      )}
                      {copied === "link" ? "Link copied" : "Copy link"}
                    </Button>
                    <Button asChild variant="outline" className="gap-2">
                      <a
                        href={`https://wa.me/?text=${encodeURIComponent(
                          `Join Shelterflex with my referral code ${summary.code}: ${summary.shareUrl}`,
                        )}`}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        <MessageCircle className="h-4 w-4" aria-hidden="true" />
                        Share on WhatsApp
                      </a>
                    </Button>
                  </>
                )}
              </div>

              <p aria-live="polite" className="text-sm text-muted-foreground">
                {copyError ?? ""}
              </p>
            </>
          )}
        </CardContent>
      </Card>

      {/* Stats */}
      <section aria-labelledby="referral-stats-heading" className="grid gap-4 sm:grid-cols-3">
        <h2 id="referral-stats-heading" className="sr-only">
          Referral statistics
        </h2>
        {summaryState.status === "loading" && (
          <>
            <StatCardSkeleton />
            <StatCardSkeleton />
            <StatCardSkeleton />
          </>
        )}
        {summaryState.status === "error" && (
          <p className="text-sm text-muted-foreground sm:col-span-3">
            Statistics are unavailable right now.
          </p>
        )}
        {summary && (
          <>
            <Card>
              <CardContent className="pt-6">
                <p className="text-sm text-muted-foreground">Referred</p>
                <p className="mt-1 flex items-center gap-2 text-2xl font-semibold">
                  <Users className="h-5 w-5" aria-hidden="true" />
                  {summary.stats.referredCount}
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-6">
                <p className="text-sm text-muted-foreground">Credited</p>
                <p className="mt-1 text-2xl font-semibold">{summary.stats.creditedCount}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-6">
                <p className="text-sm text-muted-foreground">Pending reward</p>
                <p className="mt-1 text-2xl font-semibold">
                  <MoneyValue
                    status="ready"
                    amount={summary.stats.pendingRewardTotal}
                    format={(n) => formatNgn(n)}
                  />
                </p>
              </CardContent>
            </Card>
          </>
        )}
      </section>

      {/* Conversions */}
      <section aria-labelledby="referral-conversions-heading" className="space-y-3">
        <h2 id="referral-conversions-heading" className="text-lg font-semibold">
          Your referrals
        </h2>

        {conversionsState.status === "loading" && (
          <div className="space-y-2">
            <LoadingAnnouncer label="Loading your referrals" />
            <ListRowSkeleton />
            <ListRowSkeleton />
            <ListRowSkeleton />
          </div>
        )}

        {conversionsState.status === "error" && (
          <ErrorState
            title="Could not load your referrals"
            onRetry={retryConversions}
          />
        )}

        {conversionsState.status === "ready" &&
          conversionsState.data.conversions.length === 0 && (
            <EmptyState
              icon={Users}
              title="No referrals yet"
              description="Share your code with a friend. They will show up here once they sign up."
            />
          )}

        {conversionsState.status === "ready" &&
          conversionsState.data.conversions.length > 0 && (
            <>
              <ul className="divide-y rounded-lg border">
                {conversionsState.data.conversions.map((item: ReferralConversion) => (
                  <li key={item.id} className="flex items-center justify-between gap-3 p-4">
                    <div>
                      <p className="font-medium">{item.referredName}</p>
                      <p className="text-xs text-muted-foreground">
                        {new Date(item.createdAt).toLocaleDateString()}
                      </p>
                    </div>
                    <Badge variant="outline">{STATUS_LABEL[item.status] ?? item.status}</Badge>
                  </li>
                ))}
              </ul>

              <nav aria-label="Referrals pagination" className="flex items-center justify-between">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={page <= 1}
                  onClick={() => {
                    setConversionsState({ status: "loading" });
                    setPage((p) => Math.max(1, p - 1));
                  }}
                >
                  Previous
                </Button>
                <span className="text-sm text-muted-foreground">
                  Page {conversionsState.data.pagination.page} of{" "}
                  {Math.max(1, conversionsState.data.pagination.totalPages)}
                </span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={page >= conversionsState.data.pagination.totalPages}
                  onClick={() => {
                    setConversionsState({ status: "loading" });
                    setPage((p) => p + 1);
                  }}
                >
                  Next
                </Button>
              </nav>
            </>
          )}
      </section>
    </div>
  );
}
