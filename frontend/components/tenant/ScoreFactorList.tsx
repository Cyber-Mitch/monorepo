"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { AlertCircle, CheckCircle, XCircle } from "lucide-react";
import type { CreditScoreFactor } from "@/lib/creditScoreApi";

interface ScoreFactorListProps {
  factors: CreditScoreFactor[];
}

export function ScoreFactorList({ factors }: ScoreFactorListProps) {
  if (!factors || factors.length === 0) return null;

  const getIcon = (status: CreditScoreFactor["status"]) => {
    if (status === "pass") return <CheckCircle className="h-5 w-5 text-green-600" />;
    if (status === "fail") return <XCircle className="h-5 w-5 text-red-600" />;
    return <AlertCircle className="h-5 w-5 text-yellow-600" />;
  };

  const getVariant = (status: CreditScoreFactor["status"]) => {
    if (status === "pass") return "default" as const;
    if (status === "fail") return "destructive" as const;
    return "secondary" as const;
  };

  return (
    <Card className="border-3 border-foreground shadow-[4px_4px_0px_0px_rgba(26,26,26,1)]">
      <CardHeader>
        <CardTitle className="text-xl font-black">Score Factors</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {factors.map((factor, index) => (
          <div
            key={index}
            className="flex flex-col gap-2 border-b-2 border-foreground/10 pb-4 last:border-b-0 last:pb-0 sm:flex-row sm:items-start sm:justify-between"
          >
            <div className="flex items-start gap-3">
              <div className="mt-0.5 shrink-0">{getIcon(factor.status)}</div>
              <div className="space-y-1">
                <p className="font-bold">{factor.name}</p>
                <p className="text-sm text-muted-foreground">{factor.detail}</p>
              </div>
            </div>
            <div className="flex items-center gap-2 self-start">
              <Badge variant={getVariant(factor.status)} className="font-bold">
                Weight: {factor.weight}%
              </Badge>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
