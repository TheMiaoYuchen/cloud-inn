import { describe, expect, it } from "vitest";

import sharedPhase4Fixture from "../../../src-tauri/tests/fixtures/phase4-valid.json";
import { validateBrowserGameState } from "./validateBrowserGameState";

const EXPECTED_INVALID_FIXTURES = [
  "bad-report-arithmetic.json",
  "excessive-cells.json",
  "excessive-floors.json",
  "excessive-flow-events.json",
  "excessive-history.json",
  "excessive-items.json",
  "excessive-rooms.json",
  "forbidden-base64.json",
  "forbidden-credential.json",
  "unknown-catalog-reference.json",
] as const;

const EXPECTED_ERRORS: Readonly<Record<(typeof EXPECTED_INVALID_FIXTURES)[number], string>> = {
  "bad-report-arithmetic.json": "经营报告算术不一致",
  "excessive-cells.json": "公共空间蓝图格子最多保留8192项",
  "excessive-floors.json": "楼层最多保留64层",
  "excessive-flow-events.json": "流动事件最多保留150项",
  "excessive-history.json": "设施历史最多保留30天",
  "excessive-items.json": "公共空间蓝图物品最多保留256项",
  "excessive-rooms.json": "客房最多保留240间",
  "forbidden-base64.json": "禁止持久化Base64数据",
  "forbidden-credential.json": "禁止持久化凭据",
  "unknown-catalog-reference.json": "目录引用无效",
};

const sharedInvalidModules = import.meta.glob(
  "../../../src-tauri/tests/fixtures/phase4-invalid/*.json",
  { eager: true, import: "default" },
) as Record<string, unknown>;

const sharedInvalidFixtures = Object.entries(sharedInvalidModules)
  .map(([modulePath, snapshot]) => {
    const parts = modulePath.split("/");
    return [parts[parts.length - 1], snapshot] as const;
  })
  .sort(([left], [right]) => left.localeCompare(right));

describe("complete Phase 4 browser persistence validation", () => {
  it("enumerates the exact shared invalid fixture manifest", () => {
    expect(sharedInvalidFixtures.map(([name]) => name)).toEqual(EXPECTED_INVALID_FIXTURES);
  });

  it("accepts the shared maximum Phase 4 fixture", () => {
    const value = structuredClone(sharedPhase4Fixture);
    expect(() => validateBrowserGameState(value, "phase4-shared")).not.toThrow();
    expect(value.phase4.floors).toHaveLength(64);
    expect(value.phase4.floors.flatMap(({ rooms }) => rooms)).toHaveLength(240);
    expect(Object.keys(value.phase4.publicSpaces)).toHaveLength(32);
    expect(Object.keys(value.phase4.facilities)).toHaveLength(32);
    expect(value.phase4.spaceBlueprints["space-blueprint:all-day-dining"].cells).toHaveLength(8_192);
    expect(value.phase4.spaceBlueprints["space-blueprint:all-day-dining"].placedItems).toHaveLength(256);
    expect(value.phase4.recentFlowSnapshot?.events).toHaveLength(150);
  });

  it.each(sharedInvalidFixtures)("rejects shared fixture %s with its stable error class", (name, snapshot) => {
    expect(() => validateBrowserGameState(structuredClone(snapshot), "phase4-shared"))
      .toThrow(EXPECTED_ERRORS[name as keyof typeof EXPECTED_ERRORS]);
  });

  it.each([
    ["duplicate-floor-id", (value: any) => { value.phase4.floors[1].id = value.phase4.floors[0].id; }],
    ["unknown-room-floor", (value: any) => { value.phase4.floors[4].rooms[0].floorId = "floor:unknown"; }],
    ["unsafe-money", (value: any) => { value.phase4.floors[4].rooms[0].committedBuildCostCents = Number.MAX_SAFE_INTEGER + 1; }],
    ["wrong-containing-floor", (value: any) => { value.phase4.floors[4].rooms[0].floorId = "floor:06"; }],
    ["malformed-record-key", (value: any) => { value.phase4.publicSpaces["Bad Key"] = value.phase4.publicSpaces[Object.keys(value.phase4.publicSpaces)[0]]; }],
    ["non-object-record-value", (value: any) => { value.phase4.spaceBlueprints[Object.keys(value.phase4.spaceBlueprints)[0]] = "bad"; }],
    ["record-key-id-mismatch", (value: any) => { value.phase4.facilities[Object.keys(value.phase4.facilities)[0]].id = "facility:mismatch"; }],
    ["duplicate-record-value-id", (value: any) => {
      const keys = Object.keys(value.phase4.publicSpaces);
      value.phase4.publicSpaces[keys[1]].id = value.phase4.publicSpaces[keys[0]].id;
    }],
  ] as const)("retains Task 2 regression %s", (_name, mutate) => {
    const value = structuredClone(sharedPhase4Fixture);
    mutate(value);
    expect(() => validateBrowserGameState(value, "phase4-shared")).toThrow("内容规模存档");
  });
});
