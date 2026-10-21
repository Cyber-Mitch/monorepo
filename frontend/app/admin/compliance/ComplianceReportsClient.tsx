"use client";

/**
 * Admin compliance reports UI (#1982).
 *
 * Generate form (report type + zod-validated date range with a max span),
 * a reports table that polls while any report is still generating, a download
 * action for completed reports, and a verify action that surfaces the
 * backend's hash match/mismatch result.
 *
 * State handling, form validation, and metadata follow the repo conventions:
 *   - STATE_HANDLING_CONVENTION.md  (LoadingState / EmptyState / ErrorState)
 *   - FORM_VALIDATION_CONVENTION.md  (react-hook-form + zod, server error mapping)
 *   - SEO_METADATA_CONVENTION.md     (privatePageMetadata lives in page.tsx)
 *
 * The backend enforces admin access; a 403 is shown as an access-denied state.
 */

import { useCallback, useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  Loader2,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  EmptyState,
  ErrorState,
  ListRowSkeleton,
  LoadingState,
} from "@/components/ui/data-state";

import {
  COMPLIANCE_REPORT_MAX_RANGE_DAYS,
  complianceReportTypes,
  complianceReportSchema,
  type ComplianceReportFormValues,
  type ComplianceReportType,
} from "@/lib/formSchemas";
import {
  ApiError,
  downloadComplianceReport,
  generateComplianceReport,
  listComplianceReports,
  verifyComplianceReport,
  type ComplianceReport,
  type VerifyComplianceReportResult,
} from "@/lib/complianceReportsApi";
import { parseFormError } from "@/lib/formErrors";
import { showErrorToast, showSuccessToast } from "@/lib/toast";
import { formatDate, formatDateTime } from "@/lib/date";

/** How often the table re-fetches while at least one report is still generating. */
export const COMPLIANCE_REPORT_POLL_INTERVAL_MS = 5_000;

const REPORT_TYPE_LABELS: Record<ComplianceReportType, string> = {
  transactions: "Transactions",
  kyc: "KYC / Identity",
  settlements: "Settlements",
  audit_log: "Audit log",
};

type StatusMeta = {
  label: string;
  className: string;
};

const STATUS_META: Record<ComplianceReport["status"], StatusMeta> = {
  pending: {
    label: "Pending",
    className: "bg-muted text-muted-foreground border-foreground/20",
  },
  in_progress: {
    label: "In progress",
    className: "bg-amber-100 text-amber-900 border-amber-300",
  },
  completed: {
    label: "Completed",
    className: "bg-emerald-100 text-emerald-900 border-emerald-300",
  },
  failed: {
    label: "Failed",
    className: "bg-destructive/10 text-destructive border-destructive/30",
  },
};

type ListState =
  | { status: "loading" }
  | { status: "error"; message: string; code?: number }
  | { status: "ready" };

/** Maps a thrown error to a user-facing message, special-casing 403. */
function describeError(err: unknown, fallback: string): {
  message: string;
  code?: number;
} {
  const code = err instanceof ApiError ? err.status : undefined;
  if (code === 403) {
    return { message: "Access denied — admin credentials required", code };
  }
  return {
    message: err instanceof Error && err.message ? err.message : fallback,
    code,
  };
}

const FORM_FIELDS = ["type", "startDate", "endDate"] as const;
type FormField = (typeof FORM_FIELDS)[number];

function isFormField(name: string): name is FormField {
  return (FORM_FIELDS as readonly string[]).includes(name);
}

function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return (
    <p id={id} role="alert" className="text-sm text-destructive">
      {message}
    </p>
  );
}

