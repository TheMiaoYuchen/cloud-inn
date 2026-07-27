import { describe, expect, it } from "vitest";

import { createOperationsState } from "./createOperationsState";
import { getGuestSegment } from "./segmentCatalog";
import type { RoomOffer } from "./roomOffer";
import {
  ROOM_OFFER_UPGRADE_CATALOG,
  applyRoomOfferUpgrades,
  previewRoomOfferUpgrade,
  projectRoomOfferUpgrade,
  roomOfferUpgradeKey,
  validateRoomOfferUpgrades,
  validateRoomOfferUpgrade,
  type RoomOfferUpgradeRequest,
  type UpgradeKind,
} from "./renovation";

function offer(overrides: Partial<RoomOffer> = {}): RoomOffer {
  return {
    id: "offer:room-01:twin",
    sourceRoomId: "room-01",
    variantId: "variant-twin",
    bedType: "twin",
    capacity: 2,
    areaSquareMeters: 60,
    nightlyRateCents: 100_000,
    viewBps: 5_000,
    workspaceBps: 5_000,
    quietBps: 5_000,
    privacyBps: 5_000,
    designAffinities: {
      business: 5_000,
      couple: 5_000,
      family: 5_000,
      leisure: 5_000,
      "high-net-worth": 5_000,
      "cultural-experience": 5_000,
    },
    ...overrides,
  };
}

function request(kind: UpgradeKind, level = 1): RoomOfferUpgradeRequest {
  return { roomOfferId: "offer:room-01:twin", kind, level };
}

