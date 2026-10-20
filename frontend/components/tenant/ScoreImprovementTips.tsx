"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Lightbulb } from "lucide-react";

interface ScoreImprovementTipsProps {
  tips: string[];
}

export function ScoreImprovementTips({ tips }: ScoreImprovementTipsProps) {
  if (!tips || tips.length === 0) return null;

  return (
    <Card className="border-3 border-foreground shadow-[4px_4px_0px_0px_rgba(26,26,26,1)]">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-xl font-black">
          <Lightbulb className="h-5 w-5" />
          Improvement Tips
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="space-y-3">
          {tips.map((tip, index) => (
            <li key={index} className="flex items-start gap-2">
              <span className="mt-1 h-1.5 w-1.5 rounded-full bg-primary" aria-hidden="true" />
              <span className="text-sm leading-relaxed">{tip}</span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