export function ComplianceReportsClient() {
  const [reports, setReports] = useState<ComplianceReport[]>([]);
  const [listState, setListState] = useState<ListState>({ status: "loading" });
  const [reloadToken, setReloadToken] = useState(0);

  const [verifyingId, setVerifyingId] = useState<string | null>(null);
  const [verifyResults, setVerifyResults] = useState<
    Record<string, VerifyComplianceReportResult>
  >({});

  const form = useForm<ComplianceReportFormValues>({
    resolver: zodResolver(complianceReportSchema),
    mode: "onBlur",
    reValidateMode: "onBlur",
    shouldFocusError: true,
    defaultValues: { startDate: "", endDate: "" },
  });
  const {
    register,
    handleSubmit,
    setValue,
    getValues,
    clearErrors,
    setError,
    setFocus,
    reset,
    formState: { errors, isSubmitting },
  } = form;
  const typeValue = form.watch("type") as ComplianceReportType | undefined;

  // Initial load + manual retry (shows the loading skeletons).
  useEffect(() => {
    let cancelled = false;
    setListState({ status: "loading" });
    listComplianceReports()
      .then((data) => {
        if (!cancelled) {
          setReports(data);
          setListState({ status: "ready" });
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setListState({
            status: "error",
            ...describeError(err, "Failed to load compliance reports"),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [reloadToken]);

  const retry = useCallback(() => setReloadToken((t) => t + 1), []);

  // Silent refresh used by polling and after a generate — keeps the existing
  // rows visible instead of flashing the loading skeletons.
  const refresh = useCallback(async () => {
    try {
      const data = await listComplianceReports();
      setReports(data);
      setListState({ status: "ready" });
    } catch {
      // Transient poll failure: leave the last-known list in place.
    }
  }, []);

  const hasPending = reports.some(
    (r) => r.status === "pending" || r.status === "in_progress",
  );

  // Poll while any report is still generating; stop once everything is settled.
  useEffect(() => {
    if (!hasPending) return;
    const interval = setInterval(() => {
      void refresh();
    }, COMPLIANCE_REPORT_POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [hasPending, refresh]);

  const onGenerate = async (values: ComplianceReportFormValues) => {
    if (isSubmitting) return;
    clearErrors("root");
    try {
      await generateComplianceReport({
        type: values.type,
        startDate: values.startDate,
        endDate: values.endDate,
      });
      showSuccessToast("Report generation started");
      // Keep the selected type for repeat runs; clear the date window.
      reset({
        type: getValues("type"),
        startDate: "",
        endDate: "",
      });
      void refresh();
    } catch (err: unknown) {
      if (err instanceof ApiError && err.status === 403) {
        setError("root.serverError", {
          type: "server",
          message: "Access denied — admin credentials required",
        });
        return;
      }
      const { message, fieldErrors } = parseFormError(
        err,
        "Could not start the report",
      );
      const firstField = Object.keys(fieldErrors)[0];
      if (firstField && isFormField(firstField)) {
        setError(firstField, {
          type: "server",
          message: fieldErrors[firstField],
        });
        if (firstField === "type") {
          document.getElementById("compliance-type")?.focus();
        } else {
          setFocus(firstField);
        }
        return;
      }
      setError("root.serverError", { type: "server", message });
    }
  };

  const onDownload = (report: ComplianceReport) => {
    downloadComplianceReport(report);
  };

  const onVerify = async (id: string) => {
    setVerifyingId(id);
    try {
      const result = await verifyComplianceReport(id);
      setVerifyResults((prev) => ({ ...prev, [id]: result }));
    } catch (err: unknown) {
      showErrorToast(err, "Could not verify the report");
    } finally {
      setVerifyingId(null);
    }
  };

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 p-4 md:p-6">
      <header>
        <h1 className="text-2xl font-bold tracking-tight">Compliance reports</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Generate, download, and verify integrity hashes for compliance
          exports. Reports are scoped to a {COMPLIANCE_REPORT_MAX_RANGE_DAYS}-
          day window.
        </p>
      </header>

      {/* Generate form */}
      <section
        aria-labelledby="compliance-generate-heading"
        className="border-2 border-foreground bg-card p-4"
      >
        <h2 id="compliance-generate-heading" className="mb-3 text-lg font-semibold">
          Generate a report
        </h2>
        {errors.root?.serverError?.message && (
          <div
            role="alert"
            className="mb-4 border-2 border-destructive bg-destructive/10 p-3 text-sm font-medium text-destructive"
          >
            {errors.root.serverError.message}
          </div>
        )}
        <form
          onSubmit={handleSubmit(onGenerate)}
          noValidate
          className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 lg:items-end"
        >
          <div className="space-y-1 lg:col-span-1">
            <Label htmlFor="compliance-type">Report type</Label>
            {/*
              A native <select> here (rather than the Radix Select primitive) is
              deliberate: it gives a native mobile picker, first-class keyboard
              support, and the ARIA/label wiring RHF needs, while staying testable.
              The rest of the page uses the components/ui primitives.
            */}
            <select
              id="compliance-type"
              aria-invalid={Boolean(errors.type)}
              aria-describedby={
                errors.type ? "compliance-type-error" : undefined
              }
              value={typeValue ?? ""}
              onChange={(e) => {
                setValue(
                  "type",
                  e.target.value as ComplianceReportType,
                );
                clearErrors(["type", "root.serverError" as any]);
              }}
              className="h-9 w-full rounded-md border-2 border-foreground bg-background px-3 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <option value="" disabled>
                Select a report type
              </option>
              {complianceReportTypes.map((t) => (
                <option key={t} value={t}>
                  {REPORT_TYPE_LABELS[t]}
                </option>
              ))}
            </select>
            <FieldError id="compliance-type-error" message={errors.type?.message} />
          </div>

          <div className="space-y-1">
            <Label htmlFor="compliance-start-date">Start date</Label>
            <Input
              id="compliance-start-date"
              type="date"
              aria-invalid={Boolean(errors.startDate)}
              aria-describedby={
                errors.startDate ? "compliance-start-date-error" : undefined
              }
              {...register("startDate", {
                onChange: () =>
                  clearErrors([
                    "startDate",
                    "endDate",
                    "root.serverError" as any,
                  ]),
              })}
            />
            <FieldError
              id="compliance-start-date-error"
              message={errors.startDate?.message}
            />
          </div>

          <div className="space-y-1">
            <Label htmlFor="compliance-end-date">End date</Label>
            <Input
              id="compliance-end-date"
              type="date"
              aria-invalid={Boolean(errors.endDate)}
              aria-describedby={
                errors.endDate ? "compliance-end-date-error" : undefined
              }
              {...register("endDate", {
                onChange: () =>
                  clearErrors(["endDate", "root.serverError" as any]),
              })}
            />
            <FieldError
              id="compliance-end-date-error"
              message={errors.endDate?.message}
            />
          </div>

          <Button
            type="submit"
            disabled={isSubmitting}
            aria-label="Generate report"
            className="gap-2 border-2 border-foreground font-bold"
          >
            {isSubmitting ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <RefreshCw className="h-4 w-4" aria-hidden="true" />
            )}
            {isSubmitting ? "Generating…" : "Generate"}
          </Button>
        </form>
        <p className="mt-3 text-xs text-muted-foreground">
          Maximum range: {COMPLIANCE_REPORT_MAX_RANGE_DAYS} days. End date must
          be on or after the start date.
        </p>
      </section>

      {/* Reports table */}
      <section aria-labelledby="compliance-reports-heading" className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2
            id="compliance-reports-heading"
            className="text-lg font-semibold"
          >
            Reports
          </h2>
          <Button
            variant="outline"
            size="sm"
            onClick={retry}
            disabled={listState.status === "loading"}
            className="gap-2 border-2 border-foreground font-bold"
          >
            {listState.status === "loading" ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <RefreshCw className="h-4 w-4" aria-hidden="true" />
            )}
            Refresh
          </Button>
        </div>

        {listState.status === "loading" && (
          <LoadingState label="Loading compliance reports" className="space-y-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <ListRowSkeleton key={i} />
            ))}
          </LoadingState>
        )}

        {listState.status === "error" && (
          <ErrorState
            title={
              listState.code === 403
                ? "Access denied"
                : "Compliance reports are unavailable"
            }
            description={listState.message}
            onRetry={retry}
          />
        )}

        {listState.status === "ready" && reports.length === 0 && (
          <EmptyState
            icon={ShieldCheck}
            title="No compliance reports yet"
            description="Generate your first compliance export using the form above."
            action={{
              label: "Generate a report",
              onClick: () =>
                document.getElementById("compliance-type")?.focus(),
            }}
          />
        )}

        {listState.status === "ready" && reports.length > 0 && (
          <div className="border-2 border-foreground bg-card">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Type</TableHead>
                  <TableHead>Date range</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead>
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {reports.map((report) => {
                  const result = verifyResults[report.id];
                  return (
                    <ReportRow
                      key={report.id}
                      report={report}
                      verifying={verifyingId === report.id}
                      verifyResult={result}
                      onDownload={onDownload}
                      onVerify={onVerify}
                    />
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </section>
    </div>
  );
}

function ReportRow({
  report,
  verifying,
  verifyResult,
  onDownload,
  onVerify,
}: {
  report: ComplianceReport;
  verifying: boolean;
  verifyResult?: VerifyComplianceReportResult;
  onDownload: (report: ComplianceReport) => void;
  onVerify: (id: string) => void;
}) {
  const meta = STATUS_META[report.status];
  const isCompleted = report.status === "completed";
  const canDownload = isCompleted && Boolean(report.fileUrl);
  const canVerify = isCompleted;

  return (
    <>
      <TableRow>
        <TableCell className="font-medium">
          {REPORT_TYPE_LABELS[report.type] ?? report.type}
        </TableCell>
        <TableCell className="whitespace-nowrap text-sm">
          {formatDate(report.startDate)} – {formatDate(report.endDate)}
        </TableCell>
        <TableCell>
          <Badge className={`border text-xs font-bold ${meta.className}`}>
            {meta.label}
          </Badge>
          {report.status === "failed" && report.errorMessage ? (
            <p className="mt-1 max-w-xs text-xs text-destructive">
              {report.errorMessage}
            </p>
          ) : null}
        </TableCell>
        <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
          {formatDateTime(report.createdAt)}
        </TableCell>
        <TableCell>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!canDownload}
              onClick={() => onDownload(report)}
              className="gap-1.5 border-2 border-foreground font-bold"
              aria-label={`Download ${REPORT_TYPE_LABELS[report.type]} report`}
            >
              <Download className="h-4 w-4" aria-hidden="true" />
              Download
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!canVerify || verifying}
              onClick={() => onVerify(report.id)}
              className="gap-1.5 border-2 border-foreground font-bold"
              aria-label={`Verify ${REPORT_TYPE_LABELS[report.type]} report integrity`}
            >
              {verifying ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : (
                <ShieldCheck className="h-4 w-4" aria-hidden="true" />
              )}
              Verify
            </Button>
          </div>
        </TableCell>
      </TableRow>
      {verifyResult ? <VerifyResultRow result={verifyResult} /> : null}
    </>
  );
}

function VerifyResultRow({ result }: { result: VerifyComplianceReportResult }) {
  const match = result.match;
  return (
    <TableRow>
      <TableCell colSpan={5} className="bg-muted/40 p-3">
        <div
          role="status"
          className={`flex items-start gap-2 border-2 p-3 text-sm ${
            match
              ? "border-emerald-500 bg-emerald-50 text-emerald-900"
              : "border-destructive bg-destructive/10 text-destructive"
          }`}
        >
          {match ? (
            <CheckCircle2
              className="mt-0.5 h-4 w-4 shrink-0"
              aria-hidden="true"
            />
          ) : (
            <AlertTriangle
              className="mt-0.5 h-4 w-4 shrink-0"
              aria-hidden="true"
            />
          )}
          <div className="space-y-1">
            <p className="font-bold">
              {match
                ? "Hash verified — file integrity confirmed"
                : "Hash mismatch — the file may have been tampered with"}
            </p>
            <p className="font-mono text-xs">
              Expected: {result.expectedHash}
            </p>
            <p className="font-mono text-xs">
              Actual: {result.actualHash}
            </p>
            <p className="text-xs opacity-80">
              Verified {formatDateTime(result.verifiedAt)}
            </p>
          </div>
        </div>
      </TableCell>
    </TableRow>
  );
}
