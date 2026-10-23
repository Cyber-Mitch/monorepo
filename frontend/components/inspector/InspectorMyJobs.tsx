"use client";

/**
 * "My jobs" list for inspectors (#1921): claimed / in-progress / submitted /
 * approved / rejected with the claim-deadline countdown on live claims.
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ClipboardList } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  EmptyState,
  ErrorState,
  ListRowSkeleton,
  LoadingState,
} from "@/components/ui/data-state";
import { listMyJobs, type InspectionJobStatus, type InspectorJob } from "@/lib/inspectorApi";

const STATUS_LABELS: Record<InspectionJobStatus, string | null> = {
  available: null,
  claimed: "Claimed",
  in_progress: "In progress",
  submitted: "Submitted",
  approved: "Approved",
  rejected: "Rejected",
};

const FILTERS: Array<{ key: "all" | InspectionJobStatus; label: string }> = [
  { key: "all", label: "All" },
  { key: "claimed", label: "Claimed" },
  { key: "in_progress", label: "In progress" },
  { key: "submitted", label: "Submitted" },
  { key: "approved", label: "Approved" },
  { key: "rejected", label: "Rejected" },
];

function isClaimLive(job: InspectorJob): boolean {
  return (
    (job.status === "claimed" || job.status === "in_progress") &&
    job.claimDeadline !== null &&
    new Date(job.claimDeadline).getTime() > Date.now()
  );
}

export function ClaimCountdown({ deadline }: { deadline: string }) {
  const [label, setLabel] = useState<string>("");

  useEffect(() => {
    const target = new Date(deadline).getTime();
    function tick() {
      const remainingMs = target - Date.now();
      if (remainingMs <= 0) {
        setLabel("Claim expired");
        return;
      }
      const minutes = Math.floor(remainingMs / 60000);
      const hours = Math.floor(minutes / 60);
      setLabel(hours > 0 ? `${hours}h ${minutes % 60}m left` : `${minutes}m left`);
    }
    tick();
    const timer = setInterval(tick, 30_000);
    return () => clearInterval(timer);
  }, [deadline]);

  return (
    <span role="timer" aria-label={`Time left on claim: ${label}`}>
      {label}
    </span>
  );
}

export function InspectorMyJobs() {
  const [jobs, setJobs] = useState<InspectorJob[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | InspectionJobStatus>("all");

  const loadJobs = useCallback(async () => {
    // No synchronous setState here: everything lands after `await`, so the
    // mount effect never triggers a cascading render (react-hooks/set-state-in-effect).
    try {
      setJobs(await listMyJobs());
      setError(null);
    } catch (loadError) {
      setError(
        loadError instanceof Error ? loadError.message : "Unable to load your jobs.",
      );
    }
  }, []);

  const retry = useCallback(() => {
    setJobs(null);
    setError(null);
    void loadJobs();
  }, [loadJobs]);

  useEffect(() => {
    // Deferred like tenant-rewards-summary-card: scheduling the load avoids
    // any synchronous setState during the effect itself.
    const timer = setTimeout(() => {
      void loadJobs();
    }, 0);
    return () => clearTimeout(timer);
  }, [loadJobs]);

  if (error) {
    return <ErrorState title="Could not load your jobs" description={error} onRetry={retry} />;
  }

  if (jobs === null) {
    return (
      <LoadingState label="Loading your claimed jobs" className="space-y-3">
        <ListRowSkeleton />
        <ListRowSkeleton />
      </LoadingState>
    );
  }

  const visible =
    filter === "all" ? jobs : jobs.filter((job) => job.status === filter);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2" role="tablist" aria-label="Filter my jobs by status">
        {FILTERS.map((f) => (
          <Button
            key={f.key}
            type="button"
            role="tab"
            aria-selected={filter === f.key}
            variant={filter === f.key ? "default" : "outline"}
            className="border-3 border-foreground font-bold"
            onClick={() => setFilter(f.key)}
          >
            {f.label}
          </Button>
        ))}
      </div>

      {visible.length === 0 ? (
        <EmptyState
          icon={ClipboardList}
          title="No jobs here yet"
          description={
            filter === "all"
              ? "Claim a job on the Job Board and it will show up here with its claim deadline."
              : `You have no ${STATUS_LABELS[filter]?.toLowerCase() ?? ""} jobs.`
          }
        />
      ) : (
        <ul className="space-y-3">
          {visible.map((job) => (
            <li key={job.id}>
              <div className="flex flex-col gap-3 border-3 border-foreground bg-card p-4 shadow-[4px_4px_0px_0px_rgba(26,26,26,1)] sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge className="border-2 border-foreground font-bold">
                      {STATUS_LABELS[job.status] ?? job.status}
                    </Badge>
                    {(isClaimLive(job) || job.claimDeadline) && job.claimDeadline && (
                      <span className="text-sm font-bold">
                        {isClaimLive(job) ? <ClaimCountdown deadline={job.claimDeadline} /> : null}
                      </span>
                    )}
                  </div>
                  <p className="mt-2 truncate text-sm text-muted-foreground" title={job.listingId}>
                    {job.listingArea ? `${job.listingArea} · ` : ""}listing {job.listingId.slice(0, 12)}…
                  </p>
                  {job.status === "rejected" && job.rejectionReason && (
                    <p className="mt-2 border-2 border-destructive bg-destructive/10 p-2 text-sm font-bold text-destructive" role="note">
                      Rejection reason: {job.rejectionReason}
                    </p>
                  )}
                </div>
                {(job.status === "claimed" || job.status === "in_progress") && (
                  <Button asChild className="border-3 border-foreground font-bold shadow-[4px_4px_0px_0px_rgba(26,26,26,1)]">
                    <Link href={`/dashboard/inspector/${job.id}`}>Continue report</Link>
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
