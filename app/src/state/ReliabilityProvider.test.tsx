import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { SaveId } from "../domain/primitives";
import { makeReliabilityPort, TEST_SAVE } from "../pages/reliabilityTestSupport";
import { ReliabilityProvider, useReliability } from "./ReliabilityProvider";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function Probe() {
  const { activeSaveId, selectSave } = useReliability();
  return <><output>{activeSaveId ?? "none"}</output><button onClick={() => void selectSave("save-b" as SaveId).catch(() => undefined)}>B</button><button onClick={() => void selectSave("save-c" as SaveId).catch(() => undefined)}>C</button></>;
}

describe("ReliabilityProvider save activation", () => {
  it("fails closed when native asset scope activation fails", async () => {
    const port = makeReliabilityPort({
      activateSaveAssets: vi.fn(async (saveId) => {
        if (saveId === "save-b") throw { code: "save.invalid-id" };
      }),
    });
    render(<ReliabilityProvider port={port}><Probe /></ReliabilityProvider>);
    expect(await screen.findByText(TEST_SAVE.saveId)).toBeInTheDocument();

    await userEvent.setup().click(screen.getByRole("button", { name: "B" }));

    expect(screen.getByText(TEST_SAVE.saveId)).toBeInTheDocument();
  });

  it("serializes activation and only commits the latest selection intent", async () => {
    const b = deferred();
    const c = deferred();
    const calls: string[] = [];
    const port = makeReliabilityPort({
      activateSaveAssets: vi.fn(async (saveId) => {
        calls.push(saveId);
        if (saveId === "save-b") await b.promise;
        if (saveId === "save-c") await c.promise;
      }),
    });
    render(<ReliabilityProvider port={port}><Probe /></ReliabilityProvider>);
    expect(await screen.findByText(TEST_SAVE.saveId)).toBeInTheDocument();
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "B" }));
    await user.click(screen.getByRole("button", { name: "C" }));
    expect(calls).toEqual([TEST_SAVE.saveId, "save-b"]);

    await act(async () => b.resolve());
    expect(screen.getByText(TEST_SAVE.saveId)).toBeInTheDocument();
    expect(calls).toEqual([TEST_SAVE.saveId, "save-b", "save-c"]);

    await act(async () => c.resolve());
    expect(await screen.findByText("save-c")).toBeInTheDocument();
  });

  it("restores the committed native scope when the latest activation fails", async () => {
    const b = deferred();
    const calls: string[] = [];
    const port = makeReliabilityPort({
      activateSaveAssets: vi.fn(async (saveId) => {
        calls.push(saveId);
        if (saveId === "save-b") await b.promise;
        if (saveId === "save-c") throw { code: "save.invalid-id" };
      }),
    });
    render(<ReliabilityProvider port={port}><Probe /></ReliabilityProvider>);
    expect(await screen.findByText(TEST_SAVE.saveId)).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "B" }));
    await user.click(screen.getByRole("button", { name: "C" }));

    await act(async () => b.resolve());
    await act(async () => {});

    expect(screen.getByText(TEST_SAVE.saveId)).toBeInTheDocument();
    expect(calls).toEqual([TEST_SAVE.saveId, "save-b", "save-c", TEST_SAVE.saveId]);
  });
});
