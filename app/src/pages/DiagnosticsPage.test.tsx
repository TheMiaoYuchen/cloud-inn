import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { VisualJobProjection } from "../domain/reliability/reliabilityTypes";
import { ReliabilityProvider } from "../state/ReliabilityProvider";
import { DiagnosticsPage } from "./DiagnosticsPage";
import { makeReliabilityPort, TEST_SAVE } from "./reliabilityTestSupport";

describe("DiagnosticsPage", () => {
  it("renders at most twenty redacted job facts and stable codes", async () => {
    const jobs = Array.from({ length: 25 }, (_, index) => ({
      jobId: `job-${index}`, saveId: TEST_SAVE.saveId, jobRevision: 1, status: "failed-terminal", targetKind: "master",
      targetFingerprint: `/Users/private/${index}`, requestFingerprint: "secret prompt contents", resolution: "2k",
      selectedModel: "private-provider-model", attemptCount: 1, nextAttemptAtMs: null, asset: null,
      errorCode: "provider.safety-rejected", responseAmbiguous: false, createdAtMs: index, updatedAtMs: index,
    })) as VisualJobProjection[];
    const port = makeReliabilityPort({ listVisualJobs: vi.fn(async () => jobs) });
    render(<ReliabilityProvider port={port}><DiagnosticsPage /></ReliabilityProvider>);

    await waitFor(() => expect(screen.getAllByText("生成失败")).toHaveLength(20));
    expect(document.body).not.toHaveTextContent("/Users/private");
    expect(document.body).not.toHaveTextContent("secret prompt contents");
    expect(document.body).not.toHaveTextContent("private-provider-model");
    expect(screen.getAllByText("provider.safety-rejected")).toHaveLength(20);
  });
});

