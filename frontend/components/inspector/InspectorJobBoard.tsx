"use client";

/**
 * Job board for verified inspectors (#1921).
 *
 * One row per available inspection job: area, fee, listing summary and a
 * claim action. A lost claim race (HTTP 409) surfaces a clear message and
 * refreshes the board, so two inspectors looking at the same listing converge
 * on the truth instead of both seeing "available".
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Briefcase, MapPin, PartyPopper } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EmptyState, ErrorState, ListRowSkeleton, LoadingState, MoneyValue } from "@/components/ui/data-state";
import { claimJob, listAvailableJobs, type InspectorJob } from "@/lib/inspectorApi";
import { formatNgn } from "@/lib/currency";

export const CLAIM_LOST_MESSAGE =
  "This job was claimed by another inspector. The board below is the up-to-date picture.";

function listingSummary(job: InspectorJob): string {
  const shortId = job.listingId.length > 12 ? `${job.listingId.slice(0, 12)}…` : job.listingId;
  return job.listingArea ? `${job.listingArea} · listing ${shortId}` : `Listing ${shortId}`;
}

export function InspectorJobBoard() {
  const [jobs, setJobs] = useState<InspectorJob[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [claimingJobId, setClaimingJobId] = useState<string | null>(null);
  const [claimLost, setClaimLost] = useState(false);
  const [claimedJob, setClaimedJob] = useState<InspectorJob | null>(null);
  const boardRef = useRef<HTMLDivElement>(null);

  const loadJobs = useCallback(async () => {
    setJobs(null);
    setLoadError(null);
    try {
      setJobs(await listAvailableJobs());
    } catch (error) {
      setLoadError(
        error instanceof Error ? error.message : "Unable to load the inspection job board.",
      );
    }
  }, []);

  useEffect(() => {
    void loadJobs();
  }, [loadJobs]);

  const claim = useCallback(
    async (jobId: string) => {
      setClaimingJobId(jobId);
      setClaimLost(false);
      try {
        const claimed = await claimJob(jobId);
        setClaimedJob(claimed);
        // The claimed job leaves the available board — refresh to converge.
        await loadJobs();
      } catch (error) {
        setClaimLost(true);
        // Losing the race or any other failure: refresh the board either way.
        await loadJobs();
        boardRef.current?.scrollIntoView?.({ behavior: "smooth", block: "start" });
      } finally {
        setClaimingJobId(null);
      }
    },
    [loadJobs],
  );

  if (loadError) {
    return <ErrorState title="Could not load the job board" description={loadError} onRetry={() => void loadJobs()} />;
  }

  if (jobs === null) {
    return (
      <LoadingState label="Loading available inspection jobs" className="space-y-3">
        <ListRowSkeleton />
        <ListRowSkeleton />
        <ListRowSkeleton />
      </LoadingState>
    );
  }

  return (
    <div ref={boardRef} className="space-y-4">
      {claimLost && (
        <div role="alert" className="border-3 border-destructive bg-destructive/10 p-4 text-sm font-bold text-destructive">
          {CLAIM_LOST_MESSAGE}
        </div>
      )}
      {claimedJob && (
        <div role="status" className="flex items-start gap-3 border-3 border-foreground bg-primary/10 p-4 text-sm">
          <PartyPopper className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
          <div>
            <p className="font-bold">Job claimed!</p>
            <p>
              You have until{" "}
              {claimedJob.claimDeadline
                ? new Date(claimedJob.claimDeadline).toLocaleString(undefined, {
                    dateStyle: "medium",
                    timeStyle: "short",
                  })
                : "the deadline"}
              {" "}to submit the report.
            </p>
            <Button asChild className="mt-2" size="sm">
              <a href={`/dashboard/inspector/${claimedJob.id}`}>Start the report</a>
            </Button>
          </div>
        </div>
      )}

      {jobs.length === 0 ? (
        <EmptyState
          icon={Briefcase}
          title="No inspection jobs available"
          description="New listings that need verification will appear here once an admin creates them."
        />
      ) : (
        <ul className="space-y-3">
          {jobs.map((job) => (
            <li key={job.id}>
              <Card className="flex flex-col gap-4 border-3 border-foreground p-4 shadow-[4px_4px_0px_0px_rgba(26,26,26,1)] sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge className="border-2 border-foreground bg-muted text-xs font-bold">
                      <MapPin className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
                      {job.listingArea ?? "Area unavailable"}
                    </Badge>
                    <span className="font-bold font-mono">
                      <MoneyValue status="ready" amount={job.offeredFeeNgn} format={formatNgn} />
                    </span>
                    <span className="text-sm text-muted-foreground">offered fee</span>
                  </div>
                  <p className="mt-2 truncate text-sm text-muted-foreground" title={job.listingId}>
                    {listingSummary(job)}
                  </p>
                </div>
                <Button
                  type="button"
                  onClick={() => void claim(job.id)}
                  disabled={claimingJobId !== null}
                  className="border-3 border-foreground font-bold shadow-[4px_4px_0px_0px_rgba(26,26,26,1)]"
                >
                  {claimingJobId === job.id ? "Claiming…" : "Claim job"}
                </Button>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
