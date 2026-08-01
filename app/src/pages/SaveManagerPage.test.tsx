import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ReliabilityProvider } from "../state/ReliabilityProvider";
import { SaveManagerPage } from "./SaveManagerPage";
import { makeReliabilityPort, TEST_SAVE } from "./reliabilityTestSupport";
import { GameProvider } from "../state/GameProvider";
import { InMemorySavePort } from "../infrastructure/memory/InMemorySavePort";
import { createNewGame } from "../domain/game/state";

describe("SaveManagerPage", () => {
  it("offers safe save, archive and recovery actions without delete", async () => {
    const recoveryId = "recovery-1" as never;
    const restoreRecoveryPoint = vi.fn(async () => ({ saveId: TEST_SAVE.saveId, revision: 2 }));
    const port = makeReliabilityPort({
      restoreRecoveryPoint,
      listRecoveryPoints: vi.fn(async () => [{ recoveryId, kind: "automatic" as const, restoreRevision: 1, reason: "自动保存", createdAtMs: 1_700_000_000_000 }]),
    });
    const savePort = new InMemorySavePort();
    await savePort.commit(0, { ...createNewGame(TEST_SAVE.saveId), revision: 1 });
    const load = vi.spyOn(savePort, "load");
    render(<ReliabilityProvider port={port}><GameProvider savePort={savePort}><SaveManagerPage /></GameProvider></ReliabilityProvider>);

    expect(await screen.findByRole("heading", { name: "存档管理" })).toBeInTheDocument();
    expect(await screen.findByText("自动恢复点")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "导出 .cloudinn" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /删除/ })).not.toBeInTheDocument();

    await userEvent.setup().click(screen.getByRole("button", { name: "恢复到这里" }));
    expect(restoreRecoveryPoint).toHaveBeenCalledWith(TEST_SAVE.saveId, recoveryId);
    await waitFor(() => expect(load.mock.calls.length).toBeGreaterThanOrEqual(2));
  });
});
