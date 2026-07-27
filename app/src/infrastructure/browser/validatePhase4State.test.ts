import { describe, expect, it } from "vitest";

import duplicateFloorId from "../../../src-tauri/tests/fixtures/phase4-invalid/duplicate-floor-id.json";
import duplicateRecordValueId from "../../../src-tauri/tests/fixtures/phase4-invalid/duplicate-record-value-id.json";
import malformedRecordKey from "../../../src-tauri/tests/fixtures/phase4-invalid/malformed-record-key.json";
import nonObjectRecordValue from "../../../src-tauri/tests/fixtures/phase4-invalid/non-object-record-value.json";
import recordKeyIdMismatch from "../../../src-tauri/tests/fixtures/phase4-invalid/record-key-id-mismatch.json";
import unknownRoomFloor from "../../../src-tauri/tests/fixtures/phase4-invalid/unknown-room-floor.json";
import unsafeMoney from "../../../src-tauri/tests/fixtures/phase4-invalid/unsafe-money.json";
import wrongContainingFloor from "../../../src-tauri/tests/fixtures/phase4-invalid/wrong-containing-floor.json";
import sharedPhase4Fixture from "../../../src-tauri/tests/fixtures/phase4-valid.json";
import { createPhase4AcceptanceState } from "../../testing/phase4Fixtures";
import { validateBrowserGameState } from "./validateBrowserGameState";

function sharedPhase4Json(): unknown {
  return structuredClone(sharedPhase4Fixture);
}

function phase4JsonWithMoneyToken(token: string): unknown {
  const json = JSON.stringify(sharedPhase4Fixture);
  const original = '"committedBuildCostCents":2500000';
  expect(json).toContain(original);
  return JSON.parse(json.replace(original, `"committedBuildCostCents":${token}`));
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
    ["room owned by another existing floor", wrongContainingFloor, "客房必须属于所在楼层"],
    ["malformed identity record key", malformedRecordKey, "记录键必须是稳定 ID"],
    ["non-object identity record value", nonObjectRecordValue, "公共空间蓝图结构无效"],
    ["identity record key and ID mismatch", recordKeyIdMismatch, "记录键与编号不一致"],
    ["duplicate identity record value ID", duplicateRecordValueId, "公共空间编号重复"],
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

  it.each(["2500000.0", "25e5", "9007199254740991.0"])(
    "accepts safe integral construction money token %s",
    (token) => {
      expect(() =>
        validateBrowserGameState(
          phase4JsonWithMoneyToken(token),
          "phase4-shared",
        ),
      ).not.toThrow();
    },
  );

  it.each([
    "2500000.5",
    "-1.0",
    "9007199254740992",
    "9007199254740992.0",
    "1e400",
  ])(
    "rejects unsafe construction money token %s",
    (token) => {
      expect(() =>
        validateBrowserGameState(
          phase4JsonWithMoneyToken(token),
          "phase4-shared",
        ),
      ).toThrow("施工金额必须是安全整数");
    },
  );
});
