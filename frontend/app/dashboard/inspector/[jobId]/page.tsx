"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { EmptyState } from "@/components/ui/data-state";
import { InspectorDashboardShell } from "@/components/inspector/InspectorDashboardShell";
import { InspectorReportForm, type JobMeta } from "@/components/inspector/InspectorReportForm";
import { listMyJobs } from "@/lib/inspectorApi";

/**
 * Report form for one claimed job (#1921). The job must be live-claimed by the
 * caller; anything else comes back as an error from the API at submit time.
 */
export default function InspectorJobReportPage() {
  const params = useParams<{ jobId: string }>();
  const jobId = typeof params?.jobId === "string" ? params.jobId : "";
  const [job, setJob] = useState<JobMeta | null>(null);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const mine = await listMyJobs();
        const match = mine.find((candidate) => candidate.id === jobId);
        if (cancelled) return;
        if (!match || !["claimed", "in_progress"].includes(match.status)) {
          setNotFound(true);
        } else {
          setJob({ id: match.id, claimDeadline: match.claimDeadline });
        }
      } catch {
        if (!cancelled) setNotFound(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [jobId]);

  return (
    <InspectorDashboardShell>
      <div>
        <h1 className="font-mono text-2xl font-black">Inspection report</h1>
        {job?.claimDeadline && (
          <p className="mt-1 text-sm text-muted-foreground">
            Submit before{" "}
            {new Date(job.claimDeadline).toLocaleString(undefined, {
              dateStyle: "medium",
              timeStyle: "short",
            })}
            .
          </p>
        )}
      </div>
      {notFound ? (
        <EmptyState
          title="This job is not awaiting your report"
          description="The claim may have expired or the job was already submitted. Check My Jobs for its current state."
        />
      ) : job ? (
        <InspectorReportForm job={job} />
      ) : (
        <p role="status" className="text-sm text-muted-foreground">
          Loading job…
        </p>
      )}
    </InspectorDashboardShell>
  );
}
