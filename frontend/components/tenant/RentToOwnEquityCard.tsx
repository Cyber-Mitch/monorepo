import {
  AlertTriangle,
  CloudOff,
  ExternalLink,
  ShieldCheck,
} from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { MoneyValue } from "@/components/ui/data-state";
import { Progress } from "@/components/ui/progress";
import { formatUsdc } from "@/lib/currency";
import { formatDate } from "@/lib/date";
import {
  stellarExplorerContractUrl,
  type RentToOwnEquity,
} from "@/lib/rentToOwnApi";

function toAmount(value: string | null): number | null {
  if (value === null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function OnChainStatus({ onChain }: { onChain: RentToOwnEquity["onChain"] }) {
  const explorerUrl = stellarExplorerContractUrl(
    onChain.contractId,
    onChain.network,
  );

  if (onChain.status === "consistent") {
    const badge = (
      <Badge className="border-2 border-foreground bg-green-600 px-2 py-1 text-sm font-bold text-white">
        <ShieldCheck aria-hidden="true" />
        Verified on-chain
      </Badge>
    );
    return (
      <div
        className="flex flex-wrap items-center gap-2"
        data-testid="onchain-verified"
      >
        {explorerUrl ? (
          <a
            href={explorerUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            aria-label="Verified on-chain — view the rent-to-own contract on Stellar Expert (opens in a new tab)"
          >
            {badge}
            <ExternalLink className="h-4 w-4" aria-hidden="true" />
          </a>
        ) : (
          badge
        )}
        {onChain.checkedAt ? (
          <span className="text-xs text-muted-foreground">
            Checked {formatDate(onChain.checkedAt)}
          </span>
        ) : null}
      </div>
    );
  }

  if (onChain.status === "mismatch") {
    return (
      <Alert
        variant="destructive"
        className="border-2"
        data-testid="onchain-mismatch"
      >
        <AlertTriangle aria-hidden="true" />
        <AlertTitle>Equity could not be verified on-chain</AlertTitle>
        <AlertDescription>
          <p>
            The equity recorded by Shelterflex does not match the rent-to-own
            contract. Your payments are safe — our team has been alerted and
            will reconcile the records. Please don&apos;t rely on this figure
            until it is verified.
          </p>
          {explorerUrl ? (
            <a
              href={explorerUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 font-semibold underline underline-offset-2"
            >
              View contract on Stellar Expert
              <ExternalLink className="h-3 w-3" aria-hidden="true" />
              <span className="sr-only">(opens in a new tab)</span>
            </a>
          ) : null}
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <div
      role="status"
      data-testid="onchain-unavailable"
      className="flex items-start gap-2 rounded-lg border-2 border-dashed border-foreground/40 p-3 text-sm text-muted-foreground"
    >
      <CloudOff className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <p>
        On-chain verification is temporarily unavailable. The figures below come
        from Shelterflex records and will be re-checked automatically.
      </p>
    </div>
  );
}

export function RentToOwnEquityCard({ equity }: { equity: RentToOwnEquity }) {
  const percent = Math.min(100, Math.max(0, equity.equityPercentageBps / 100));
  const percentLabel = `${percent.toFixed(percent % 1 === 0 ? 0 : 2)}%`;
  const paymentsPercent =
    equity.paymentsRequired > 0
      ? Math.min(100, (equity.paymentsRecorded / equity.paymentsRequired) * 100)
      : 0;

  return (
    <Card className="border-3 border-foreground shadow-[4px_4px_0px_0px_rgba(26,26,26,1)]">
      <CardHeader className="gap-3">
        <CardTitle>
          <h2 className="text-xl font-bold">Your equity</h2>
        </CardTitle>
        <OnChainStatus onChain={equity.onChain} />
      </CardHeader>

      <CardContent className="space-y-6">
        <section aria-labelledby="equity-share-heading" className="space-y-2">
          <div className="flex flex-wrap items-end justify-between gap-2">
            <div>
              <h3
                id="equity-share-heading"
                className="text-sm font-medium text-muted-foreground"
              >
                Equity owned
              </h3>
              <p
                className="text-4xl font-black"
                data-testid="equity-percentage"
              >
                {percentLabel}
              </p>
            </div>
            <div className="text-right">
              <p className="text-sm text-muted-foreground">Equity amount</p>
              <MoneyValue
                status="ready"
                amount={toAmount(equity.equityAccumulatedUsdc)}
                format={formatUsdc}
                className="text-xl font-bold"
              />
              <p className="text-xs text-muted-foreground">
                of{" "}
                <MoneyValue
                  status="ready"
                  amount={toAmount(equity.propertyValueUsdc)}
                  format={formatUsdc}
                />{" "}
                property value
              </p>
            </div>
          </div>
          <Progress
            value={percent}
            aria-label={`Equity owned: ${percentLabel} of the property`}
            className="h-3"
          />
        </section>

        <dl className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2 rounded-lg border-2 border-foreground p-4">
            <dt className="text-sm text-muted-foreground">Payments recorded</dt>
            <dd className="space-y-2">
              <p className="text-2xl font-bold" data-testid="payments-recorded">
                {equity.paymentsRecorded}{" "}
                <span className="text-base font-medium text-muted-foreground">
                  of {equity.paymentsRequired}
                </span>
              </p>
              <Progress
                value={paymentsPercent}
                aria-label={`${equity.paymentsRecorded} of ${equity.paymentsRequired} payments recorded`}
              />
            </dd>
          </div>
          <div className="space-y-2 rounded-lg border-2 border-foreground p-4">
            <dt className="text-sm text-muted-foreground">
              Projected completion
            </dt>
            <dd
              className="text-2xl font-bold"
              data-testid="projected-completion"
            >
              {equity.projectedCompletionDate
                ? formatDate(equity.projectedCompletionDate)
                : "Not yet projected"}
            </dd>
          </div>
        </dl>
      </CardContent>
    </Card>
  );
}
