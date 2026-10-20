"use client";

import { useCallback, useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { ExternalLink, Loader2, Vote } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  EmptyState,
  ErrorState,
  LoadingAnnouncer,
  ListRowSkeleton,
} from "@/components/ui/data-state";
import { useFeatureFlag } from "@/lib/featureFlags";
import {
  executeProposal,
  explorerTxUrl,
  finalizeProposal,
  getGovernanceConfig,
  listProposals,
  prepareProposal,
  prepareVote,
  submitProposal,
  submitVote,
  type Proposal,
  type ProposalStatus,
} from "@/lib/governanceApi";
import { describeGovernanceError, signGovernanceXdr } from "@/lib/governanceWallet";

const STATUS_FILTERS: { value: ProposalStatus | "all"; label: string }[] = [
  { value: "all", label: "All" },
  { value: "active", label: "Active" },
  { value: "passed", label: "Passed" },
  { value: "failed", label: "Failed" },
  { value: "executed", label: "Executed" },
];

const createSchema = z.object({
  parameterKey: z
    .string()
    .trim()
    .min(1, "Enter the parameter key.")
    .max(64, "Keep the parameter key under 64 characters."),
  proposedValue: z
    .string()
    .trim()
    .min(1, "Enter the proposed value.")
    .max(256, "Keep the proposed value under 256 characters."),
});

type CreateValues = z.infer<typeof createSchema>;

type ListState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; proposals: Proposal[] };

/** Per-action feedback: pending, a success tx hash, or an error message. */
type ActionState =
  | { status: "idle" }
  | { status: "pending" }
  | { status: "done"; txHash: string }
  | { status: "error"; message: string };

function formatDeadline(iso: string): string {
  const end = new Date(iso);
  const ms = end.getTime() - Date.now();
  if (Number.isNaN(end.getTime())) return "Deadline unavailable";
  if (ms <= 0) return "Voting closed";
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  return `Closes in ${hours}h ${minutes}m`;
}

function VoteBar({ votesFor, votesAgainst }: { votesFor: number; votesAgainst: number }) {
  const total = votesFor + votesAgainst;
  const forPct = total === 0 ? 0 : Math.round((votesFor / total) * 100);
  return (
    <div
      role="img"
      aria-label={`${votesFor} for, ${votesAgainst} against (${forPct}% for)`}
      className="flex h-2 w-full overflow-hidden rounded-full bg-muted"
    >
      <div className="h-full bg-emerald-500" style={{ width: `${forPct}%` }} />
      <div className="h-full bg-rose-500" style={{ width: `${100 - forPct}%` }} />
    </div>
  );
}

function QuorumIndicator({ proposal }: { proposal: Proposal }) {
  const cast = proposal.votesFor + proposal.votesAgainst;
  const reached = cast >= proposal.quorumVotes;
  return (
    <p className="text-xs text-muted-foreground">
      Quorum {cast} / {proposal.quorumVotes}{" "}
      <span className={reached ? "text-emerald-600" : ""}>
        {reached ? "reached" : "not reached"}
      </span>
    </p>
  );
}

function TxResult({ txHash }: { txHash: string }) {
  return (
    <p className="text-sm">
      Submitted.{" "}
      <a
        href={explorerTxUrl(txHash)}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 underline"
      >
        View transaction <ExternalLink className="h-3 w-3" aria-hidden="true" />
      </a>
    </p>
  );
}

