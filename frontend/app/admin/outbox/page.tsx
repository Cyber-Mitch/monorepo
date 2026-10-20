"use client";

/**
 * Admin dead-letter queue for the on-chain outbox (#1914).
 *
 * Failed on-chain writes (receipts, deal syncs, reputation updates) that the
 * outbox gave up on. Operators can filter by event type, retry or dismiss a
 * single item, inspect its payload, and bulk-retry every item of one event
 * type. Destructive actions go through a confirmation dialog, and results are
 * announced through toasts.
 */

import { Fragment, useEffect, useState } from "react";
import { formatDistanceToNow } from "date-fns";
import { ChevronDown, ChevronRight, Copy, Loader2, RefreshCw, RotateCw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState, ErrorState } from "@/components/ui/data-state";
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
  bulkRetryDeadLetters,
  dismissDeadLetterItem,
  fetchDeadLetterItems,
  retryDeadLetterItem,
  type DeadLetterItem,
  type DeadLetterListResponse,
} from "@/lib/outboxAdminApi";
import { showErrorToast, showSuccessToast } from "@/lib/toast";

const PAGE_SIZE = 20;

type AsyncState =
  | { status: "loading" }
  | { status: "error"; message: string; code?: number }
  | { status: "ready"; data: DeadLetterListResponse };

type Query = { page: number; eventType: string };

function describeError(err: unknown, fallback: string) {
  const code = err instanceof ApiError ? err.status : undefined;
  if (code === 403) {
    return { message: "Access denied — admin credentials required", code };
  }
  return { message: err instanceof Error && err.message ? err.message : fallback, code };
}

function age(iso: string) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "—" : formatDistanceToNow(date, { addSuffix: true });
}

