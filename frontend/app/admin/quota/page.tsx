"use client";

/**
 * Admin quota management (#1913).
 *
 * Stats header, user lookup (current usage + active overrides), override
 * create/remove, and usage reset. Destructive actions sit behind a
 * confirmation dialog. Results are announced through toasts. The backend
 * enforces admin access; a 403 is shown as an access-denied error state.
 */

import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Loader2, RotateCcw, Search, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState, EmptyState } from "@/components/ui/data-state";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { ApiError } from "@/lib/apiClient";
import {
  createQuotaOverride,
  fetchQuotaOverrides,
  fetchQuotaStats,
  fetchQuotaUsage,
  removeQuotaOverride,
  resetQuota,
  type QuotaOverride,
  type QuotaStats,
  type QuotaUsage,
} from "@/lib/quotaAdminApi";
import {
  quotaLookupSchema,
  quotaOverrideSchema,
  type QuotaLookupFormValues,
  type QuotaOverrideFormValues,
} from "@/lib/formSchemas";
import { showErrorToast, showSuccessToast } from "@/lib/toast";

type AsyncState<T> =
  | { status: "loading" }
  | { status: "error"; message: string; code?: number }
  | { status: "ready"; data: T };

type Target = { userId: string; endpoint?: string };

type UserDetail =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string; code?: number }
  | { status: "ready"; usage: QuotaUsage; overrides: QuotaOverride[] };

function describeError(err: unknown, fallback: string) {
  const code = err instanceof ApiError ? err.status : undefined;
  if (code === 403) {
    return { message: "Access denied — admin credentials required", code };
  }
  return { message: err instanceof Error && err.message ? err.message : fallback, code };
}

function formatTimestamp(value?: number) {
  return typeof value === "number" ? new Date(value).toLocaleString() : "—";
}

function FieldError({ message, id }: { message?: string; id: string }) {
  if (!message) return null;
  return (
    <p id={id} role="alert" className="text-sm text-destructive">
      {message}
    </p>
  );
}

