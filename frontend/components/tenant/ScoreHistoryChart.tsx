"use client";

import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { CreditScoreHistoryItem } from "@/lib/creditScoreApi";

interface ScoreHistoryChartProps {
  history: CreditScoreHistoryItem[];
}

function formatDate(dateString: string): string {
  try {
    return new Date(dateString).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return dateString;
  }
}

export function ScoreHistoryChart({ history }: ScoreHistoryChartProps) {
  if (!history || history.length === 0) {
    return null;
  }

  const chartData = history
    .slice()
    .reverse()
    .map((item) => ({
      date: formatDate(item.computedAt),
      score: item.score,
      fullDate: item.computedAt,
    }));

  return (
    <Card className="border-3 border-foreground shadow-[4px_4px_0px_0px_rgba(26,26,26,1)]">
      <CardHeader>
        <CardTitle className="text-xl font-black">Score History</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="h-64 w-full" role="img" aria-label="Line chart showing credit score history over time">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartData} margin={{ top: 5, right: 10, left: -10, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis
                dataKey="date"
                tick={{ fontSize: 12 }}
                stroke="hsl(var(--foreground))"
              />
              <YAxis
                domain={[0, 100]}
                tick={{ fontSize: 12 }}
                stroke="hsl(var(--foreground))"
              />
              <Tooltip
                contentStyle={{
                  border: "3px solid hsl(var(--foreground))",
                  borderRadius: 0,
                  backgroundColor: "hsl(var(--card))",
                  color: "hsl(var(--foreground))",
                }}
              />
              <Line
                type="monotone"
                dataKey="score"
                stroke="hsl(var(--primary))"
                strokeWidth={3}
                dot={{ fill: "hsl(var(--primary))", strokeWidth: 2, r: 5 }}
                activeDot={{ r: 7, stroke: "hsl(var(--primary))", strokeWidth: 2 }}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="font-black">Date</TableHead>
                <TableHead className="font-black text-right">Score</TableHead>
                <TableHead className="font-black text-right">Band</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {history.map((item) => (
                <TableRow key={item.id}>
                  <TableCell>{formatDate(item.computedAt)}</TableCell>
                  <TableCell className="text-right font-bold">{item.score}</TableCell>
                  <TableCell className="text-right capitalize">{item.band}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}
