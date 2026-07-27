import { describe, expect, it } from "vitest";

import { CONTEMPORARY_ORIENTAL, QUIET_METROPOLITAN_LUXURY } from "../design/stylePresets";
import { createNewGame, type RoomBlueprint } from "../game/state";
import { GUEST_SEGMENT_IDS } from "./operationsTypes";
import {
  GUEST_SEGMENTS,
  getGuestSegment,
} from "./segmentCatalog";
import {
  MATCH_REASON_TEXT,
  matchGuest,
  type RoomMatchFactor,
} from "./matchGuest";
import { projectRoomOffers, type RoomOffer } from "./roomOffer";

function offer(overrides: Partial<RoomOffer> = {}): RoomOffer {
  return {
    id: "offer:room-1:deluxe-king",
    sourceRoomId: "room-1",
    variantId: "deluxe-king",
    bedType: "king",
    capacity: 2,
    areaSquareMeters: 42,
    nightlyRateCents: 88_000,
    viewBps: 6_000,
    workspaceBps: 5_000,
    quietBps: 6_000,
    privacyBps: 6_000,
    designAffinities: {
      business: 5_000,
      couple: 6_000,
      family: 4_000,
      leisure: 6_000,
      "high-net-worth": 5_000,
      "cultural-experience": 4_000,
    },
    ...overrides,
  };
}

function blueprint(id = "master-deluxe"): RoomBlueprint {
  return {
    id,
    name: "云岫豪华客房",
    columns: 12,
    rows: 14,
    cells: [
      { x: 0, y: 0, zone: "bedroom" },
      { x: 1, y: 0, zone: "bathroom" },
    ],
    metrics: {
      areaSquareMeters: 48,
      buildCostCents: 12_000_000,
      suggestedRateCents: 120_000,
      businessFitBps: 7_500,
    },
    visual: { status: "idle" },
  };
}

describe("guest segment catalog", () => {
  it("contains all six approved segments in stable demand order", () => {
    expect(GUEST_SEGMENTS.map(({ id }) => id)).toEqual(GUEST_SEGMENT_IDS);
    expect(GUEST_SEGMENTS.map(({ baseDailyDemand }) => baseDailyDemand)).toEqual([
      6, 5, 4, 5, 2, 3,
    ]);
    expect(GUEST_SEGMENTS.every((segment) =>
      segment.displayName.length > 0 &&
      segment.baseDailyDemand > 0 &&
      segment.priceSensitivityBps >= 0 &&
      segment.initiallyHiddenNeedLabels.length > 0,
    )).toBe(true);
  });

  it("is immutable content data without executable values", () => {
    expect(Object.isFrozen(GUEST_SEGMENTS)).toBe(true);
    expect(Object.isFrozen(GUEST_SEGMENTS[0])).toBe(true);
    expect(JSON.parse(JSON.stringify(GUEST_SEGMENTS))).toEqual(GUEST_SEGMENTS);
    expect(GUEST_SEGMENTS.flatMap((segment) => Object.values(segment)).some(
      (value) => typeof value === "function",
    )).toBe(false);
  });
});

describe("room offer projection", () => {
  it("projects placed Phase 2 variants in floor order with stable IDs", () => {
    const state = createNewGame("offers");
    state.rateCents = 108_000;
    state.roomBlueprint = blueprint();
    state.floor.rooms = [
      { id: "room-b", slotId: "slot-ne", roomBlueprintId: "master-deluxe", committedBuildCostCents: 1 },
      { id: "room-a", slotId: "slot-nw", roomBlueprintId: "master-deluxe", committedBuildCostCents: 1 },
    ];
    state.phase2 = {
      hotelGene: CONTEMPORARY_ORIENTAL.gene,
      roomMaster: null,
      corridorTemplate: null,
      floorPlacements: [
        { slotId: "slot-nw", variantId: "variant-twin", rotation: 0, mirrored: false },
        { slotId: "slot-ne", variantId: "variant-corner", rotation: 0, mirrored: false },
      ],
      roomVariants: [
        {
          id: "variant-twin",
          name: "双床房",
          masterId: "master-deluxe",
          cells: Array.from({ length: 160 }, (_, index) => ({ x: index, y: 0, zone: index < 140 ? "bedroom" as const : "bathroom" as const })),
          rotation: 0,
          mirrored: false,
          overrides: ["bedType"],
          variantKind: "twin",
          gene: QUIET_METROPOLITAN_LUXURY.gene,
        },
        {
          id: "variant-corner",
          name: "转角景观房",
          masterId: "master-deluxe",
          cells: [],
          rotation: 0,
          mirrored: false,
          overrides: ["view"],
          variantKind: "corner",
          gene: CONTEMPORARY_ORIENTAL.gene,
          metrics: { ...blueprint().metrics, areaSquareMeters: 55 },
        },
      ],
    };

    const offers = projectRoomOffers(state);

    expect(offers.map(({ id }) => id)).toEqual([
      "offer:room-b:variant-corner",
      "offer:room-a:variant-twin",
    ]);
    expect(offers[0]).toMatchObject({ bedType: "king", areaSquareMeters: 55, viewBps: 9_000 });
    expect(offers[1]).toMatchObject({ bedType: "twin", areaSquareMeters: 40, nightlyRateCents: 108_000 });
    expect(offers[1]).toMatchObject({ capacity: 3 });
    expect(offers[1]!.workspaceBps).toBeGreaterThan(offers[0]!.workspaceBps);
    expect(offers[0]!.designAffinities["cultural-experience"]).toBeGreaterThan(5_000);
  });

  it("falls back to the legacy blueprint when a placement cannot resolve a variant", () => {
    const state = createNewGame("legacy");
    state.roomBlueprint = blueprint("legacy-blueprint");
    state.floor.rooms = [
      { id: "room-legacy", slotId: "slot-nw", roomBlueprintId: "legacy-blueprint", committedBuildCostCents: 1 },
    ];

    expect(projectRoomOffers(state)).toEqual([
      expect.objectContaining({
        id: "offer:room-legacy:legacy-blueprint",
        sourceRoomId: "room-legacy",
        bedType: "double",
        capacity: 2,
        areaSquareMeters: 48,
      }),
    ]);
  });
});

