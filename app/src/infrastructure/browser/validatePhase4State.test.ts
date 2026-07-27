import { describe, expect, it } from "vitest";

import duplicateFloorId from "../../../src-tauri/tests/fixtures/phase4-invalid/duplicate-floor-id.json";
import unknownRoomFloor from "../../../src-tauri/tests/fixtures/phase4-invalid/unknown-room-floor.json";
import unsafeMoney from "../../../src-tauri/tests/fixtures/phase4-invalid/unsafe-money.json";
import sharedPhase4Fixture from "../../../src-tauri/tests/fixtures/phase4-valid.json";
import { createPhase4AcceptanceState } from "../../testing/phase4Fixtures";
import { validateBrowserGameState } from "./validateBrowserGameState";

function sharedPhase4Json(): unknown {
  return structuredClone(sharedPhase4Fixture);
}

describe("minimal Phase 4 browser persistence validation", () => {
  it("matches and accepts the checked-in cross-runtime fixture", () => {
    const json = sharedPhase4Json();
    expect(json).toEqual(
      JSON.parse(
        JSON.stringify(createPhase4AcceptanceState("phase4-shared")),
      ),
    );
    expect(() =>
      validateBrowserGameState(json, "phase4-shared"),
    ).not.toThrow();
  });

  it.each([
    ["duplicate floor ID", duplicateFloorId, "楼层编号重复"],
    ["room with unknown floor", unknownRoomFloor, "客房楼层引用无效"],
    ["unsafe construction money", unsafeMoney, "施工金额必须是安全整数"],
  ])("rejects a shared snapshot with %s", (_label, snapshot, message) => {
    expect(() =>
      validateBrowserGameState(structuredClone(snapshot), "phase4-shared"),
    ).toThrow(message);
  });

  it("rejects malformed stable IDs outside the identity collections", () => {
    const snapshot = sharedPhase4Json() as {
      phase4: { building: { templateId: string } };
    };
    snapshot.phase4.building.templateId = "Building Template";

    expect(() =>
      validateBrowserGameState(snapshot, "phase4-shared"),
    ).toThrow("稳定 ID");
  });
});
