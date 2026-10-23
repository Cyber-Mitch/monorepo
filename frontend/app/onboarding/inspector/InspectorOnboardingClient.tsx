"use client";

/**
 * Inspector onboarding flow (#1922).
 *
 * Steps: bio → service areas → review + submit, with the draft persisted
 * between steps (useAppForm draftKey) and a KYC prerequisite gate. Returning
 * applicants land on a status screen (pending / verified / suspended).
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { BadgeCheck, Check, CircleAlert, Clock, ShieldOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ErrorState, LoadingState } from "@/components/ui/data-state";
import { useAppForm } from "@/hooks/useAppForm";
import {
  SUPPORTED_INSPECTOR_SERVICE_AREAS,
  type InspectorServiceArea,
  type InspectorVerificationStatus,
} from "@/lib/inspectorApi";
import {
  getInspectorProfile,
  getKycStatus,
  submitInspectorOnboarding,
} from "@/lib/inspectorApi";
import {
  inspectorOnboardingFormSchema,
  type InspectorOnboardingFormValues,
} from "@/lib/formSchemas";

const STEPS = ["About you", "Service areas", "Review"] as const;

export function InspectorOnboardingClient() {
  type ProfileState =
    | { phase: "loading" }
    | { phase: "error"; message: string }
    | { phase: "gate" }
    | { phase: "status"; status: InspectorVerificationStatus }
    | { phase: "form" };
  const [flow, setFlow] = useState<ProfileState>({ phase: "loading" });
  const [kycStatus, setKycStatus] = useState<
    "not_submitted" | "pending" | "approved" | "rejected"
  >("not_submitted");
  const [profile, setProfile] = useState<{
    bio: string;
    serviceAreas: InspectorServiceArea[];
    verificationStatus: InspectorVerificationStatus;
  } | null>(null);
  const [editing, setEditing] = useState(false);
  const [step, setStep] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const form = useAppForm<InspectorOnboardingFormValues>({
    schema: inspectorOnboardingFormSchema,
    draftKey: "inspector-onboarding",
    mode: "onBlur",
    defaultValues: { bio: "", serviceAreas: [] },
  });
  const { register, watch, setValue, formState, handleSubmit, clearDraft } = form;

  const load = useCallback(async () => {
    setFlow({ phase: "loading" });
    setEditing(false);
    setStep(0);
    try {
      const [profileResult, kycResult] = await Promise.allSettled([
        getInspectorProfile(),
        getKycStatus(),
      ]);

      if (kycResult.status === "fulfilled") {
        setKycStatus(kycResult.value.status);
      }

      if (profileResult.status === "fulfilled") {
        const loaded = profileResult.value;
        setProfile({
          bio: loaded.bio ?? "",
          serviceAreas: loaded.serviceAreas.filter(
            (area): area is InspectorServiceArea =>
              (SUPPORTED_INSPECTOR_SERVICE_AREAS as readonly string[]).includes(area),
          ),
          verificationStatus: loaded.verificationStatus,
        });
        setFlow({ phase: "status", status: loaded.verificationStatus });
      } else if (kycResult.status === "fulfilled" && kycResult.value.status !== "approved") {
        setFlow({ phase: "gate" });
      } else {
        setFlow({ phase: "form" });
      }
    } catch (error) {
      setFlow({
        phase: "error",
        message:
          error instanceof Error
            ? error.message
            : "Unable to load your inspector status.",
      });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (flow.phase === "loading") {
    return <LoadingState label="Checking your inspector status" />;
  }

  if (flow.phase === "error") {
    return (
      <ErrorState
        title="Could not load inspector onboarding"
        description={flow.message}
        onRetry={() => void load()}
      />
    );
  }

  if (flow.phase === "gate") {
    return (
      <Card className="mx-auto max-w-xl border-3 border-foreground p-6 shadow-[4px_4px_0px_0px_rgba(26,26,26,1)]">
        <div className="flex items-start gap-3">
          <CircleAlert className="mt-0.5 h-6 w-6 text-destructive" aria-hidden="true" />
          <div>
            <h1 className="font-mono text-xl font-black">Identity verification first</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              Inspector applications need an approved identity check (KYC) before an admin
              can verify you.{" "}
              {kycStatus === "rejected"
                ? "Your last verification attempt was rejected — resubmit your documents, then come back here."
                : kycStatus === "pending"
                  ? "Your identity check is still being processed. This page unlocks automatically once it is approved."
                  : "You have not started one yet."}
            </p>
            {kycStatus !== "pending" && (
              <Button
                asChild
                className="mt-4 border-3 border-foreground font-bold shadow-[4px_4px_0px_0px_rgba(26,26,26,1)]"
              >
                <Link href="/dashboard/tenant/documents">Go to identity verification</Link>
              </Button>
            )}
          </div>
        </div>
      </Card>
    );
  }

  if (flow.phase === "status" && profile && !editing) {
    return (
      <StatusScreen
        status={profile.verificationStatus}
        bio={profile.bio}
        serviceAreas={profile.serviceAreas}
        onEdit={
          profile.verificationStatus === "pending"
            ? () => {
                setValue("bio", profile.bio);
                setValue("serviceAreas", profile.serviceAreas, { shouldValidate: false });
                setEditing(true);
                setStep(0);
                setFlow({ phase: "form" });
              }
            : undefined
        }
      />
    );
  }

  const bio = watch("bio");
  const serviceAreas = watch("serviceAreas") ?? [];

  async function advanceFrom(current: number) {
    const valid = await form.trigger(current === 0 ? "bio" : "serviceAreas");
    if (!valid) return;
    setStep(current + 1);
  }

  return (
    <Card className="mx-auto max-w-xl border-3 border-foreground p-6 shadow-[4px_4px_0px_0px_rgba(26,26,26,1)]">
      <p aria-live="polite" className="sr-only">
        Step {step + 1} of {STEPS.length}: {STEPS[step]}
      </p>
      <ol className="mb-6 flex flex-wrap gap-2 text-sm">
        {STEPS.map((label, index) => (
          <li key={label} aria-current={index === step ? "step" : undefined}>
            <span
              className={`border-2 border-foreground px-3 py-1 font-bold ${
                index === step ? "bg-primary text-primary-foreground" : "bg-card"
              }`}
            >
              {index < step ? <Check className="mr-1 inline h-4 w-4" aria-hidden="true" /> : null}
              {label}
            </span>
          </li>
        ))}
      </ol>

      <form
        onSubmit={handleSubmit(async (values) => {
          setSubmitting(true);
          setSubmitError(null);
          try {
            const updated = await submitInspectorOnboarding({
              bio: values.bio,
              serviceAreas: values.serviceAreas,
            });
            clearDraft();
            setProfile({
              bio: updated.bio ?? "",
              serviceAreas: updated.serviceAreas.filter(
                (area): area is InspectorServiceArea =>
                  (SUPPORTED_INSPECTOR_SERVICE_AREAS as readonly string[]).includes(area),
              ),
              verificationStatus: updated.verificationStatus,
            });
            setFlow({ phase: "status", status: updated.verificationStatus });
          } catch (error) {
            setSubmitError(
              error instanceof Error
                ? error.message
                : "Could not submit your application. Please try again.",
            );
          } finally {
            setSubmitting(false);
          }
        })}
        noValidate
      >
        {step === 0 && (
          <div>
            <label
              htmlFor="inspector-bio"
              className="block font-mono text-sm font-bold"
            >
              About you (shown alongside your applications)
            </label>
            <textarea
              id="inspector-bio"
              rows={5}
              disabled={submitting}
              {...register("bio", {
                setValueAs: (value: unknown) => (typeof value === "string" ? value : ""),
              })}
              {...(formState.errors.bio
                ? { "aria-invalid": true, "aria-describedby": "inspector-bio-error" }
                : {})}
              className="mt-1 w-full border-3 border-foreground bg-card p-3"
            />
            {formState.errors.bio && (
              <p
                id="inspector-bio-error"
                role="alert"
                className="mt-1 text-sm font-bold text-destructive"
              >
                {formState.errors.bio.message}
              </p>
            )}
            <div className="mt-4 flex justify-between gap-2">
              <Button
                type="button"
                variant="outline"
                className="border-3 border-foreground font-bold"
                onClick={() => {
                  if (profile) {
                    setEditing(false);
                    setFlow({ phase: "status", status: profile.verificationStatus });
                  } else {
                    window.location.href = "/dashboard";
                  }
                }}
              >
                Back
              </Button>
              <Button
                type="button"
                onClick={() => void advanceFrom(0)}
                className="border-3 border-foreground font-bold shadow-[4px_4px_0px_0px_rgba(26,26,26,1)]"
              >
                Next: service areas
              </Button>
            </div>
          </div>
        )}

        {step === 1 && (
          <div>
            <fieldset>
              <legend className="font-mono text-sm font-bold">Areas you cover</legend>
              <p className="mt-1 text-sm text-muted-foreground">
                Only listings inside your selected areas will be offered to you.
              </p>
              <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                {SUPPORTED_INSPECTOR_SERVICE_AREAS.map((area) => {
                  const checked = serviceAreas.includes(area);
                  return (
                    <label
                      key={area}
                      className="flex items-center gap-2 border-2 border-foreground/20 p-2 font-bold"
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={submitting}
                        onChange={() => {
                          const next = checked
                            ? serviceAreas.filter((a) => a !== area)
                            : [...serviceAreas, area];
                          setValue("serviceAreas", next, { shouldValidate: true });
                        }}
                        aria-label={`Cover ${area}`}
                        className="h-5 w-5"
                      />
                      {area}
                    </label>
                  );
                })}
              </div>
            </fieldset>
            {formState.errors.serviceAreas && (
              <p role="alert" className="mt-2 text-sm font-bold text-destructive">
                {formState.errors.serviceAreas.message}
              </p>
            )}
            <div className="mt-4 flex justify-between gap-2">
              <Button
                type="button"
                variant="outline"
                className="border-3 border-foreground font-bold"
                onClick={() => setStep(0)}
              >
                Back
              </Button>
              <Button
                type="button"
                onClick={() => void advanceFrom(1)}
                className="border-3 border-foreground font-bold shadow-[4px_4px_0px_0px_rgba(26,26,26,1)]"
              >
                Next: review
              </Button>
            </div>
          </div>
        )}

        {step === 2 && (
          <div>
            <h2 className="font-mono text-lg font-black">Review your application</h2>
            <dl className="mt-3 space-y-2 text-sm">
              <div>
                <dt className="font-bold">Bio</dt>
                <dd className="whitespace-pre-line text-muted-foreground">{bio}</dd>
              </div>
              <div>
                <dt className="font-bold">Service areas</dt>
                <dd className="text-muted-foreground">
                  {serviceAreas.length > 0 ? serviceAreas.join(", ") : "None selected"}
                </dd>
              </div>
            </dl>
            {submitError && (
              <div
                role="alert"
                className="mt-3 border-3 border-destructive bg-destructive/10 p-3 text-sm font-bold text-destructive"
              >
                {submitError}
              </div>
            )}
            <div className="mt-4 flex justify-between gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={submitting}
                className="border-3 border-foreground font-bold"
                onClick={() => setStep(1)}
              >
                Back
              </Button>
              <Button
                type="submit"
                disabled={submitting}
                className="border-3 border-foreground font-bold shadow-[4px_4px_0px_0px_rgba(26,26,26,1)]"
              >
                {submitting ? "Submitting…" : "Submit application"}
              </Button>
            </div>
          </div>
        )}
      </form>
    </Card>
  );
}

function StatusScreen({
  status,
  bio,
  serviceAreas,
  onEdit,
}: {
  status: InspectorVerificationStatus;
  bio: string;
  serviceAreas: InspectorServiceArea[];
  onEdit?: () => void;
}) {
  if (status === "verified") {
    return (
      <Card className="mx-auto max-w-xl border-3 border-foreground p-6 shadow-[4px_4px_0px_0px_rgba(26,26,26,1)]">
        <BadgeCheck className="h-12 w-12 text-green-600" aria-hidden="true" />
        <h1 className="mt-3 font-mono text-xl font-black">You are a verified inspector</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Your profile is active. Head to the job board to claim inspections near you.
        </p>
        <Button
          asChild
          className="mt-4 border-3 border-foreground font-bold shadow-[4px_4px_0px_0px_rgba(26,26,26,1)]"
        >
          <Link href="/dashboard/inspector">Open the Job Board</Link>
        </Button>
      </Card>
    );
  }

  if (status === "suspended") {
    return (
      <Card className="mx-auto max-w-xl border-3 border-destructive bg-destructive/5 p-6">
        <ShieldOff className="h-12 w-12 text-destructive" aria-hidden="true" />
        <h1 className="mt-3 font-mono text-xl font-black">Account suspended</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Your inspector account is suspended. Contact support at{" "}
          <a href="mailto:support@shelterflex.com" className="underline">
            support@shelterflex.com
          </a>{" "}
          for details.
        </p>
      </Card>
    );
  }

  return (
    <Card className="mx-auto max-w-xl border-3 border-foreground p-6 shadow-[4px_4px_0px_0px_rgba(26,26,26,1)]">
      <Clock className="h-12 w-12 text-muted-foreground" aria-hidden="true" />
      <h1 className="mt-3 font-mono text-xl font-black">Application pending review</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Your inspector application is in. An admin verifies profiles after an approved
        identity check — you will be notified when it happens.
      </p>
      {bio || serviceAreas.length > 0 ? (
        <dl className="mt-4 space-y-2 text-sm">
          <div>
            <dt className="font-bold">Bio</dt>
            <dd className="whitespace-pre-line text-muted-foreground">{bio}</dd>
          </div>
          <div>
            <dt className="font-bold">Service areas</dt>
            <dd className="text-muted-foreground">
              {serviceAreas.length > 0 ? serviceAreas.join(", ") : "None selected"}
            </dd>
          </div>
        </dl>
      ) : null}
      {onEdit && (
        <Button
          type="button"
          variant="outline"
          className="mt-4 border-3 border-foreground font-bold"
          onClick={onEdit}
        >
          Edit application
        </Button>
      )}
    </Card>
  );
}
