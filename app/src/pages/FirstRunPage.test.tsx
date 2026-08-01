import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ReliabilityProvider } from "../state/ReliabilityProvider";
import { FirstRunPage } from "./FirstRunPage";
import { makeReliabilityPort, TEST_SAVE } from "./reliabilityTestSupport";

describe("FirstRunPage", () => {
  it("imports an inspected archive without creating a placeholder save", async () => {
    const inspection = { token: "inspection" as never, archiveVersion: 1 as const, sourceSaveId: TEST_SAVE.saveId, displayName: "导入酒店", schemaVersion: 1, rulesetVersion: "1", assetCount: 3, totalBytes: 10, expiresAtMs: 99 };
    const inspectImport = vi.fn(async () => inspection);
    const importSave = vi.fn(async () => TEST_SAVE);
    const createSave = vi.fn(async () => TEST_SAVE);
    const port = makeReliabilityPort({ listSaves: vi.fn(async () => []), inspectImport, importSave, createSave });
    render(<ReliabilityProvider port={port}><FirstRunPage /></ReliabilityProvider>);
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "导入 .cloudinn" }));
    expect(await screen.findByRole("status")).toHaveTextContent("导入酒店 · 3 个资源");
    await user.click(screen.getByRole("button", { name: "确认导入为新存档" }));

    expect(importSave).toHaveBeenCalledWith(inspection.token);
    expect(createSave).not.toHaveBeenCalled();
  });
  it("makes AI optional and clears the uncontrolled token after its single invoke", async () => {
    const setProviderToken = vi.fn(async () => ({ state: "available" as const }));
    const port = makeReliabilityPort({ listSaves: vi.fn(async () => []), setProviderToken });
    const user = userEvent.setup();
    render(<ReliabilityProvider port={port}><FirstRunPage /></ReliabilityProvider>);

    await user.type(screen.getByLabelText("存档名称"), "山间旅店");
    const token = screen.getByLabelText("提供方令牌") as HTMLInputElement;
    await user.type(token, "secret-token-123");
    await user.click(screen.getByRole("button", { name: "保存令牌并开始" }));

    await waitFor(() => expect(setProviderToken).toHaveBeenCalledTimes(1));
    expect(setProviderToken).toHaveBeenCalledWith("secret-token-123");
    expect(token).toHaveValue("");
    expect(document.body.innerHTML).not.toContain("secret-token-123");
    expect(port.createSave).toHaveBeenCalledWith("山间旅店");
  });

  it("creates a save without invoking AI setup", async () => {
    const port = makeReliabilityPort({ listSaves: vi.fn(async () => []), createSave: vi.fn(async () => TEST_SAVE) });
    const user = userEvent.setup();
    render(<ReliabilityProvider port={port}><FirstRunPage /></ReliabilityProvider>);
    await user.type(screen.getByLabelText("存档名称"), "离线旅店");
    await user.click(screen.getByRole("button", { name: "跳过 AI，开始经营" }));
    await waitFor(() => expect(port.createSave).toHaveBeenCalledWith("离线旅店"));
    expect(port.setProviderToken).not.toHaveBeenCalled();
  });
});
