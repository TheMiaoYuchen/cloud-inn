import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createNewGame } from "../domain/game/state";
import type { VisualJobProjection } from "../domain/reliability/reliabilityTypes";
import { InMemorySavePort } from "../infrastructure/memory/InMemorySavePort";
import { GameProvider } from "../state/GameProvider";
import { ReliabilityProvider } from "../state/ReliabilityProvider";
import { DesignStudioPage } from "./DesignStudioPage";
import { makeReliabilityPort, TEST_SAVE } from "./reliabilityTestSupport";

describe("DesignStudioPage", () => {
  it("shows durable status, economic safety and recovery guidance for a missing asset", async () => {
    const job = {
      jobId: "job-1", saveId: TEST_SAVE.saveId, jobRevision: 2, status: "ready-for-review", targetKind: "master",
      targetFingerprint: "target", requestFingerprint: "request", resolution: "2k", selectedModel: "private-model-name",
      attemptCount: 1, nextAttemptAtMs: null, asset: null, errorCode: "asset.not-found", responseAmbiguous: false,
      createdAtMs: 1, updatedAtMs: 2,
    } as VisualJobProjection;
    const port = makeReliabilityPort({ listVisualJobs: vi.fn(async () => [job]) });
    const savePort = new InMemorySavePort();
    await savePort.commit(0, { ...createNewGame(TEST_SAVE.saveId), revision: 1 });
    render(<ReliabilityProvider port={port}><GameProvider savePort={savePort}><DesignStudioPage /></GameProvider></ReliabilityProvider>);

    expect(await screen.findByText("等待审阅")).toBeInTheDocument();
    expect(screen.getByText(/不会修改蓝图、价格、房间指标或任何经济数据/)).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "效果图文件缺失" })).toHaveTextContent("前往存档管理选择恢复点");
  });
});

