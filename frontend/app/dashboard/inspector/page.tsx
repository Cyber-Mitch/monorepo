"use client";

import { InspectorDashboardShell } from "@/components/inspector/InspectorDashboardShell";
import { InspectorJobBoard } from "@/components/inspector/InspectorJobBoard";

export default function InspectorJobBoardPage() {
  // #1921: the whole area sits behind the INSPECTOR_DASHBOARD_ENABLED flag and
  // the inspector role — InspectorDashboardShell renders the gate.
  return (
    <InspectorDashboardShell>
      <div>
        <h1 className="font-mono text-2xl font-black">Job Board</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Claim an available inspection near you, then submit the report before the claim deadline.
        </p>
      </div>
      <InspectorJobBoard />
    </InspectorDashboardShell>
  );
}
