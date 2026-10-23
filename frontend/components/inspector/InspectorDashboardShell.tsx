"use client";

/**
 * Shared shell for all inspector dashboard pages (#1921/#1922 gating): off
 * flag or a non-inspector role renders a quiet "not available" panel instead
 * of the feature. Everything behind it is keyboard-accessible and does not
 * render until the gate passes.
 */
import { DashboardHeader } from "@/components/dashboard-header";
import { DashboardSidebar } from "@/components/dashboard/DashboardSidebar";
import { EmptyState } from "@/components/ui/data-state";
import { ShieldAlert } from "lucide-react";
import { useFeatureFlag } from "@/lib/featureFlags";
import useAuthStore from "@/store/useAuthStore";
import type { ReactNode } from "react";

export function InspectorDashboardShell({ children }: { children: ReactNode }) {
  const enabled = useFeatureFlag("INSPECTOR_DASHBOARD_ENABLED");
  const user = useAuthStore((state) => state.user);
  const isInspector = user?.role === "inspector";
  const userName = user?.name?.trim() || "Inspector";

  if (!enabled || !isInspector) {
    return (
      <div className="min-h-screen bg-background">
        <DashboardHeader />
        <main id="main-content" className="mx-auto max-w-3xl px-4 py-10">
          <EmptyState
            icon={ShieldAlert}
            title="Inspector dashboard not available"
            description={
              enabled
                ? "This area is for accounts with the inspector role. Sign in with an inspector account, or apply through inspector onboarding."
                : "The inspector dashboard is switched off for now. Check back later."
            }
          />
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <DashboardHeader />
      <div className="mx-auto grid w-full max-w-7xl gap-6 px-4 py-6 md:grid-cols-[240px_minmax(0,1fr)]">
        <DashboardSidebar role="inspector" userInfo={{ name: userName, roleLabel: "Property Inspector" }} />
        <main id="dashboard-main-content" className="min-w-0 space-y-6">
          {children}
        </main>
      </div>
    </div>
  );
}
