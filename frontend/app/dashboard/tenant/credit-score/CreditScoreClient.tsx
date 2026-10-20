"use client";

import { useState, useEffect, useCallback } from "react";
import {
  getCreditScore,
  getCreditScoreHistory,
  type CreditScoreResponse,
  type CreditScoreHistoryItem,
} from "@/lib/creditScoreApi";
import { CreditScoreGauge } from "@/components/tenant/CreditScoreGauge";
import { ScoreFactorList } from "@/components/tenant/ScoreFactorList";
import { ScoreHistoryChart } from "@/components/tenant/ScoreHistoryChart";
import { ScoreImprovementTips } from "@/components/tenant/ScoreImprovementTips";
import { LoadingState, ErrorState, EmptyState } from "@/components/ui/data-state";
import { FileSearch } from "lucide-react";

export function CreditScoreClient() {
  const [scoreData, setScoreData] = useState<CreditScoreResponse["data"] | null>(null);
  const [history, setHistory] = useState<CreditScoreHistoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [scoreRes, historyRes] = await Promise.all([
        getCreditScore(),
        getCreditScoreHistory(10),
      ]);
      setScoreData(scoreRes.data);
      setHistory(historyRes.data || []);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to load credit score";
      setError(message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  if (loading) {
    return <LoadingState label="Loading credit score" />;
  }

  if (error) {
    return <ErrorState onRetry={loadData} description={error} />;
  }

  if (!scoreData) {
    return (
      <EmptyState
        icon={FileSearch}
        title="Not scored yet"
        description="You need to complete an application to get your credit score. Scoring happens during the application underwriting process."
        action={{ label: "Browse Properties", href: "/properties" }}
      />
    );
  }

  return (
    <div className="container mx-auto max-w-6xl space-y-6 px-4 py-6 sm:px-6">
      <div>
        <h1 className="text-3xl font-black tracking-tight sm:text-4xl">Credit Score</h1>
        <p className="mt-1 text-muted-foreground">
          View your credit score, factors, and improvement tips.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-1">
          <CreditScoreGauge
            score={scoreData.score}
            band={scoreData.band}
            computedAt={scoreData.computedAt}
          />
        </div>
        <div className="lg:col-span-2">
          <ScoreFactorList factors={scoreData.factors} />
        </div>
      </div>

      <ScoreHistoryChart history={history} />

      <ScoreImprovementTips tips={scoreData.tips} />
    </div>
  );
}
