import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createNewGame } from "../domain/game/state";
import type { VisualJobProjection } from "../domain/reliability/reliabilityTypes";
import { InMemorySavePort } from "../infrastructure/memory/InMemorySavePort";
import { GameProvider, useGame } from "../state/GameProvider";
import { ReliabilityProvider, useReliability } from "../state/ReliabilityProvider";
import { DesignStudioPage } from "./DesignStudioPage";
import { makeReliabilityPort, TEST_SAVE } from "./reliabilityTestSupport";

describe("DesignStudioPage", () => {
  afterEach(() => vi.useRealTimers());
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

  it("reloads live game state after adopting an externally persisted visual", async () => {
    const savePort = new InMemorySavePort();
    const initial = { ...createNewGame(TEST_SAVE.saveId), revision: 1 };
    await savePort.commit(0, initial);
    const job = {
      jobId: "job-adopt", saveId: TEST_SAVE.saveId, jobRevision: 1, status: "ready-for-review", targetKind: "master",
      targetFingerprint: "target", requestFingerprint: "request", resolution: "2k", selectedModel: "model",
      attemptCount: 1, nextAttemptAtMs: null, asset: { assetId: "a".repeat(64), mimeType: "image/png", byteLength: 1, width: 1, height: 1, sha256: "a".repeat(64), resolverUrl: `cloudinn-asset://${"a".repeat(64)}` }, errorCode: null, responseAmbiguous: false,
      createdAtMs: 1, updatedAtMs: 2,
    } as VisualJobProjection;
    const adopted = { ...job, status: "adopted", jobRevision: 2 } as VisualJobProjection;
    const port = makeReliabilityPort({
      listVisualJobs: vi.fn(async () => [adopted.status === "adopted" && (await savePort.load(TEST_SAVE.saveId))?.revision === 2 ? adopted : job]),
      confirmVisualAdoption: vi.fn(async () => {
        await savePort.commit(1, { ...initial, revision: 2 });
        return { job: adopted, gameRevision: 2 };
      }),
    });
    function Revision() { return <output aria-label="game revision">{useGame().state?.revision ?? "loading"}</output>; }
    render(<ReliabilityProvider port={port}><GameProvider savePort={savePort}><Revision /><DesignStudioPage /></GameProvider></ReliabilityProvider>);
    expect(await screen.findByRole("button", { name: "采用效果图" })).toBeInTheDocument();

    await userEvent.setup().click(screen.getByRole("button", { name: "采用效果图" }));

    expect(await screen.findByRole("status", { name: "game revision" })).toHaveTextContent("2");
  });

  it("does not overlap slow polling requests", async () => {
    vi.useFakeTimers();
    const waiting = {
      jobId: "job-waiting", saveId: TEST_SAVE.saveId, jobRevision: 1, status: "waiting-network", targetKind: "master",
      targetFingerprint: "target", requestFingerprint: "request", resolution: "2k", selectedModel: null,
      attemptCount: 0, nextAttemptAtMs: null, asset: null, errorCode: "network.offline", responseAmbiguous: false,
      createdAtMs: 1, updatedAtMs: 1,
    } as VisualJobProjection;
    let resolveSecond!: (jobs: VisualJobProjection[]) => void;
    const listVisualJobs = vi.fn(async () => [waiting])
      .mockResolvedValueOnce([waiting])
      .mockImplementationOnce(() => new Promise<VisualJobProjection[]>((resolve) => { resolveSecond = resolve; }));
    const port = makeReliabilityPort({ listVisualJobs });
    const savePort = new InMemorySavePort();
    await savePort.commit(0, { ...createNewGame(TEST_SAVE.saveId), revision: 1 });
    render(<ReliabilityProvider port={port}><GameProvider savePort={savePort}><DesignStudioPage /></GameProvider></ReliabilityProvider>);
    await act(async () => {});
    expect(listVisualJobs).toHaveBeenCalledTimes(1);

    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    expect(listVisualJobs).toHaveBeenCalledTimes(2);
    act(() => vi.advanceTimersByTime(4_000));
    expect(listVisualJobs).toHaveBeenCalledTimes(2);

    await act(async () => resolveSecond([waiting]));
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    expect(listVisualJobs).toHaveBeenCalledTimes(3);
  });

  it("shows only state-machine-valid retry and 1K fallback actions", async () => {
    const base = {
      saveId: TEST_SAVE.saveId, jobRevision: 1, targetKind: "master", targetFingerprint: "target", requestFingerprint: "request",
      selectedModel: null, attemptCount: 0, nextAttemptAtMs: 1_700_000_000_000, asset: null, errorCode: null, responseAmbiguous: false, createdAtMs: 1, updatedAtMs: 1,
    } as const;
    const jobs = [
      { ...base, jobId: "blocked", status: "blocked-no-credential", resolution: "2k" },
      { ...base, jobId: "fallback", status: "needs-player-confirmation", resolution: "1k", selectedModel: "gemini-3.1-flash-image", errorCode: "provider.model-unavailable" },
      { ...base, jobId: "ambiguous", status: "needs-retry-confirmation", resolution: "1k", selectedModel: "gemini-3.1-flash-image", errorCode: "network.timeout", responseAmbiguous: true },
      { ...base, jobId: "fallback-ready", status: "ready-for-review", resolution: "1k", selectedModel: "gemini-2.5-flash-image" },
      { ...base, jobId: "failed", status: "failed-retryable", resolution: "1k" },
    ] as VisualJobProjection[];
    const port = makeReliabilityPort({ listVisualJobs: vi.fn(async () => jobs) });
    const savePort = new InMemorySavePort();
    await savePort.commit(0, { ...createNewGame(TEST_SAVE.saveId), revision: 1 });
    render(<ReliabilityProvider port={port}><GameProvider savePort={savePort}><DesignStudioPage /></GameProvider></ReliabilityProvider>);

    expect(await screen.findAllByRole("button", { name: "重试" })).toHaveLength(2);
    expect(screen.getByRole("button", { name: "确认额外请求并改用兼容 1K" })).toBeInTheDocument();
    expect(screen.getAllByText("下次可重试")).toHaveLength(5);
    expect(screen.getAllByText("主模型 · gemini-3.1-flash-image")).toHaveLength(2);
    expect(screen.getByText("兼容模型 · gemini-2.5-flash-image")).toBeInTheDocument();
    expect(screen.getByText(/占用今日额度，发起一次新的兼容 1K 请求/)).toBeInTheDocument();
  });

  it("enables focus only after master adoption and sends that exact asset reference", async () => {
    const masterAssetId = "a".repeat(64);
    const baseState = createNewGame(TEST_SAVE.saveId);
    const state = {
      ...baseState,
      revision: 1,
      roomBlueprint: {
        id: "room-type-1" as never,
        name: "Suite",
        columns: 8,
        rows: 12,
        cells: [],
        metrics: { areaSquareMeters: 24, buildCostCents: 100 as never, suggestedRateCents: 200 as never, businessFitBps: 8_000 as never },
        visual: { status: "ready" as const, assetPath: `cloudinn-asset://${masterAssetId}` },
      },
    };
    const queued = {
      jobId: "focus-job", saveId: TEST_SAVE.saveId, jobRevision: 0, status: "queued", targetKind: "focus",
      targetFingerprint: "target", requestFingerprint: "request", resolution: "1k", selectedModel: null,
      attemptCount: 0, nextAttemptAtMs: null, asset: null, errorCode: null, responseAmbiguous: false, createdAtMs: 1, updatedAtMs: 1,
    } as VisualJobProjection;
    const enqueueVisualJob = vi.fn(async () => queued);
    const port = makeReliabilityPort({ enqueueVisualJob, listVisualJobs: vi.fn(async () => []) });
    const savePort = new InMemorySavePort();
    await savePort.commit(0, state);
    render(<ReliabilityProvider port={port}><GameProvider savePort={savePort}><DesignStudioPage /></GameProvider></ReliabilityProvider>);
    const user = userEvent.setup();

    await user.type(await screen.findByLabelText("描述想要的氛围与材质"), "浴室材质细节");
    await user.selectOptions(screen.getByLabelText("画面类型"), "focus");
    await user.selectOptions(screen.getByLabelText("分辨率"), "1k");
    await user.click(screen.getByRole("button", { name: "加入生成队列" }));

    expect(enqueueVisualJob).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({
        targetKind: "focus",
        referenceAssetIds: [masterAssetId],
      }),
    }));
  });

  it("disables focus generation until a master image has been adopted", async () => {
    const savePort = new InMemorySavePort();
    await savePort.commit(0, { ...createNewGame(TEST_SAVE.saveId), revision: 1 });
    render(<ReliabilityProvider port={makeReliabilityPort()}><GameProvider savePort={savePort}><DesignStudioPage /></GameProvider></ReliabilityProvider>);

    expect(await screen.findByRole("option", { name: "局部细节" })).toBeDisabled();
    expect(screen.getByText(/先生成并采用主效果图/)).toBeInTheDocument();
  });

  it("does not let an old action reload jobs after switching saves", async () => {
    const saveB = { ...TEST_SAVE, saveId: "save-b" as typeof TEST_SAVE.saveId, displayName: "B" };
    const stateA = { ...createNewGame(TEST_SAVE.saveId), revision: 1 };
    const stateB = { ...createNewGame(saveB.saveId), revision: 1 };
    const savePort = new InMemorySavePort();
    await savePort.commit(0, stateA);
    await savePort.commit(0, stateB);
    const retryable = {
      jobId: "job-a", saveId: TEST_SAVE.saveId, jobRevision: 1, status: "failed-retryable", targetKind: "master",
      targetFingerprint: "target-a", requestFingerprint: "request-a", resolution: "2k", selectedModel: null,
      attemptCount: 1, nextAttemptAtMs: null, asset: null, errorCode: "network.timeout", responseAmbiguous: false, createdAtMs: 1, updatedAtMs: 1,
    } as VisualJobProjection;
    const bJob = { ...retryable, jobId: "job-b", saveId: saveB.saveId, status: "cancelled", targetFingerprint: "target-b" } as VisualJobProjection;
    let finishRetry!: () => void;
    const listVisualJobs = vi.fn(async (saveId) => saveId === TEST_SAVE.saveId ? [retryable] : [bJob]);
    const retryVisualJob = vi.fn(() => new Promise<VisualJobProjection>((resolve) => {
      finishRetry = () => resolve({ ...retryable, status: "queued", jobRevision: 2 });
    }));
    const port = makeReliabilityPort({ listSaves: vi.fn(async () => [TEST_SAVE, saveB]), listVisualJobs, retryVisualJob });
    function Experience() {
      const { activeSaveId, selectSave } = useReliability();
      if (!activeSaveId) return null;
      return <GameProvider savePort={savePort} saveId={activeSaveId}><button onClick={() => void selectSave(saveB.saveId)}>切到 B</button><DesignStudioPage /></GameProvider>;
    }
    render(<ReliabilityProvider port={port}><Experience /></ReliabilityProvider>);
    await userEvent.setup().click(await screen.findByRole("button", { name: "重试" }));
    await userEvent.setup().click(screen.getByRole("button", { name: "切到 B" }));
    expect(await screen.findByText("已取消")).toBeInTheDocument();
    const aCallsBeforeCompletion = listVisualJobs.mock.calls.filter(([saveId]) => saveId === TEST_SAVE.saveId).length;

    await act(async () => finishRetry());
    await act(async () => {});

    expect(screen.getByText("已取消")).toBeInTheDocument();
    expect(listVisualJobs.mock.calls.filter(([saveId]) => saveId === TEST_SAVE.saveId)).toHaveLength(aCallsBeforeCompletion);
  });
});
