"use client";

import { InspectorDashboardShell } from "@/components/inspector/InspectorDashboardShell";
import { InspectorMyJobs } from "@/components/inspector/InspectorMyJobs";

export default function InspectorMyJobsPage() {
  return (
    <InspectorDashboardShell>
      <div>
        <h1 className="font-mono text-2xl font-black">My Jobs</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Everything you have claimed, with claim deadlines and review outcomes.
        </p>
      </div>
      <InspectorMyJobs />
    </InspectorDashboardShell>
  );
}
