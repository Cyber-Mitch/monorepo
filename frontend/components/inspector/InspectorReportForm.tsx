"use client";

/**
 * Inspection report form (#1921).
 *
 * Mirrors the backend constraints (#1903 / migration 029): overall grade A–D,
 * a room checklist, notes of at least 20 characters and at least 3 photos
 * uploaded through the presign endpoint with progress and retry. Validation
 * runs through the shared inspectionReportSchema (lib/formSchemas.ts) with
 * react-hook-form, mode: onBlur.
 */
import { useCallback, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertCircle, Camera, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAppForm } from "@/hooks/useAppForm";
import {
  INSPECTION_GRADES,
  INSPECTION_ROOMS,
  MIN_INSPECTION_NOTES_LENGTH,
  MIN_INSPECTION_PHOTOS,
  ROOM_CHECK_RESULTS,
  inspectionReportSchema,
  type InspectionReportFormValues,
} from "@/lib/formSchemas";
import { INSPECTION_PHOTO_CONTENT_TYPES, submitJobReport, uploadJobPhoto } from "@/lib/inspectorApi";

export interface JobMeta {
  id: string;
  claimDeadline: string | null;
}

interface PhotoEntry {
  id: string;
  name: string;
  objectKey?: string;
  progress: number;
  error: string | null;
  uploading: boolean;
}

const GRADE_LABELS: Record<(typeof INSPECTION_GRADES)[number], string> = {
  A: "A — excellent",
  B: "B — good",
  C: "C — fair",
  D: "D — poor",
};

function contentTypeAllowed(file: File): boolean {
  return (INSPECTION_PHOTO_CONTENT_TYPES as readonly string[]).includes(file.type);
}

