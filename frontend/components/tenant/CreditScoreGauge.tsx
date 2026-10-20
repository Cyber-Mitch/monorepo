"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { CreditScoreBand } from "@/lib/creditScoreApi";

interface CreditScoreGaugeProps {
  score: number;
  band: CreditScoreBand;
  computedAt: string;
}

export function CreditScoreGauge({ score, band, computedAt }: CreditScoreGaugeProps) {
  const getBandColor = (band: CreditScoreBand) => {
    if (band === "excellent") return "bg-green-100 text-green-800 border-green-500";
    if (band === "good") return "bg-blue-100 text-blue-800 border-blue-500";
    if (band === "fair") return "bg-yellow-100 text-yellow-800 border-yellow-500";
    return "bg-red-100 text-red-800 border-red-500";
  };

  return (
    <Card className="border-3 border-foreground shadow-[4px_4px_0px_0px_rgba(26,26,26,1)]">
      <CardHeader>
        <CardTitle className="text-xl font-black">Credit Score</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col items-center justify-center py-8">
        <div className="relative mb-6">
          <div className="flex h-32 w-32 items-center justify-center rounded-full border-[12px] border-muted">
            <span className="text-4xl font-black">{score}</span>
          </div>
        </div>
        <Badge variant="outline" className={`mb-3 border-2 px-4 py-1 text-lg font-black capitalize ${getBandColor(band)}`}>
          {band}
        </Badge>
        <p className="text-sm text-muted-foreground">
          Last computed: {new Date(computedAt).toLocaleString()}
        </p>
      </CardContent>
    </Card>
  );
}