export default function AdminOutboxPage() {
  const [query, setQuery] = useState<Query>({ page: 1, eventType: "" });
  const [draftEventType, setDraftEventType] = useState("");
  const [reload, setReload] = useState(0);
  const [list, setList] = useState<AsyncState>({ status: "loading" });
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [toDismiss, setToDismiss] = useState<DeadLetterItem | null>(null);
  const [confirmBulk, setConfirmBulk] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchDeadLetterItems({
      page: query.page,
      pageSize: PAGE_SIZE,
      eventType: query.eventType || undefined,
    })
      .then((data) => {
        if (!cancelled) setList({ status: "ready", data });
      })
      .catch((err: unknown) => {
        if (!cancelled) setList({ status: "error", ...describeError(err, "Failed to load dead-letter items") });
      });
    return () => {
      cancelled = true;
    };
  }, [query, reload]);

  // Refetches without flashing the table back to a skeleton after an action.
  const refresh = () => setReload((n) => n + 1);

  const changeQuery = (next: Query) => {
    setList({ status: "loading" });
    setExpandedId(null);
    setQuery(next);
  };

  const applyFilter = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    changeQuery({ page: 1, eventType: draftEventType.trim() });
  };

  const clearFilter = () => {
    setDraftEventType("");
    changeQuery({ page: 1, eventType: "" });
  };

  const retryItem = async (item: DeadLetterItem) => {
    setBusyId(item.id);
    try {
      const res = await retryDeadLetterItem(item.id);
      showSuccessToast(res.message || "Item re-queued");
      refresh();
    } catch (err: unknown) {
      showErrorToast(err, "Could not retry this item");
    } finally {
      setBusyId(null);
    }
  };

  const dismissItem = async () => {
    if (!toDismiss) return;
    const item = toDismiss;
    setToDismiss(null);
    setBusyId(item.id);
    try {
      const res = await dismissDeadLetterItem(item.id);
      showSuccessToast(res.message || "Item dismissed");
      refresh();
    } catch (err: unknown) {
      showErrorToast(err, "Could not dismiss this item");
    } finally {
      setBusyId(null);
    }
  };

  const bulkRetry = async () => {
    if (!query.eventType) return;
    setConfirmBulk(false);
    setBulkBusy(true);
    try {
      const res = await bulkRetryDeadLetters(query.eventType);
      showSuccessToast(`${res.reQueued} item${res.reQueued === 1 ? "" : "s"} re-queued`);
      refresh();
    } catch (err: unknown) {
      showErrorToast(err, "Bulk retry failed");
    } finally {
      setBulkBusy(false);
    }
  };

  const copyPayload = async (item: DeadLetterItem) => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(item.payload, null, 2));
      showSuccessToast("Payload copied to clipboard");
    } catch {
      showErrorToast(new Error("Clipboard is unavailable"), "Could not copy the payload");
    }
  };

  const total = list.status === "ready" ? list.data.pagination.total : 0;
  const totalPages = list.status === "ready" ? list.data.pagination.totalPages : 0;

  return (
    <div className="flex flex-col gap-6 p-4 md:p-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Dead-letter queue</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            On-chain writes that failed permanently. Retry them, or dismiss them once they are no longer needed.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={refresh}
          disabled={list.status === "loading"}
          className="gap-2 border-2 border-foreground font-bold"
        >
          <RefreshCw className="h-4 w-4" aria-hidden="true" />
          Refresh
        </Button>
      </header>

      {/* Filter and bulk action */}
      <div className="flex flex-col gap-4 border-2 border-foreground bg-card p-4 md:flex-row md:items-end md:justify-between">
        <form role="search" onSubmit={applyFilter} className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <Label htmlFor="outbox-event-type">Event type</Label>
            <Input
              id="outbox-event-type"
              placeholder="e.g. receipt"
              value={draftEventType}
              onChange={(e) => setDraftEventType(e.target.value)}
              className="w-56"
            />
          </div>
          <Button type="submit" className="border-2 border-foreground font-bold">
            Apply
          </Button>
          {query.eventType && (
            <Button type="button" variant="ghost" onClick={clearFilter}>
              Clear filter
            </Button>
          )}
        </form>

        <div className="flex flex-col gap-1">
          <Button
            onClick={() => setConfirmBulk(true)}
            disabled={!query.eventType || bulkBusy || total === 0}
            className="gap-2 border-2 border-foreground font-bold"
          >
            {bulkBusy ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <RotateCw className="h-4 w-4" aria-hidden="true" />
            )}
            Retry all{query.eventType ? ` "${query.eventType}"` : ""}
          </Button>
          {!query.eventType && (
            <p className="text-xs text-muted-foreground">Set an event type filter to bulk retry.</p>
          )}
        </div>
      </div>

      {/* Table states */}
      {list.status === "loading" && (
        <div className="space-y-2" role="status" aria-live="polite">
          <span className="sr-only">Loading dead-letter items</span>
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full rounded-md" />
          ))}
        </div>
      )}

      {list.status === "error" && (
        <ErrorState
          title="Dead-letter items are unavailable"
          description={list.message}
          onRetry={() => {
            setList({ status: "loading" });
            refresh();
          }}
        />
      )}

      {list.status === "ready" && list.data.items.length === 0 && (
        <EmptyState
          icon={RefreshCw}
          title="No failed items 🎉"
          description={
            query.eventType
              ? `Nothing is stuck for "${query.eventType}".`
              : "Every on-chain write has landed. New failures appear here."
          }
          action={query.eventType ? { label: "Clear filter", onClick: clearFilter } : undefined}
        />
      )}

      {list.status === "ready" && list.data.items.length > 0 && (
        <section aria-label="Dead-letter items" className="space-y-4">
          <p className="text-sm text-muted-foreground">
            <span className="font-mono font-bold text-foreground">{total}</span> failed item{total === 1 ? "" : "s"}
          </p>
          <div className="overflow-x-auto border-2 border-foreground bg-card">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">
                    <span className="sr-only">Details</span>
                  </TableHead>
                  <TableHead scope="col">Event type</TableHead>
                  <TableHead scope="col">ID</TableHead>
                  <TableHead scope="col">Attempts</TableHead>
                  <TableHead scope="col">Last error</TableHead>
                  <TableHead scope="col">Age</TableHead>
                  <TableHead scope="col">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.data.items.map((item) => {
                  const expanded = expandedId === item.id;
                  const detailsId = `outbox-details-${item.id}`;
                  return (
                    <Fragment key={item.id}>
                      <TableRow>
                        <TableCell>
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-expanded={expanded}
                            aria-controls={detailsId}
                            aria-label={`${expanded ? "Hide" : "Show"} details for ${item.id}`}
                            onClick={() => setExpandedId(expanded ? null : item.id)}
                          >
                            {expanded ? (
                              <ChevronDown className="h-4 w-4" aria-hidden="true" />
                            ) : (
                              <ChevronRight className="h-4 w-4" aria-hidden="true" />
                            )}
                          </Button>
                        </TableCell>
                        <TableCell className="font-mono text-sm">{item.eventType}</TableCell>
                        <TableCell className="max-w-[10rem] truncate font-mono text-xs">{item.id}</TableCell>
                        <TableCell className="font-mono">{item.retryCount}</TableCell>
                        <TableCell className="max-w-[16rem] truncate text-sm">{item.failureReason}</TableCell>
                        <TableCell className="whitespace-nowrap text-sm">{age(item.createdAt)}</TableCell>
                        <TableCell>
                          <div className="flex items-center gap-1">
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={busyId === item.id}
                              onClick={() => void retryItem(item)}
                              aria-label={`Retry ${item.id}`}
                              className="border-2 border-foreground"
                            >
                              {busyId === item.id ? (
                                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                              ) : (
                                "Retry"
                              )}
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              disabled={busyId === item.id}
                              onClick={() => setToDismiss(item)}
                              aria-label={`Dismiss ${item.id}`}
                            >
                              <Trash2 className="h-4 w-4 text-destructive" aria-hidden="true" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                      {expanded && (
                        <TableRow id={detailsId}>
                          <TableCell colSpan={7} className="bg-muted/40">
                            <div className="space-y-3 py-2">
                              <div>
                                <p className="text-xs font-bold uppercase text-muted-foreground">Last error</p>
                                <p className="whitespace-pre-wrap break-words text-sm">{item.failureReason}</p>
                              </div>
                              <div className="space-y-2">
                                <div className="flex items-center justify-between gap-2">
                                  <p className="text-xs font-bold uppercase text-muted-foreground">Payload</p>
                                  <Button variant="outline" size="sm" onClick={() => void copyPayload(item)} className="gap-2">
                                    <Copy className="h-4 w-4" aria-hidden="true" />
                                    Copy
                                  </Button>
                                </div>
                                <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-all border-2 border-foreground bg-background p-3 font-mono text-xs">
                                  {JSON.stringify(item.payload, null, 2)}
                                </pre>
                              </div>
                            </div>
                          </TableCell>
                        </TableRow>
                      )}
                    </Fragment>
                  );
                })}
              </TableBody>
            </Table>
          </div>

          {totalPages > 1 && (
            <nav aria-label="Pagination" className="flex items-center justify-center gap-3">
              <Button
                variant="outline"
                disabled={query.page <= 1}
                onClick={() => changeQuery({ ...query, page: query.page - 1 })}
                className="border-2 border-foreground font-bold"
              >
                Previous
              </Button>
              <span className="font-mono font-bold">
                Page {query.page} of {totalPages}
              </span>
              <Button
                variant="outline"
                disabled={query.page >= totalPages}
                onClick={() => changeQuery({ ...query, page: query.page + 1 })}
                className="border-2 border-foreground font-bold"
              >
                Next
              </Button>
            </nav>
          )}
        </section>
      )}

      {/* Confirmations */}
      <AlertDialog open={toDismiss !== null} onOpenChange={(open) => !open && setToDismiss(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Dismiss this item?</AlertDialogTitle>
            <AlertDialogDescription>
              It is removed from the dead-letter queue and will not be retried. The on-chain write for this item will
              not happen unless it is recorded another way.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void dismissItem()}>Dismiss item</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmBulk} onOpenChange={setConfirmBulk}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Retry all &quot;{query.eventType}&quot; items?</AlertDialogTitle>
            <AlertDialogDescription>
              Every dead-letter item of this event type is re-queued for on-chain delivery. The count of re-queued
              items is shown when it finishes.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void bulkRetry()}>Retry all</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