export function InspectorReportForm({ job }: { job: JobMeta }) {
  const router = useRouter();
  const [photos, setPhotos] = useState<PhotoEntry[]>([]);
  const [notesLength, setNotesLength] = useState(0);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const objectKeysRef = useRef<string[]>([]);
  // Photos live only in memory here; the retry button re-uploads the same
  // File without asking the user to pick it again.
  const photoFileRef = useRef<Map<string, File>>(new Map());

  const form = useAppForm<InspectionReportFormValues>({
    schema: inspectionReportSchema,
    draftKey: `inspector-report:${job.id}`,
    defaultValues: {
      overallGrade: undefined as unknown as InspectionReportFormValues["overallGrade"],
      rooms: [],
      photoKeys: [],
      notes: "",
    },
  });
  const { register, handleSubmit, formState, setValue, watch } = form;
  const rooms = watch("rooms") ?? [];
  const selectedRooms = new Set(rooms.map((room) => room.room));

  const persistPhotoKeys = useCallback(() => {
    setValue("photoKeys", [...objectKeysRef.current], { shouldValidate: true });
  }, [setValue]);

  const uploadOne = useCallback(
    async (entryId: string, file: File) => {
      setPhotos((prev) =>
        prev.map((p) =>
          p.id === entryId ? { ...p, uploading: true, error: null, progress: 0 } : p,
        ),
      );
      try {
        const presigned = await uploadJobPhoto(job.id, file, ({ loaded, total }) => {
          const pct = total > 0 ? Math.round((loaded / total) * 100) : 0;
          setPhotos((prev) =>
            prev.map((p) => (p.id === entryId ? { ...p, progress: pct } : p)),
          );
        });
        objectKeysRef.current = [...objectKeysRef.current, presigned.objectKey];
        setPhotos((prev) =>
          prev.map((p) =>
            p.id === entryId
              ? { ...p, objectKey: presigned.objectKey, uploading: false, progress: 100 }
              : p,
          ),
        );
        persistPhotoKeys();
      } catch (error) {
        setPhotos((prev) =>
          prev.map((p) =>
            p.id === entryId
              ? {
                  ...p,
                  uploading: false,
                  error: error instanceof Error ? error.message : "Upload failed",
                }
              : p,
          ),
        );
      }
    },
    [job.id, persistPhotoKeys],
  );

  const onFilesChosen = useCallback(
    (fileList: FileList | null) => {
      if (!fileList) return;
      const files = Array.from(fileList).filter(contentTypeAllowed);
      const newEntries: PhotoEntry[] = files.map((file, index) => ({
        id: `${Date.now()}-${index}-${file.name}`,
        name: file.name,
        progress: 0,
        error: null,
        uploading: true,
      }));
      files.forEach((file, index) => photoFileRef.current.set(newEntries[index].id, file));
      setPhotos((prev) => [...prev, ...newEntries]);
      files.forEach((file, index) => void uploadOne(newEntries[index].id, file));
    },
    [uploadOne],
  );

  const onSubmit = handleSubmit(async (values) => {
    setSubmitError(null);
    setSubmitting(true);
    try {
      const roomChecklist: Record<string, (typeof ROOM_CHECK_RESULTS)[number]> = {};
      for (const room of values.rooms) roomChecklist[room.room] = room.result;
      await submitJobReport(job.id, {
        overallGrade: values.overallGrade,
        roomChecklist,
        photoKeys: values.photoKeys,
        notes: values.notes,
      });
      form.clearDraft();
      router.push("/dashboard/inspector/my-jobs");
    } catch (error) {
      setSubmitError(
        error instanceof Error ? error.message : "Could not submit the report. Please try again.",
      );
      setSubmitting(false);
    }
  });

  const photosSucceeded = photos.filter((p) => p.objectKey).length;

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-6">
      {submitError && (
        <div
          role="alert"
          className="border-3 border-destructive bg-destructive/10 p-4 text-sm font-bold text-destructive"
        >
          {submitError}
        </div>
      )}

      <div>
        <label htmlFor="report-grade" className="block font-mono text-sm font-bold">
          Overall grade (A&ndash;D)
        </label>
        <select
          id="report-grade"
          {...register("overallGrade")}
          aria-invalid={Boolean(formState.errors.overallGrade)}
          aria-describedby={
            formState.errors.overallGrade ? "report-grade-error" : undefined
          }
          className="mt-1 w-full max-w-xs border-3 border-foreground bg-card p-3 font-bold"
        >
          <option value="">Select a grade…</option>
          {INSPECTION_GRADES.map((grade) => (
            <option key={grade} value={grade}>
              {GRADE_LABELS[grade]}
            </option>
          ))}
        </select>
        {formState.errors.overallGrade && (
          <p
            id="report-grade-error"
            role="alert"
            className="mt-1 text-sm font-bold text-destructive"
          >
            {formState.errors.overallGrade.message}
          </p>
        )}
      </div>

      <fieldset>
        <legend className="font-mono text-sm font-bold">Room checklist</legend>
        <div className="mt-2 space-y-2">
          {INSPECTION_ROOMS.map((room) => {
            const checked = selectedRooms.has(room);
            return (
              <div
                key={room}
                className="flex flex-wrap items-center gap-3 border-2 border-foreground/20 p-2"
              >
                <label className="flex min-w-40 items-center gap-2 font-bold">
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={submitting}
                    onChange={() => {
                      const next = checked
                        ? rooms.filter((r) => r.room !== room)
                        : [...rooms, { room, result: "pass" as const }];
                      setValue("rooms", next, { shouldValidate: true });
                    }}
                    aria-label={`Include ${room} in the checklist`}
                    className="h-5 w-5"
                  />
                  {room}
                </label>
                {checked && (
                  <label className="text-sm">
                    <span className="sr-only">Result for {room}</span>
                    <select
                      value={rooms.find((r) => r.room === room)?.result ?? "pass"}
                      onChange={(event) => {
                        const next = rooms.map((r) =>
                          r.room === room
                            ? {
                                ...r,
                                result: event.target
                                  .value as (typeof ROOM_CHECK_RESULTS)[number],
                              }
                            : r,
                        );
                        setValue("rooms", next, { shouldValidate: true });
                      }}
                      className="border-2 border-foreground bg-card p-1.5 font-bold"
                    >
                      {ROOM_CHECK_RESULTS.map((result) => (
                        <option key={result} value={result}>
                          {result === "na"
                            ? "N/A"
                            : result[0].toUpperCase() + result.slice(1)}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
              </div>
            );
          })}
        </div>
        {formState.errors.rooms && (
          <p role="alert" className="mt-1 text-sm font-bold text-destructive">
            {formState.errors.rooms.message ||
              "Fill the room checklist for at least one room"}
          </p>
        )}
      </fieldset>

      <div>
        <label
          htmlFor="report-photos"
          className="flex items-center gap-2 font-mono text-sm font-bold"
        >
          <Camera className="h-4 w-4" aria-hidden="true" />
          Photos (at least {MIN_INSPECTION_PHOTOS})
        </label>
        <input
          id="report-photos"
          type="file"
          multiple
          accept={INSPECTION_PHOTO_CONTENT_TYPES.join(",")}
          disabled={submitting}
          onChange={(event) => onFilesChosen(event.target.files)}
          className="mt-1 w-full border-3 border-dashed border-foreground bg-card p-3"
        />
        {formState.errors.photoKeys && (
          <p role="alert" className="mt-1 text-sm font-bold text-destructive">
            {formState.errors.photoKeys.message}
          </p>
        )}
        <ul className="mt-3 space-y-2">
          {photos.map((photo) => (
            <li key={photo.id} className="border-2 border-foreground/20 p-2 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="max-w-[60%] truncate font-bold">{photo.name}</span>
                {photo.uploading && (
                  <span className="flex items-center gap-1 text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                    Uploading {photo.progress}%
                  </span>
                )}
                {photo.error && (
                  <span
                    className="flex items-center gap-2 font-bold text-destructive"
                    role="alert"
                  >
                    <AlertCircle className="h-4 w-4" aria-hidden="true" />
                    {photo.error}
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="border-2 border-foreground"
                      disabled={photo.uploading}
                      onClick={() => {
                        const file = photoFileRef.current.get(photo.id);
                        if (file) void uploadOne(photo.id, file);
                      }}
                    >
                      <RefreshCw className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
                      Retry
                    </Button>
                  </span>
                )}
                {photo.objectKey && !photo.uploading && (
                  <span className="font-bold text-green-700">Uploaded ✓</span>
                )}
              </div>
              {photo.uploading && (
                <div
                  role="progressbar"
                  aria-valuenow={photo.progress}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-label={`Uploading ${photo.name}`}
                  className="mt-1 h-2 w-full border border-foreground/30 bg-muted"
                >
                  <div
                    className="h-full bg-primary"
                    style={{ width: `${photo.progress}%` }}
                  />
                </div>
              )}
            </li>
          ))}
        </ul>
      </div>

      <div>
        <label htmlFor="report-notes" className="block font-mono text-sm font-bold">
          Notes (at least {MIN_INSPECTION_NOTES_LENGTH} characters)
        </label>
        <textarea
          id="report-notes"
          rows={5}
          {...register("notes")}
          onChange={(event) => {
            setNotesLength(event.target.value.length);
            register("notes").onChange(event);
          }}
          aria-invalid={Boolean(formState.errors.notes)}
          aria-describedby="report-notes-hint report-notes-error"
          className="mt-1 w-full border-3 border-foreground bg-card p-3"
        />
        <p id="report-notes-hint" className="mt-1 text-xs text-muted-foreground">
          {notesLength} characters
        </p>
        {formState.errors.notes && (
          <p
            id="report-notes-error"
            role="alert"
            className="mt-1 text-sm font-bold text-destructive"
          >
            {formState.errors.notes.message}
          </p>
        )}
      </div>

      <Button
        type="submit"
        disabled={submitting || photos.some((p) => p.uploading)}
        className="border-3 border-foreground font-bold shadow-[4px_4px_0px_0px_rgba(26,26,26,1)]"
      >
        {submitting
          ? "Submitting…"
          : `Submit report (${photosSucceeded}/${MIN_INSPECTION_PHOTOS} photos)`}
      </Button>
    </form>
  );
}
