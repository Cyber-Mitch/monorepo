import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useRouter } from "next/navigation";
import { InspectorReportForm } from "../InspectorReportForm";
import * as inspectorApi from "@/lib/inspectorApi";

vi.mock("next/navigation", () => ({
  useRouter: vi.fn(() => ({ push: vi.fn() })),
}));

vi.mock("@/lib/inspectorApi", async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>;
  return {
    ...original,
    uploadJobPhoto: vi.fn(),
    submitJobReport: vi.fn(),
  };
});

const job = {
  id: "11111111-1111-4111-8111-111111111111",
  claimDeadline: "2030-01-01T12:00:00.000Z",
};

function makeFile(name: string, type: string) {
  return new File(["x"], name, { type });
}

function choosePhotos(files: File[]) {
  const input = screen.getByLabelText(/^photos \(at least 3\)/i);
  fireEvent.change(input, { target: { files } });
}

describe("InspectorReportForm (#1921)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useRouter).mockReturnValue({ push: vi.fn() } as never);
  });

  it("shows the backend-mirrored validation errors on submit", async () => {
    render(<InspectorReportForm job={job} />);
    fireEvent.click(screen.getByRole("button", { name: /submit report/i }));

    expect(
      await screen.findByText("Select an overall grade of A–D"),
    ).toBeInTheDocument();
    expect(screen.getByText("At least 3 photos are required")).toBeInTheDocument();
    expect(screen.getByText("Notes must be at least 20 characters")).toBeInTheDocument();
    expect(inspectorApi.submitJobReport).not.toHaveBeenCalled();
  });

  it("uploads a photo with progress and marks it done", async () => {
    let resolveUpload: (value: {
      uploadUrl: string;
      objectKey: string;
      expiresAt: string;
    }) => void = () => undefined;
    vi.mocked(inspectorApi.uploadJobPhoto).mockImplementation(
      (_jobId, _file, onProgress) => {
        // Report half-done, then hold the upload open until the test resolves it,
        // so the progress UI is observable.
        onProgress?.({ loaded: 50, total: 100 });
        return new Promise((resolve) => {
          resolveUpload = resolve;
        });
      },
    );
    render(<InspectorReportForm job={job} />);
    choosePhotos([makeFile("a.jpg", "image/jpeg")]);

    expect(await screen.findByText(/50%/)).toBeInTheDocument();
    resolveUpload({
      uploadUrl: "https://storage.example/upload",
      objectKey: `reports/${job.id}/a.bin`,
      expiresAt: "2030-01-01T00:00:00.000Z",
    });
    await waitFor(() =>
      expect(screen.getAllByText(/Uploaded ✓/).length).toBe(1),
    );
    expect(inspectorApi.uploadJobPhoto).toHaveBeenCalledWith(
      job.id,
      expect.any(File),
      expect.any(Function),
    );
  });

  it("shows a failed upload with a retry button, then succeeds on retry", async () => {
    const uploadSpy = vi
      .mocked(inspectorApi.uploadJobPhoto)
      .mockRejectedValueOnce(new Error("Photo upload failed. Please try again."))
      .mockResolvedValueOnce({
        uploadUrl: "https://storage.example/upload",
        objectKey: `reports/${job.id}/b.bin`,
        expiresAt: "2030-01-01T00:00:00.000Z",
      });

    render(<InspectorReportForm job={job} />);
    choosePhotos([makeFile("b.jpg", "image/png")]);

    expect(
      await screen.findByText("Photo upload failed. Please try again."),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    await waitFor(() =>
      expect(screen.getByText(/Uploaded ✓/)).toBeInTheDocument(),
    );
    expect(uploadSpy).toHaveBeenCalledTimes(2);
  });

  it("submits a complete report with the room checklist as a record", async () => {
    let uploadCount = 0;
    vi.mocked(inspectorApi.uploadJobPhoto).mockImplementation((_jobId) => {
      uploadCount += 1;
      return Promise.resolve({
        uploadUrl: "https://storage.example/upload",
        objectKey: `reports/${job.id}/photo-${uploadCount}.bin`,
        expiresAt: "2030-01-01T00:00:00.000Z",
      });
    });
    const submitJobReport = vi.mocked(inspectorApi.submitJobReport).mockResolvedValue({
      jobId: job.id,
      status: "submitted",
      submittedAt: "2026-10-01T00:00:00.000Z",
    });

    render(<InspectorReportForm job={job} />);
    choosePhotos([
      makeFile("1.jpg", "image/jpeg"),
      makeFile("2.jpg", "image/jpeg"),
      makeFile("3.jpg", "image/jpeg"),
    ]);
    await waitFor(() =>
      expect(screen.getAllByText(/Uploaded ✓/)).toHaveLength(3),
    );

    fireEvent.change(screen.getByLabelText(/overall grade/i), {
      target: { value: "B" },
    });
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "Include Living room in the checklist",
      }),
    );
    fireEvent.change(screen.getByLabelText(/notes \(at least 20 characters\)/i), {
      target: { value: "Main structure solid, minor cracking near window frames." },
    });

    fireEvent.click(screen.getByRole("button", { name: /submit report/i }));
    await waitFor(() =>
      expect(submitJobReport).toHaveBeenCalledWith(
        job.id,
        expect.objectContaining({
          overallGrade: "B",
          roomChecklist: { "Living room": "pass" },
          photoKeys: [
            `reports/${job.id}/photo-1.bin`,
            `reports/${job.id}/photo-2.bin`,
            `reports/${job.id}/photo-3.bin`,
          ],
          notes: "Main structure solid, minor cracking near window frames.",
        }),
      ),
    );
  });
});
