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

const TASK2_ERROR_CLASSES = {
  "duplicate-floor-id": "楼层编号重复",
  "unknown-room-floor": "客房楼层引用无效",
  "unsafe-money": "施工金额必须是安全整数",
  "wrong-containing-floor": "客房必须属于所在楼层",
  "malformed-record-key": "记录键必须是稳定 ID",
  "non-object-record-value": "公共空间蓝图结构无效",
  "record-key-id-mismatch": "记录键与编号不一致",
  "duplicate-record-value-id": "公共空间编号重复",
} as const;

const MAX_JSON_BYTES = 8 * 1024 * 1024;

function serializedBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function phase4FixtureWithSerializedBytes(target: number): any {
  const value = structuredClone(sharedPhase4Fixture) as any;
  const metadata: Record<string, unknown> = {
    asciiKey: "ascii value",
    "非ASCII键": "中文值",
    exponentNumber: JSON.parse("1e2"),
  };
  value.phase4.persistenceMetadata = metadata;
  let bytes = serializedBytes(value.phase4);
  let index = 0;
  let lastKey = "";

  while (true) {
    const key = `${"界".repeat(122)}${String(index).padStart(6, "0")}`;
    const emptyEntryBytes = serializedBytes({ [key]: "" }) - 2 + 1;
    const fullEntryBytes = emptyEntryBytes + 4_096;
    if (bytes + fullEntryBytes > target) break;
    metadata[key] = "!".repeat(4_096);
    bytes += fullEntryBytes;
    lastKey = key;
    index += 1;
  }

  const key = `${"界".repeat(122)}${String(index).padStart(6, "0")}`;
  const emptyEntryBytes = serializedBytes({ [key]: "" }) - 2 + (index === 0 ? 0 : 1);
  let deficit = target - bytes;
  if (deficit > 0 && deficit < emptyEntryBytes) {
    const prior = String(metadata[lastKey]);
    metadata[lastKey] = prior.slice(0, prior.length - (emptyEntryBytes - deficit));
    bytes -= emptyEntryBytes - deficit;
    deficit = target - bytes;
  }
  if (deficit > 0) metadata[key] = "!".repeat(deficit - emptyEntryBytes);

  expect(serializedBytes(value.phase4)).toBe(target);
  return value;
}

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

  it("keeps incomplete report segment catalogs in the general operations class", () => {
    const value = structuredClone(sharedPhase4Fixture) as any;
    value.operations.dailyReports[0].segments.pop();
    expect(() => validateBrowserGameState(value, "phase4-shared")).toThrow("经营存档");
    expect(() => validateBrowserGameState(value, "phase4-shared")).not.toThrow("经营报告算术");
  });

  it.each([
    ["duplicate-floor-id", (value: any) => { value.phase4.floors[1].id = value.phase4.floors[0].id; }],
    ["unknown-room-floor", (value: any) => { value.phase4.floors[4].rooms[0].floorId = "floor:unknown"; }],
    ["unsafe-money", (value: any) => { value.phase4.floors[4].rooms[0].committedBuildCostCents = Number.MAX_SAFE_INTEGER + 1; }],
    ["wrong-containing-floor", (value: any) => { value.phase4.floors[4].rooms[0].floorId = "floor:06"; }],
    ["malformed-record-key", (value: any) => { value.phase4.publicSpaces["Bad Key"] = structuredClone(value.phase4.publicSpaces[Object.keys(value.phase4.publicSpaces)[0]]); }],
    ["non-object-record-value", (value: any) => { value.phase4.spaceBlueprints[Object.keys(value.phase4.spaceBlueprints)[0]] = "bad"; }],
    ["record-key-id-mismatch", (value: any) => { value.phase4.facilities[Object.keys(value.phase4.facilities)[0]].id = "facility:mismatch"; }],
    ["duplicate-record-value-id", (value: any) => {
      const keys = Object.keys(value.phase4.publicSpaces);
      value.phase4.publicSpaces[keys[1]].id = value.phase4.publicSpaces[keys[0]].id;
    }],
  ] as Array<[keyof typeof TASK2_ERROR_CLASSES, (value: any) => void]>)
  ("retains Task 2 regression %s with its canonical error class", (name, mutate) => {
    const value = structuredClone(sharedPhase4Fixture);
    mutate(value);
    expect(() => validateBrowserGameState(value, "phase4-shared")).toThrow(TASK2_ERROR_CLASSES[name]);
  });

  it.each([
    [MAX_JSON_BYTES - 1, false],
    [MAX_JSON_BYTES, false],
    [MAX_JSON_BYTES + 1, true],
    [8_630_528, true],
  ] as const)("enforces exact serialized Phase 4 size %i", (target, rejected) => {
    const value = phase4FixtureWithSerializedBytes(target);
    const validation = () => validateBrowserGameState(value, "phase4-shared");
    if (rejected) expect(validation).toThrow("JSON超过大小限制");
    else expect(validation).not.toThrow();
  });

  it("rejects deep and cyclic extension trees with controlled errors", () => {
    const deep = structuredClone(sharedPhase4Fixture) as any;
    let cursor: any = {};
    deep.phase4.persistenceMetadata = cursor;
    for (let index = 0; index < 10_000; index += 1) {
      cursor.child = {};
      cursor = cursor.child;
    }
    expect(() => validatePhase4State(deep.phase4, deep)).toThrow("JSON嵌套过深");

    const cyclic = structuredClone(sharedPhase4Fixture) as any;
    cyclic.phase4.persistenceMetadata = {};
    cyclic.phase4.persistenceMetadata.self = cyclic.phase4.persistenceMetadata;
    expect(() => validatePhase4State(cyclic.phase4, cyclic)).toThrow("JSON包含循环或重复对象引用");

    const repeated = structuredClone(sharedPhase4Fixture) as any;
    const shared = { description: "fixture" };
    repeated.phase4.persistenceMetadata = { first: shared, second: shared };
    expect(() => validatePhase4State(repeated.phase4, repeated)).toThrow("JSON包含循环或重复对象引用");
  });

  it.each([
    ["duplicate public-space placement", "公共空间放置重复", (value: any) => {
      const spaces = Object.values(value.phase4.publicSpaces) as any[];
      spaces[1].floorId = spaces[0].floorId;
      spaces[1].localPlacementId = spaces[0].localPlacementId;
    }],
    ["duplicate facility ownership", "设施公共空间引用重复", (value: any) => {
      const facilities = Object.values(value.phase4.facilities) as any[];
      facilities[1].publicSpaceInstanceId = facilities[0].publicSpaceInstanceId;
      facilities[1].type = facilities[0].type;
    }],
    ["duplicate permitted type", "允许设施类型无效", (value: any) => {
      const slot = value.phase4.floorTemplates["template:facility:standard"].publicSpaceSlots[0];
      slot.permittedTypes.push(slot.permittedTypes[0]);
    }],
  ] as Array<[string, string, (value: any) => void]>)
  ("rejects graph cardinality invariant %s", (_name, errorClass, mutate) => {
    const value = structuredClone(sharedPhase4Fixture) as any;
    mutate(value);
    expect(() => validateBrowserGameState(value, "phase4-shared")).toThrow(errorClass);
  });

  it("enforces placed-item containment at the exact boundary", () => {
    const boundary = structuredClone(sharedPhase4Fixture) as any;
    const blueprint = boundary.phase4.spaceBlueprints["space-blueprint:all-day-dining"];
    blueprint.placedItems[0].x = blueprint.columns - blueprint.placedItems[0].width;
    blueprint.placedItems[0].y = blueprint.rows - blueprint.placedItems[0].height;
    expect(() => validateBrowserGameState(boundary, "phase4-shared")).not.toThrow();

    const outside = structuredClone(boundary);
    outside.phase4.spaceBlueprints["space-blueprint:all-day-dining"].placedItems[0].width += 1;
    expect(() => validateBrowserGameState(outside, "phase4-shared")).toThrow("公共空间物品超出蓝图");
  });

  const slotGeometryCases: Array<[string, string, (slot: any) => void]> = [
    ["partial", "公共空间槽位几何必须完整", (slot) => { slot.anchorX = 0; }],
    ["string", "公共空间槽位几何必须是安全整数", (slot) => {
      Object.assign(slot, { anchorX: "0", anchorY: 0, width: 1, height: 1 });
    }],
    ["fraction", "公共空间槽位几何必须是安全整数", (slot) => {
      Object.assign(slot, { anchorX: 0.5, anchorY: 0, width: 1, height: 1 });
    }],
    ["negative", "公共空间槽位几何必须是安全整数", (slot) => {
      Object.assign(slot, { anchorX: -1, anchorY: 0, width: 1, height: 1 });
    }],
    ["zero-size", "公共空间槽位几何必须是安全整数", (slot) => {
      Object.assign(slot, { anchorX: 0, anchorY: 0, width: 0, height: 1 });
    }],
    ["out-of-bounds", "公共空间槽位几何超出楼层模板", (slot) => {
      Object.assign(slot, { anchorX: 23, anchorY: 23, width: 2, height: 2 });
    }],
  ];

  it.each(slotGeometryCases)("rejects public-space slot geometry %s", (_name, errorClass, mutate) => {
    const value = structuredClone(sharedPhase4Fixture) as any;
    const slot = value.phase4.floorTemplates["template:facility:standard"].publicSpaceSlots[0];
    mutate(slot);
    expect(() => validateBrowserGameState(value, "phase4-shared")).toThrow(errorClass);
  });

  it("keeps absent slot geometry compatible and accepts the exact boundary", () => {
    const legacy = structuredClone(sharedPhase4Fixture) as any;
    expect(() => validateBrowserGameState(legacy, "phase4-shared")).not.toThrow();

    const boundary = structuredClone(sharedPhase4Fixture) as any;
    const template = boundary.phase4.floorTemplates["template:facility:standard"];
    Object.assign(template.publicSpaceSlots[0], {
      anchorX: template.columns - 8,
      anchorY: template.rows - 9,
      width: 8,
      height: 9,
    });
    expect(() => validateBrowserGameState(boundary, "phase4-shared")).not.toThrow();
  });

  it("accepts extension ID-like metadata without treating it as schema", () => {
    const value = structuredClone(sharedPhase4Fixture) as any;
    value.phase4.persistenceMetadata = { futureId: "Future ID", futureIds: ["Future ID"] };
    expect(() => validateBrowserGameState(value, "phase4-shared")).not.toThrow();
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
        value.phase4.floorTemplates[id] = structuredClone({ ...value.phase4.floorTemplates["template:entrance:standard"], id });
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

  it.each(["password", "secret", "credential", "apiKey", "APIKey", "ACCESS_TOKEN", "Api-Key"])(
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