describe("room-offer renovation", () => {
  it.each([
    ["workspace", "workspaceBps", 6_500],
    ["view", "viewBps", 6_500],
    ["privacy", "privacyBps", 6_500],
    ["familyCapacity", "capacity", 3],
  ] as const)("projects the controlled %s level without changing the base offer", (kind, field, expected) => {
    const base = offer();
    const snapshot = structuredClone(base);

    const projected = projectRoomOfferUpgrade(base, request(kind));

    expect(projected.afterOffer[field]).toBe(expected);
    expect(projected.upgrade).toMatchObject({
      roomOfferId: base.id,
      upgradeId: kind,
      kind,
      level: 1,
      remainingClosureDays: projected.closureDays,
      costCents: projected.costCents,
    });
    expect(base).toEqual(snapshot);
  });

  it("uses immutable fixed content rules and safe-integer deterministic costs", () => {
    const first = projectRoomOfferUpgrade(offer(), request("workspace"));
    const second = projectRoomOfferUpgrade(structuredClone(offer()), request("workspace"));

    expect(first.costCents).toBe(120_000);
    expect(second).toEqual(first);
    expect(Number.isSafeInteger(first.costCents)).toBe(true);
    expect(Object.isFrozen(ROOM_OFFER_UPGRADE_CATALOG)).toBe(true);
    expect(Object.isFrozen(ROOM_OFFER_UPGRADE_CATALOG.workspace)).toBe(true);
    expect(() => {
      (ROOM_OFFER_UPGRADE_CATALOG.workspace as { maxLevel: number }).maxLevel = 99;
    }).toThrow();
  });

  it("stores multiple kinds for one stable offer under stable compound keys", () => {
    const operations = createOperationsState();
    const base = offer();
    const workspace = projectRoomOfferUpgrade(base, request("workspace")).upgrade;
    const view = projectRoomOfferUpgrade(base, request("view")).upgrade;
    operations.offerUpgrades = {
      [roomOfferUpgradeKey(base.id, "workspace")]: workspace,
      [roomOfferUpgradeKey(base.id, "view")]: view,
    };

    const upgraded = applyRoomOfferUpgrades(base, operations);

    expect(upgraded.workspaceBps).toBe(6_500);
    expect(upgraded.viewBps).toBe(6_500);
    expect(Object.keys(operations.offerUpgrades)).toEqual([
      `${base.id}:workspace`,
      `${base.id}:view`,
    ]);
  });

  it("projects a level-two replacement from the base instead of double-counting level one", () => {
    const operations = createOperationsState();
    const base = offer();
    operations.offerUpgrades[roomOfferUpgradeKey(base.id, "workspace")] =
      projectRoomOfferUpgrade(base, request("workspace")).upgrade;
    operations.offerUpgrades[roomOfferUpgradeKey(base.id, "workspace")].remainingClosureDays = 0;

    const preview = previewRoomOfferUpgrade(base, operations, request("workspace", 2));
    const committedOperations = structuredClone(operations);
    committedOperations.offerUpgrades[roomOfferUpgradeKey(base.id, "workspace")] = preview.upgrade;

    expect(preview.beforeOffer.workspaceBps).toBe(6_500);
    expect(preview.afterOffer.workspaceBps).toBe(8_000);
    expect(applyRoomOfferUpgrades(base, committedOperations)).toEqual(preview.afterOffer);
  });

  it("clamps cumulative basis-point improvements and only expands twin capacity", () => {
    const operations = createOperationsState();
    const highWorkspace = offer({ workspaceBps: 9_500 });
    operations.offerUpgrades[roomOfferUpgradeKey(highWorkspace.id, "workspace")] =
      projectRoomOfferUpgrade(highWorkspace, request("workspace", 2), { allowInitialLevel: true }).upgrade;

    expect(applyRoomOfferUpgrades(highWorkspace, operations).workspaceBps).toBe(10_000);
    expect(() => projectRoomOfferUpgrade(
      offer({ bedType: "king" }),
      request("familyCapacity"),
    )).toThrow("双床");
  });

  it("rejects invalid offer, kind, level, downgrade, skip-level, duplicate, and incompatible upgrades", () => {
    const operations = createOperationsState();
    const base = offer();

    expect(() => validateRoomOfferUpgrade(base, operations, {
      ...request("workspace"), roomOfferId: "offer:missing",
    })).toThrow("客房产品不存在");
    expect(() => validateRoomOfferUpgrade(base, operations, request("spa" as UpgradeKind))).toThrow("改造类型");
    expect(() => validateRoomOfferUpgrade(base, operations, request("workspace", 0))).toThrow("等级");
    expect(() => validateRoomOfferUpgrade(base, operations, request("workspace", 3))).toThrow("等级上限");
    expect(() => validateRoomOfferUpgrade(base, operations, request("workspace", 2))).toThrow("逐级");
    expect(() => validateRoomOfferUpgrade(
      offer({ bedType: "king" }), operations, request("familyCapacity"),
    )).toThrow("双床");

    operations.offerUpgrades[roomOfferUpgradeKey(base.id, "workspace")] =
      projectRoomOfferUpgrade(base, request("workspace")).upgrade;
    expect(() => validateRoomOfferUpgrade(base, operations, request("workspace"))).toThrow("已完成");
    expect(() => validateRoomOfferUpgrade(base, operations, request("workspace", 0))).toThrow("降级");
    expect(() => validateRoomOfferUpgrade(base, operations, request("workspace", 2))).toThrow("施工");
    expect(() => validateRoomOfferUpgrade(base, operations, request("view"))).toThrow("施工");
    operations.offerUpgrades[roomOfferUpgradeKey(base.id, "workspace")].remainingClosureDays = 0;
    expect(() => validateRoomOfferUpgrade(base, operations, request("workspace", 2))).not.toThrow();
  });

  it.each([
    [{ level: 9 }, "等级"],
    [{ remainingClosureDays: -1 }, "施工"],
    [{ costCents: Number.NaN }, "成本"],
    [{ upgradeId: "view" }, "编号"],
    [{ roomOfferId: "offer:other" }, "键"],
    [{ remainingClosureDays: undefined }, "完整"],
    [{ committedDay: undefined }, "完整"],
    [{ costCents: undefined }, "完整"],
  ] as const)("rejects malformed persisted upgrade data %#", (override, message) => {
    const operations = createOperationsState();
    const base = offer();
    operations.offerUpgrades[roomOfferUpgradeKey(base.id, "workspace")] = {
      ...projectRoomOfferUpgrade(base, request("workspace")).upgrade,
      ...override,
    };

    expect(() => applyRoomOfferUpgrades(base, operations)).toThrow(message);
  });

  it("validates every persisted compound key against the current stable offer set", () => {
    const operations = createOperationsState();
    const base = offer();
    operations.offerUpgrades["wrong:key"] = projectRoomOfferUpgrade(
      base, request("workspace"),
    ).upgrade;

    expect(() => validateRoomOfferUpgrades([base], operations)).toThrow("键");
    operations.offerUpgrades = {
      [roomOfferUpgradeKey("offer:missing", "workspace")]: {
        ...projectRoomOfferUpgrade(base, request("workspace")).upgrade,
        roomOfferId: "offer:missing",
      },
    };
    expect(() => validateRoomOfferUpgrades([base], operations)).toThrow("不存在");
  });

  it("ignores a legacy arbitrary upgrade and preserves its input without projecting it", () => {
    const operations = createOperationsState();
    const base = offer();
    operations.offerUpgrades[base.id] = {
      roomOfferId: base.id,
      upgradeId: "club-access",
      level: 1,
    };
    const snapshot = structuredClone(operations.offerUpgrades);

    expect(validateRoomOfferUpgrades([base], operations)).toBeUndefined();
    expect(applyRoomOfferUpgrades(base, operations)).toEqual(base);
    expect(operations.offerUpgrades).toEqual(snapshot);
  });

  it("does not infer renovation from a legacy record with a colliding upgrade ID", () => {
    const operations = createOperationsState();
    const base = offer();
    operations.offerUpgrades[base.id] = {
      roomOfferId: base.id,
      upgradeId: "workspace",
      level: 1,
    };

    expect(validateRoomOfferUpgrades([base], operations)).toBeUndefined();
    expect(applyRoomOfferUpgrades(base, operations)).toEqual(base);
    expect(() => validateRoomOfferUpgrade(base, operations, request("workspace"))).not.toThrow();
  });

  it("explains business workspace and high-net-worth view/privacy score gains", () => {
    const operations = createOperationsState();
    const base = offer();

    const workspace = previewRoomOfferUpgrade(base, operations, request("workspace"));
    const business = workspace.segments.find(({ segmentId }) => segmentId === "business")!;
    expect(business.scoreDeltaBps).toBeGreaterThan(0);
    expect(business.topReasonChanges).toContain("workspace-fit");

    const view = previewRoomOfferUpgrade(base, operations, request("view"));
    const viewLuxury = view.segments.find(({ segmentId }) => segmentId === "high-net-worth")!;
    expect(viewLuxury.scoreDeltaBps).toBeGreaterThan(0);
    expect(viewLuxury.topReasonChanges).toContain("view-fit");

    const privacy = previewRoomOfferUpgrade(base, operations, request("privacy"));
    const privacyLuxury = privacy.segments.find(({ segmentId }) => segmentId === "high-net-worth")!;
    expect(privacyLuxury.scoreDeltaBps!).toBeGreaterThan(viewLuxury.scoreDeltaBps!);
    expect(privacyLuxury.topReasonChanges).toContain("privacy-fit");
  });

  it("prioritizes the family hard-requirement change before soft reasons", () => {
    const operations = createOperationsState();
    const preview = previewRoomOfferUpgrade(offer(), operations, request("familyCapacity"));
    const family = preview.segments.find(({ segmentId }) => segmentId === "family")!;

    expect(family.before).toMatchObject({ eligible: false, hardFailure: "requires-family-capacity" });
    expect(family.after.eligible).toBe(true);
    expect(family.topReasonChanges[0]).toBe("requires-family-capacity");
    expect(preview.segments.map(({ segmentId }) => segmentId)).toEqual([
      "business", "couple", "family", "leisure", "high-net-worth", "cultural-experience",
    ]);
    expect(getGuestSegment("family").hardRequirements.minimumCapacity).toBe(3);
  });

  it("does not mutate offers, operations, requests, or historical reports while previewing/applying", () => {
    const base = offer();
    const operations = createOperationsState();
    operations.dailyReports = [{ day: 1 } as never];
    const input = request("workspace");
    const snapshot = structuredClone({ base, operations, input });

    previewRoomOfferUpgrade(base, operations, input);
    applyRoomOfferUpgrades(base, operations);

    expect({ base, operations, input }).toEqual(snapshot);
  });
});
