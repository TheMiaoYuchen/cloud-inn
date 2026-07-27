import { beforeEach, describe, expect, it } from "vitest";

import { createNewGame, type GameState } from "../../domain/game/state";
import { LocalStorageSavePort } from "./LocalStorageSavePort";

const storageKey = (saveId: string) => `cloud-inn:save:${saveId}`;

function revision(state: GameState, value: number): GameState {
  return { ...state, revision: value };
}

function fakeLockManager(): LockManager {
  let tail = Promise.resolve();
  return {
    request: (_name: string, callback: LockGrantedCallback) => {
      const run = tail.then(() => callback({ name: _name, mode: "exclusive" }));
      tail = run.then(() => undefined, () => undefined);
      return run;
    },
    query: async () => ({ held: [], pending: [] }),
  } as LockManager;
}

describe("LocalStorageSavePort", () => {
  beforeEach(() => window.localStorage.clear());

  it.each([
    ["invalid JSON", "{"],
    ["non-object root", "null"],
    ["invalid revision", JSON.stringify({ ...createNewGame("safe"), revision: -1 })],
    ["mismatched save id", JSON.stringify(createNewGame("other"))],
    ["invalid phase", JSON.stringify({ ...createNewGame("safe"), phase: "closed" })],
    [
      "unsafe phase two visual asset",
      JSON.stringify({
        ...createNewGame("safe"),
        phase2: {
          hotelGene: { palette: "p", materials: ["m"], metal: "x", lighting: "l", mood: "m" },
          roomMaster: null,
          roomVariants: [],
          corridorTemplate: null,
          designVisuals: {
            status: "complete",
            assets: [{ request: { kind: "master" }, assetPath: "data:image/png;base64,x" }],
            errors: [],
          },
        },
      }),
    ],
    [
      "sensitive phase two metadata",
      JSON.stringify({
        ...createNewGame("safe"),
        phase2: {
          hotelGene: { palette: "p", materials: ["m"], metal: "x", lighting: "l", mood: "m" },
          roomMaster: null,
          roomVariants: [],
          corridorTemplate: null,
          providerToken: "secret-value",
        },
      }),
    ],
  ])("rejects %s with a readable error", async (_label, stored) => {
    window.localStorage.setItem(storageKey("safe"), stored);

    await expect(new LocalStorageSavePort().load("safe")).rejects.toThrow(
      "浏览器存档已损坏",
    );
  });

  it("loads a structurally valid game without returning storage-owned data", async () => {
    const state = revision(createNewGame("safe"), 1);
    window.localStorage.setItem(storageKey(state.saveId), JSON.stringify(state));

    const loaded = await new LocalStorageSavePort().load(state.saveId);

    expect(loaded).toEqual(state);
    expect(loaded).not.toBe(state);
  });

  it("serializes commits across instances so one stale writer is rejected", async () => {
    const locks = fakeLockManager();
    const firstPort = new LocalStorageSavePort(locks);
    const secondPort = new LocalStorageSavePort(locks);
    const base = createNewGame("concurrent");
    const first = revision({ ...base, cashCents: 10 }, 1);
    const second = revision({ ...base, cashCents: 20 }, 1);

    const results = await Promise.allSettled([
      firstPort.commit(0, first),
      secondPort.commit(0, second),
    ]);

    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(results.filter(({ status }) => status === "rejected")).toHaveLength(1);
    const stored = await firstPort.load(base.saveId);
    expect([10, 20]).toContain(stored?.cashCents);
    expect(stored?.revision).toBe(1);
  });

  it("fails closed without Web Locks and preserves the stored value", async () => {
    const saveId = "no-locks";
    const original = revision(createNewGame(saveId), 1);
    window.localStorage.setItem(storageKey(saveId), JSON.stringify(original));
    const rawBefore = window.localStorage.getItem(storageKey(saveId));

    await expect(
      new LocalStorageSavePort(null).commit(
        1,
        revision({ ...original, cashCents: 1 }, 2),
      ),
    ).rejects.toThrow("浏览器不支持安全存档锁");

    expect(window.localStorage.getItem(storageKey(saveId))).toBe(rawBefore);
  });
});