export function GovernanceClient() {
  const governanceEnabled = useFeatureFlag("GOVERNANCE_ENABLED");

  const [statusFilter, setStatusFilter] = useState<ProposalStatus | "all">("all");
  const [listState, setListState] = useState<ListState>({ status: "loading" });
  const [reloadToken, setReloadToken] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [action, setAction] = useState<ActionState>({ status: "idle" });
  const [minStake, setMinStake] = useState<number | null>(null);

  const createForm = useForm<CreateValues>({
    resolver: zodResolver(createSchema),
    defaultValues: { parameterKey: "", proposedValue: "" },
  });

  useEffect(() => {
    if (!governanceEnabled) return;
    let cancelled = false;
    listProposals({ status: statusFilter })
      .then((res) => {
        if (!cancelled) setListState({ status: "ready", proposals: res.proposals });
      })
      .catch(() => {
        if (!cancelled) setListState({ status: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [governanceEnabled, statusFilter, reloadToken]);

  useEffect(() => {
    if (!governanceEnabled) return;
    let cancelled = false;
    getGovernanceConfig()
      .then((cfg) => {
        if (!cancelled) setMinStake(cfg.minStakeToPropose);
      })
      .catch(() => {
        // Leave as null: the requirement is shown as unavailable, not as 0.
      });
    return () => {
      cancelled = true;
    };
  }, [governanceEnabled]);

  const retryList = useCallback(() => {
    setListState({ status: "loading" });
    setReloadToken((t) => t + 1);
  }, []);

  const runSignedAction = useCallback(
    async (
      prepare: () => Promise<{ xdr: string }>,
      submit: (signedXdr: string) => Promise<{ txHash: string }>,
    ) => {
      setAction({ status: "pending" });
      try {
        const { xdr } = await prepare();
        const signed = await signGovernanceXdr(xdr);
        const { txHash } = await submit(signed);
        setAction({ status: "done", txHash });
        setReloadToken((t) => t + 1);
      } catch (err) {
        setAction({ status: "error", message: describeGovernanceError(err) });
      }
    },
    [],
  );

  const runServerAction = useCallback(async (run: () => Promise<{ txHash: string }>) => {
    setAction({ status: "pending" });
    try {
      const { txHash } = await run();
      setAction({ status: "done", txHash });
      setReloadToken((t) => t + 1);
    } catch (err) {
      setAction({ status: "error", message: describeGovernanceError(err) });
    }
  }, []);

  const handleVote = (proposal: Proposal, support: boolean) =>
    runSignedAction(
      () => prepareVote(proposal.id, support),
      (signed) => submitVote(proposal.id, signed),
    );

  const handleCreate = createForm.handleSubmit((values) =>
    runSignedAction(
      () => prepareProposal(values),
      (signed) => submitProposal(signed),
    ),
  );

  if (!governanceEnabled) {
    return (
      <div className="mx-auto max-w-3xl p-6">
        <EmptyState
          icon={Vote}
          title="Governance is not available yet"
          description="Proposals and voting will open here once governance is enabled for this platform."
        />
      </div>
    );
  }

  const selected =
    listState.status === "ready"
      ? listState.proposals.find((p) => p.id === selectedId) ?? null
      : null;

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 p-4 sm:p-6">
      <header>
        <h1 className="text-2xl font-bold tracking-tight">Governance</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Stakers vote on platform parameters. Your vote is signed with your connected wallet.
        </p>
      </header>

      {/* Filter */}
      <div className="flex items-center gap-3">
        <Label htmlFor="proposal-status">Status</Label>
        <select
          id="proposal-status"
          className="rounded-md border bg-background px-3 py-2 text-sm"
          value={statusFilter}
          onChange={(e) => {
            setListState({ status: "loading" });
            setStatusFilter(e.target.value as ProposalStatus | "all");
          }}
        >
          {STATUS_FILTERS.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>
      </div>

      {/* List */}
      {listState.status === "loading" && (
        <div className="space-y-2">
          <LoadingAnnouncer label="Loading proposals" />
          <ListRowSkeleton />
          <ListRowSkeleton />
        </div>
      )}

      {listState.status === "error" && (
        <ErrorState title="Could not load proposals" onRetry={retryList} />
      )}

      {listState.status === "ready" && listState.proposals.length === 0 && (
        <EmptyState
          icon={Vote}
          title="No proposals match this filter"
          description="Try another status, or create the first proposal below."
        />
      )}

      {listState.status === "ready" && listState.proposals.length > 0 && (
        <ul className="space-y-3">
          {listState.proposals.map((p) => (
            <li key={p.id}>
              <Card>
                <CardContent className="space-y-3 pt-6">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="font-mono text-sm">{p.parameterKey}</p>
                    <Badge variant="outline">{p.status}</Badge>
                  </div>
                  <p className="text-sm">
                    Proposed value: <span className="font-medium">{p.proposedValue}</span>
                  </p>
                  <VoteBar votesFor={p.votesFor} votesAgainst={p.votesAgainst} />
                  <p className="text-xs text-muted-foreground">
                    For {p.votesFor} · Against {p.votesAgainst} · {formatDeadline(p.votingEndsAt)}
                  </p>
                  <QuorumIndicator proposal={p} />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    aria-expanded={selectedId === p.id}
                    onClick={() => {
                      setAction({ status: "idle" });
                      setSelectedId(selectedId === p.id ? null : p.id);
                    }}
                  >
                    {selectedId === p.id ? "Close" : "Open"} proposal
                  </Button>
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      )}

      {/* Detail and vote */}
      {selected && (
        <Card aria-live="polite">
          <CardHeader>
            <CardTitle className="text-lg">Vote on {selected.parameterKey}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {selected.status === "active" && !selected.hasVoted && (
              <div className="flex flex-wrap gap-3">
                <Button
                  type="button"
                  disabled={action.status === "pending"}
                  onClick={() => handleVote(selected, true)}
                >
                  Vote for
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={action.status === "pending"}
                  onClick={() => handleVote(selected, false)}
                >
                  Vote against
                </Button>
              </div>
            )}
            {selected.hasVoted && (
              <p className="text-sm text-muted-foreground">You have already voted on this proposal.</p>
            )}

            {selected.canFinalize && (
              <Button
                type="button"
                variant="outline"
                disabled={action.status === "pending"}
                onClick={() => runServerAction(() => finalizeProposal(selected.id))}
              >
                Finalize
              </Button>
            )}
            {selected.canExecute && (
              <Button
                type="button"
                variant="outline"
                disabled={action.status === "pending"}
                onClick={() => runServerAction(() => executeProposal(selected.id))}
              >
                Execute
              </Button>
            )}

            {action.status === "pending" && (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                Waiting for your wallet and the network…
              </p>
            )}
            {action.status === "done" && <TxResult txHash={action.txHash} />}
            {action.status === "error" && (
              <p role="alert" className="text-sm text-destructive">
                {action.message}
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {/* Create */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Create a proposal</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleCreate} className="space-y-4" noValidate>
            <p className="text-sm text-muted-foreground">
              Minimum stake to propose:{" "}
              <span className="font-medium">
                {minStake === null ? "Unavailable" : minStake}
              </span>
            </p>
            <div className="space-y-2">
              <Label htmlFor="parameter-key">Parameter key</Label>
              <Input
                id="parameter-key"
                aria-invalid={!!createForm.formState.errors.parameterKey}
                aria-describedby={
                  createForm.formState.errors.parameterKey ? "parameter-key-error" : undefined
                }
                {...createForm.register("parameterKey")}
              />
              {createForm.formState.errors.parameterKey && (
                <p id="parameter-key-error" className="text-sm text-destructive">
                  {createForm.formState.errors.parameterKey.message}
                </p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="proposed-value">Proposed value</Label>
              <Input
                id="proposed-value"
                aria-invalid={!!createForm.formState.errors.proposedValue}
                aria-describedby={
                  createForm.formState.errors.proposedValue ? "proposed-value-error" : undefined
                }
                {...createForm.register("proposedValue")}
              />
              {createForm.formState.errors.proposedValue && (
                <p id="proposed-value-error" className="text-sm text-destructive">
                  {createForm.formState.errors.proposedValue.message}
                </p>
              )}
            </div>
            <Button type="submit" disabled={action.status === "pending"}>
              Sign and submit proposal
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
