import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

  it("updates and removes a keychain token without retaining the input", async () => {
    const setProviderToken = vi.fn(async () => ({ state: "available" as const }));
    const deleteProviderToken = vi.fn(async () => ({ state: "missing" as const }));
    const port = makeReliabilityPort({ setProviderToken, deleteProviderToken });
    render(<ReliabilityProvider port={port}><DiagnosticsPage /></ReliabilityProvider>);
    const user = userEvent.setup();
    const input = await screen.findByLabelText("更新服务令牌");

    await user.type(input, "new-token");
    await user.click(screen.getByRole("button", { name: "保存到钥匙串" }));

    await waitFor(() => expect(setProviderToken).toHaveBeenCalledWith("new-token"));
    expect(input).toHaveValue("");
    await user.click(screen.getByRole("button", { name: "删除服务令牌" }));
    await waitFor(() => expect(deleteProviderToken).toHaveBeenCalledTimes(1));
  });
});
