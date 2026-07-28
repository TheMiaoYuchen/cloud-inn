import { describe, expect, it } from "vitest";

import sharedPhase4Fixture from "../../../src-tauri/tests/fixtures/phase4-valid.json";
import { validateBrowserGameState } from "./validateBrowserGameState";
import { validatePhase4State } from "./validatePhase4State";

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
    ["duplicate-floor-id", "入口楼层引用无效", (value: any) => { value.phase4.floors[1].id = value.phase4.floors[0].id; }],
    ["unknown-room-floor", "客房必须属于所在楼层", (value: any) => { value.phase4.floors[4].rooms[0].floorId = "floor:unknown"; }],
    ["unsafe-money", "施工金额必须是安全整数", (value: any) => { value.phase4.floors[4].rooms[0].committedBuildCostCents = Number.MAX_SAFE_INTEGER + 1; }],
    ["wrong-containing-floor", "客房必须属于所在楼层", (value: any) => { value.phase4.floors[4].rooms[0].floorId = "floor:06"; }],
    ["malformed-record-key", "公共空间最多保留32项", (value: any) => { value.phase4.publicSpaces["Bad Key"] = value.phase4.publicSpaces[Object.keys(value.phase4.publicSpaces)[0]]; }],
    ["non-object-record-value", "公共空间蓝图结构无效", (value: any) => { value.phase4.spaceBlueprints[Object.keys(value.phase4.spaceBlueprints)[0]] = "bad"; }],
    ["record-key-id-mismatch", "记录键与编号不一致", (value: any) => { value.phase4.facilities[Object.keys(value.phase4.facilities)[0]].id = "facility:mismatch"; }],
    ["duplicate-record-value-id", (value: any) => {
      const keys = Object.keys(value.phase4.publicSpaces);
      value.phase4.publicSpaces[keys[1]].id = value.phase4.publicSpaces[keys[0]].id;
    }],
  ].map((entry) => entry.length === 2 ? [entry[0], "记录键与编号不一致", entry[1]] : entry) as Array<[string, string, (value: any) => void]>)
  ("retains Task 2 regression %s with error class %s", (_name, errorClass, mutate) => {
    const value = structuredClone(sharedPhase4Fixture);
    mutate(value);
    expect(() => validateBrowserGameState(value, "phase4-shared")).toThrow(errorClass);
  });

  const facilityCases: Array<[string, (value: any, facility: any) => void]> = [
    ["unknown-developed-offering", (_value, facility) => { facility.developedOfferingIds = ["dish:unknown"]; }],
    ["unknown-signature-in-developed", (_value, facility) => {
      facility.developedOfferingIds = ["dish:unknown"];
      facility.policy.signatureOfferingId = "dish:unknown";
    }],
    ["wrong-offering-type", (_value, facility) => { facility.developedOfferingIds = ["drink:cloud-negroni"]; }],
    ["wrong-signature-group", (_value, facility) => {
      facility.developedOfferingIds = ["drink:cloud-negroni"];
      facility.policy.signatureOfferingId = "drink:cloud-negroni";
    }],
    ["unknown-menu", (_value, facility) => { facility.menuSelection.menuStructureId = "menu:unknown"; }],
    ["incompatible-menu", (_value, facility) => { facility.menuSelection.menuStructureId = "menu:bar-classics"; }],
    ["unknown-positioning", (_value, facility) => { facility.policy.positioningId = "positioning:unknown"; }],
    ["unknown-price", (_value, facility) => { facility.policy.priceBandId = "price-band:unknown"; }],
    ["unknown-opening", (_value, facility) => { facility.policy.openingPolicyId = "opening-policy:unknown"; }],
    ["wrong-policy-group", (_value, facility) => {
      facility.policy.positioningId = "positioning:restorative-wellness";
      facility.policy.openingPolicyId = "opening-policy:appointment-daily";
    }],
  ];

  it.each(facilityCases)("rejects facility catalog reference %s", (_name, mutate) => {
    const value = structuredClone(sharedPhase4Fixture) as any;
    const facility = Object.values(value.phase4.facilities).find(
      (candidate: any) => candidate.type === "all-day-dining",
    );
    mutate(value, facility);
    expect(() => validateBrowserGameState(value, "phase4-shared")).toThrow("目录引用无效");
  });

  const envelopeCases: Array<[string, string, (value: any) => void]> = [
    ["65 templates", "楼层模板最多保留64项", (value) => {
      for (let index = 0; index < 60; index += 1) {
        const id = `template:extra:${String(index).padStart(2, "0")}`;
        value.phase4.floorTemplates[id] = { ...value.phase4.floorTemplates["template:entrance:standard"], id };
      }
    }],
    ["zero template columns", "楼层模板列数必须是安全整数", (value) => { value.phase4.floorTemplates["template:guest:dense-ring"].columns = 0; }],
    ["oversized template rows", "楼层模板行数必须是安全整数", (value) => { value.phase4.floorTemplates["template:guest:dense-ring"].rows = 513; }],
    ["wrong cell area", "楼层模板单元面积无效", (value) => { value.phase4.floorTemplates["template:guest:dense-ring"].cellAreaSquareMeters = 2; }],
    ["fractional anchor", "客房横坐标必须是安全整数", (value) => { value.phase4.floorTemplates["template:guest:dense-ring"].roomPlacements[0].anchorX = 0.5; }],
    ["negative anchor", "客房纵坐标必须是安全整数", (value) => { value.phase4.floorTemplates["template:guest:dense-ring"].roomPlacements[0].anchorY = -1; }],
    ["zero placement width", "客房宽度必须是安全整数", (value) => { value.phase4.floorTemplates["template:guest:dense-ring"].roomPlacements[0].width = 0; }],
    ["placement exceeds columns", "客房放置超出楼层模板", (value) => {
      value.phase4.floorTemplates["template:guest:dense-ring"].roomPlacements[0].anchorX = 23;
      value.phase4.floorTemplates["template:guest:dense-ring"].roomPlacements[0].width = 2;
    }],
    ["blank blueprint name", "公共空间名称文本无效", (value) => { value.phase4.spaceBlueprints["space-blueprint:bar"].name = " "; }],
    ["long blueprint name", "公共空间名称文本无效", (value) => { value.phase4.spaceBlueprints["space-blueprint:bar"].name = "中".repeat(257); }],
  ];

  it.each(envelopeCases)("rejects envelope invariant %s", (_name, errorClass, mutate) => {
    const value = structuredClone(sharedPhase4Fixture) as any;
    mutate(value);
    expect(() => validateBrowserGameState(value, "phase4-shared")).toThrow(errorClass);
  });

  it("rejects facility history later than the current day", () => {
    const value = structuredClone(sharedPhase4Fixture) as any;
    expect(() => validatePhase4State(value.phase4, { ...value, currentDay: 29 }))
      .toThrow("设施历史日期无效");
  });

  it("uses Unicode scalar counts for bounded strings", () => {
    const accepted = structuredClone(sharedPhase4Fixture) as any;
    accepted.phase4.persistenceMetadata = { description: "😀".repeat(3_000) };
    expect(() => validateBrowserGameState(accepted, "phase4-shared")).not.toThrow();

    const rejected = structuredClone(sharedPhase4Fixture) as any;
    rejected.phase4.persistenceMetadata = { description: "中".repeat(4_097) };
    expect(() => validateBrowserGameState(rejected, "phase4-shared")).toThrow("文本超过长度限制");
  });

  it("uses Unicode scalar counts for field names", () => {
    const accepted = structuredClone(sharedPhase4Fixture) as any;
    accepted.phase4.persistenceMetadata = { ["😀".repeat(100)]: "fixture" };
    expect(() => validateBrowserGameState(accepted, "phase4-shared")).not.toThrow();

    const rejected = structuredClone(sharedPhase4Fixture) as any;
    rejected.phase4.persistenceMetadata = { ["中".repeat(129)]: "fixture" };
    expect(() => validateBrowserGameState(rejected, "phase4-shared")).toThrow("字段名超过长度限制");
  });

  it.each([
    "password=hunter2", "secret: fixture", "credential=fixture", "api-key: fixture", "access_token=fixture",
    "Bearer abcdefghijklmnop", "secret phrase then secret=fixture",
  ])(
    "rejects forbidden credential value %s",
    (credential) => {
      const value = structuredClone(sharedPhase4Fixture) as any;
      value.phase4.persistenceMetadata = { description: credential };
      expect(() => validateBrowserGameState(value, "phase4-shared")).toThrow("禁止持久化凭据");
    },
  );

  it.each(["notsecret=fixture", "Bearer short"])("accepts non-credential value %s", (description) => {
    const value = structuredClone(sharedPhase4Fixture) as any;
    value.phase4.persistenceMetadata = { description };
    expect(() => validateBrowserGameState(value, "phase4-shared")).not.toThrow();
  });

  it.each(["password", "secret", "credential", "apiKey", "access_token"])(
    "rejects forbidden credential field %s",
    (field) => {
      const value = structuredClone(sharedPhase4Fixture) as any;
      value.phase4.persistenceMetadata = { [field]: "fixture" };
      expect(() => validateBrowserGameState(value, "phase4-shared")).toThrow("禁止持久化凭据");
    },
  );

  it("uses strict Base64 syntax", () => {
    const internalPadding = structuredClone(sharedPhase4Fixture) as any;
    internalPadding.phase4.persistenceMetadata = { description: `${"A".repeat(64)}=${"A".repeat(64)}` };
    expect(() => validateBrowserGameState(internalPadding, "phase4-shared")).not.toThrow();

    const strictBase64 = structuredClone(sharedPhase4Fixture) as any;
    strictBase64.phase4.persistenceMetadata = { description: "A".repeat(128) };
    expect(() => validateBrowserGameState(strictBase64, "phase4-shared")).toThrow("禁止持久化Base64数据");
  });
});