describe("guest matching", () => {
  it("rejects a one-bed two-person room for families before scoring preferences", () => {
    expect(matchGuest(getGuestSegment("family"), offer())).toMatchObject({
      eligible: false,
      hardFailure: "requires-family-capacity",
      preferenceScoreBps: null,
      factors: [],
    });
  });

  it.each(["king", "double"] as const)(
    "rejects a capacity-three %s room because families still need separate beds",
    (bedType) => {
      expect(matchGuest(getGuestSegment("family"), offer({
        bedType,
        capacity: 3,
      }))).toMatchObject({
        eligible: false,
        hardFailure: "requires-family-capacity",
        preferenceScoreBps: null,
        factors: [],
      });
    },
  );

  it("allows a family-friendly twin offer to proceed to preference scoring", () => {
    expect(matchGuest(getGuestSegment("family"), offer({
      bedType: "twin",
      capacity: 3,
    }))).toMatchObject({
      eligible: true,
      hardFailure: null,
    });
  });

  it("enforces the high-net-worth minimum room area", () => {
    expect(matchGuest(getGuestSegment("high-net-worth"), offer({ areaSquareMeters: 44 }))).toMatchObject({
      eligible: false,
      hardFailure: "requires-minimum-area",
    });
    expect(matchGuest(getGuestSegment("high-net-worth"), offer({ areaSquareMeters: 60 })).eligible).toBe(true);
  });

  it("rewards workspace and quiet for business guests", () => {
    const business = getGuestSegment("business");
    const weak = matchGuest(business, offer({ workspaceBps: 2_000, quietBps: 2_000 }));
    const strong = matchGuest(business, offer({ workspaceBps: 9_000, quietBps: 9_000 }));

    expect(strong.preferenceScoreBps).toBeGreaterThan(weak.preferenceScoreBps!);
    expect(strong.factors.map(({ code }) => code)).toEqual(expect.arrayContaining([
      "workspace-fit",
      "quiet-fit",
    ]));
  });

  it("rewards a culturally grounded design gene for cultural-experience guests", () => {
    const segment = getGuestSegment("cultural-experience");
    const generic = matchGuest(segment, offer({
      designAffinities: { ...offer().designAffinities, "cultural-experience": 2_000 },
    }));
    const cultural = matchGuest(segment, offer({
      designAffinities: { ...offer().designAffinities, "cultural-experience": 9_000 },
    }));

    expect(cultural.preferenceScoreBps).toBeGreaterThan(generic.preferenceScoreBps!);
    expect(cultural.factors[0]?.code).toBe("design-fit");
  });

  it("returns stable reason codes and keeps Chinese presentation text separate", () => {
    const first = matchGuest(getGuestSegment("business"), offer({
      nightlyRateCents: 300_000,
      workspaceBps: 1_000,
      quietBps: 2_000,
    }));
    const second = matchGuest(getGuestSegment("business"), structuredClone(offer({
      nightlyRateCents: 300_000,
      workspaceBps: 1_000,
      quietBps: 2_000,
    })));

    expect(second).toEqual(first);
    expect(first.factors.some(({ code, contributionBps }) =>
      code === "price-fit" && contributionBps < 0,
    )).toBe(true);
    expect(MATCH_REASON_TEXT["requires-family-capacity"]).toBe("家庭客群需要更多床位与入住容量");
    expect(Object.values(MATCH_REASON_TEXT).every((text) => typeof text === "string")).toBe(true);
    expect(first.factors.every((factor: RoomMatchFactor) => !("text" in factor))).toBe(true);
  });
});