export default function AdminQuotaPage() {
  const [stats, setStats] = useState<AsyncState<QuotaStats>>({ status: "loading" });
  const [statsReload, setStatsReload] = useState(0);
  const [target, setTarget] = useState<Target | null>(null);
  const [detail, setDetail] = useState<UserDetail>({ status: "idle" });
  const [overrideToRemove, setOverrideToRemove] = useState<QuotaOverride | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);

  const lookupForm = useForm<QuotaLookupFormValues>({
    resolver: zodResolver(quotaLookupSchema),
    mode: "onBlur",
    reValidateMode: "onBlur",
    shouldFocusError: true,
    defaultValues: { userId: "", endpoint: "" },
  });

  const overrideForm = useForm<QuotaOverrideFormValues>({
    resolver: zodResolver(quotaOverrideSchema),
    mode: "onBlur",
    reValidateMode: "onBlur",
    shouldFocusError: true,
    defaultValues: { endpoint: "", elevatedLimit: Number.NaN, reason: "", expiresAt: "" },
  });

  useEffect(() => {
    let cancelled = false;
    fetchQuotaStats()
      .then((data) => {
        if (!cancelled) setStats({ status: "ready", data });
      })
      .catch((err: unknown) => {
        if (!cancelled) setStats({ status: "error", ...describeError(err, "Failed to load quota stats") });
      });
    return () => {
      cancelled = true;
    };
  }, [statsReload]);

  const retryStats = () => {
    setStats({ status: "loading" });
    setStatsReload((n) => n + 1);
  };

  const loadUser = async (next: Target) => {
    setTarget(next);
    setDetail({ status: "loading" });
    try {
      const [usage, overrides] = await Promise.all([
        fetchQuotaUsage(next.userId, next.endpoint),
        fetchQuotaOverrides(next.userId),
      ]);
      setDetail({ status: "ready", usage, overrides });
    } catch (err: unknown) {
      setDetail({ status: "error", ...describeError(err, "Failed to load user quota") });
    }
  };

  const onLookup = (values: QuotaLookupFormValues) => {
    void loadUser({ userId: values.userId, endpoint: values.endpoint || undefined });
  };

  const onCreateOverride = async (values: QuotaOverrideFormValues) => {
    if (!target) return;
    try {
      await createQuotaOverride({
        userId: target.userId,
        endpoint: values.endpoint || undefined,
        elevatedLimit: values.elevatedLimit,
        reason: values.reason,
        expiresAt: values.expiresAt ? new Date(values.expiresAt).getTime() : undefined,
      });
      showSuccessToast("Quota override created");
      overrideForm.reset({ endpoint: "", elevatedLimit: Number.NaN, reason: "", expiresAt: "" });
      await loadUser(target);
    } catch (err: unknown) {
      showErrorToast(err, "Could not create the quota override");
    }
  };

  const onRemoveOverride = async () => {
    if (!target || !overrideToRemove) return;
    const removed = overrideToRemove;
    setOverrideToRemove(null);
    try {
      await removeQuotaOverride(target.userId, removed.endpoint);
      showSuccessToast("Quota override removed");
      await loadUser(target);
    } catch (err: unknown) {
      showErrorToast(err, "Could not remove the quota override");
    }
  };

  const onResetUsage = async () => {
    if (!target) return;
    setConfirmReset(false);
    try {
      await resetQuota(target.userId, target.endpoint);
      showSuccessToast("Quota usage reset");
      await loadUser(target);
    } catch (err: unknown) {
      showErrorToast(err, "Could not reset quota usage");
    }
  };

  return (
    <div className="flex flex-col gap-6 p-4 md:p-6">
      <header>
        <h1 className="text-2xl font-bold tracking-tight">Quota management</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Look up a user to see their rate-limit usage, manage elevated overrides, or reset their usage.
        </p>
      </header>

      {/* Stats header */}
      <section aria-labelledby="quota-stats-heading" className="space-y-3">
        <h2 id="quota-stats-heading" className="text-lg font-semibold">
          Overview
        </h2>
        {stats.status === "loading" && (
          <div className="grid gap-3 sm:grid-cols-2" role="status" aria-live="polite">
            <span className="sr-only">Loading quota stats</span>
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-20 w-full" />
          </div>
        )}
        {stats.status === "error" && (
          <ErrorState
            title="Quota stats are unavailable"
            description={stats.message}
            onRetry={retryStats}
          />
        )}
        {stats.status === "ready" && (
          <dl className="grid gap-3 sm:grid-cols-2">
            <div className="border-2 border-foreground bg-card p-4">
              <dt className="text-sm text-muted-foreground">Total overrides</dt>
              <dd className="font-mono text-2xl font-bold">{stats.data.totalOverrides}</dd>
            </div>
            <div className="border-2 border-foreground bg-card p-4">
              <dt className="text-sm text-muted-foreground">Active overrides</dt>
              <dd className="font-mono text-2xl font-bold">{stats.data.activeOverrides}</dd>
            </div>
          </dl>
        )}
      </section>

      {/* User lookup */}
      <section aria-labelledby="quota-lookup-heading" className="border-2 border-foreground bg-card p-4">
        <h2 id="quota-lookup-heading" className="mb-3 text-lg font-semibold">
          Find a user
        </h2>
        <form
          onSubmit={lookupForm.handleSubmit(onLookup)}
          noValidate
          className="grid gap-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
        >
          <div className="space-y-1">
            <Label htmlFor="quota-user-id">User ID</Label>
            <Input
              id="quota-user-id"
              aria-invalid={!!lookupForm.formState.errors.userId}
              aria-describedby={lookupForm.formState.errors.userId ? "quota-user-id-error" : undefined}
              {...lookupForm.register("userId")}
            />
            <FieldError id="quota-user-id-error" message={lookupForm.formState.errors.userId?.message} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="quota-lookup-endpoint">Endpoint (optional)</Label>
            <Input id="quota-lookup-endpoint" {...lookupForm.register("endpoint")} />
          </div>
          <Button
            type="submit"
            disabled={lookupForm.formState.isSubmitting || detail.status === "loading"}
            className="gap-2 border-2 border-foreground font-bold"
          >
            {detail.status === "loading" ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <Search className="h-4 w-4" aria-hidden="true" />
            )}
            Look up
          </Button>
        </form>
      </section>

      {/* User detail */}
      {detail.status === "idle" && (
        <EmptyState
          icon={Search}
          title="No user selected"
          description="Enter a user ID above to see their current usage and overrides."
        />
      )}

      {detail.status === "loading" && (
        <div className="space-y-3" role="status" aria-live="polite">
          <span className="sr-only">Loading user quota</span>
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      )}

      {detail.status === "error" && target && (
        <ErrorState
          title="Could not load this user's quota"
          description={detail.message}
          onRetry={() => void loadUser(target)}
        />
      )}

      {detail.status === "ready" && target && (
        <div className="grid gap-6 lg:grid-cols-2">
          {/* Usage */}
          <section aria-labelledby="quota-usage-heading" className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 id="quota-usage-heading" className="text-lg font-semibold">
                Current usage
              </h2>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setConfirmReset(true)}
                className="gap-2 border-2 border-foreground font-bold"
              >
                <RotateCcw className="h-4 w-4" aria-hidden="true" />
                Reset usage
              </Button>
            </div>
            <div className="overflow-x-auto border-2 border-foreground bg-card">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Endpoint</TableHead>
                    <TableHead>Minute</TableHead>
                    <TableHead>Day</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <TableRow>
                    <TableCell>{detail.usage.endpoint}</TableCell>
                    <TableCell className="font-mono">
                      {detail.usage.minuteUsage} / {detail.usage.minuteLimit}
                    </TableCell>
                    <TableCell className="font-mono">
                      {detail.usage.dayUsage} / {detail.usage.dayLimit}
                    </TableCell>
                    <TableCell>
                      {detail.usage.nearLimit ? <Badge variant="destructive">Near limit</Badge> : "OK"}
                    </TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </div>
          </section>

          {/* Overrides */}
          <section aria-labelledby="quota-overrides-heading" className="space-y-3">
            <h2 id="quota-overrides-heading" className="text-lg font-semibold">
              Overrides
            </h2>
            {detail.overrides.length === 0 ? (
              <EmptyState
                title="No overrides"
                description="This user is on the default limits. Create an override below to raise them."
              />
            ) : (
              <div className="overflow-x-auto border-2 border-foreground bg-card">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Endpoint</TableHead>
                      <TableHead>Limit</TableHead>
                      <TableHead>Reason</TableHead>
                      <TableHead>Expires</TableHead>
                      <TableHead>
                        <span className="sr-only">Actions</span>
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {detail.overrides.map((override) => (
                      <TableRow key={`${override.endpoint ?? "all"}-${override.createdAt}`}>
                        <TableCell>{override.endpoint ?? "All endpoints"}</TableCell>
                        <TableCell className="font-mono">{override.elevatedLimit}</TableCell>
                        <TableCell className="max-w-[12rem] truncate">{override.reason}</TableCell>
                        <TableCell>{formatTimestamp(override.expiresAt)}</TableCell>
                        <TableCell>
                          <Button
                            variant="ghost"
                            size="sm"
                            aria-label={`Remove override for ${override.endpoint ?? "all endpoints"}`}
                            onClick={() => setOverrideToRemove(override)}
                          >
                            <Trash2 className="h-4 w-4 text-destructive" aria-hidden="true" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}

            {/* Create override */}
            <form
              onSubmit={overrideForm.handleSubmit(onCreateOverride)}
              noValidate
              aria-labelledby="quota-create-heading"
              className="space-y-4 border-2 border-foreground bg-card p-4"
            >
              <h3 id="quota-create-heading" className="font-semibold">
                Create override
              </h3>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label htmlFor="override-endpoint">Endpoint (optional)</Label>
                  <Input id="override-endpoint" {...overrideForm.register("endpoint")} />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="override-limit">Elevated limit</Label>
                  <Input
                    id="override-limit"
                    type="number"
                    inputMode="numeric"
                    min={1}
                    aria-invalid={!!overrideForm.formState.errors.elevatedLimit}
                    aria-describedby={overrideForm.formState.errors.elevatedLimit ? "override-limit-error" : undefined}
                    {...overrideForm.register("elevatedLimit", { valueAsNumber: true })}
                  />
                  <FieldError
                    id="override-limit-error"
                    message={overrideForm.formState.errors.elevatedLimit?.message}
                  />
                </div>
                <div className="space-y-1 sm:col-span-2">
                  <Label htmlFor="override-reason">Reason</Label>
                  <Input
                    id="override-reason"
                    aria-invalid={!!overrideForm.formState.errors.reason}
                    aria-describedby={overrideForm.formState.errors.reason ? "override-reason-error" : undefined}
                    {...overrideForm.register("reason")}
                  />
                  <FieldError id="override-reason-error" message={overrideForm.formState.errors.reason?.message} />
                </div>
                <div className="space-y-1 sm:col-span-2">
                  <Label htmlFor="override-expires">Expires (optional)</Label>
                  <Input
                    id="override-expires"
                    type="datetime-local"
                    aria-invalid={!!overrideForm.formState.errors.expiresAt}
                    aria-describedby={overrideForm.formState.errors.expiresAt ? "override-expires-error" : undefined}
                    {...overrideForm.register("expiresAt")}
                  />
                  <FieldError id="override-expires-error" message={overrideForm.formState.errors.expiresAt?.message} />
                </div>
              </div>
              <Button
                type="submit"
                disabled={overrideForm.formState.isSubmitting}
                className="border-2 border-foreground font-bold"
              >
                Create override
              </Button>
            </form>
          </section>
        </div>
      )}

      {/* Confirmations */}
      <AlertDialog open={overrideToRemove !== null} onOpenChange={(open) => !open && setOverrideToRemove(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this override?</AlertDialogTitle>
            <AlertDialogDescription>
              The user goes back to the default limits for {overrideToRemove?.endpoint ?? "all endpoints"}.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void onRemoveOverride()}>Remove override</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmReset} onOpenChange={setConfirmReset}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reset quota usage?</AlertDialogTitle>
            <AlertDialogDescription>
              This clears the current minute and day counters for this user
              {target?.endpoint ? ` on ${target.endpoint}` : " on every endpoint"}.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void onResetUsage()}>Reset usage</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
