import { describe, expect, it } from "vitest";
import { FACILITY_CATALOG, ITEM_CATALOG } from "./contentCatalog";
import { FACILITY_OFFERINGS, MENU_STRUCTURES } from "../facilities/facilityOperations";
import { createPhase4AcceptanceState } from "../../testing/phase4Fixtures";
import { projectContentProgress } from "./contentProgress";

describe("content compendium progress", () => {
  it("keeps catalog order and explains locked facilities without granting unlocks", () => {
    const state = createPhase4AcceptanceState("content-progress");
    state.phase4!.catalogProgress.unlockedIds = [FACILITY_CATALOG[0].id];

    const projection = projectContentProgress(state);

    expect(projection.facilities.map(({ id }) => id)).toEqual(
      FACILITY_CATALOG.map(({ id }) => id),
    );
    expect(projection.facilities[0]).toMatchObject({ unlocked: true, lockedReasons: [] });
    expect(projection.facilities.find(({ type }) => type === "chinese-restaurant"))
      .toMatchObject({ unlocked: false, lockedReasons: ["酒店最高声誉达到 60%"] });
    expect(projection.facilities.find(({ type }) => type === "spa")?.lockedReasons)
      .toContain("发现休闲观光客群的客房功能需求");
    expect(state.phase4!.catalogProgress.unlockedIds).toEqual([FACILITY_CATALOG[0].id]);
  });

  it("separates met prerequisites from the persisted unlock decision", () => {
    const state = createPhase4AcceptanceState("content-prerequisites");
    state.phase4!.catalogProgress.unlockedIds = [];

    const projection = projectContentProgress(state);
    const skyLobby = projection.facilities.find(({ type }) => type === "sky-lobby")!;
    const restaurant = projection.facilities.find(({ type }) => type === "chinese-restaurant")!;

    expect(skyLobby.prerequisites).toEqual([
      { description: "酒店最高声誉达到 0%", met: true },
    ]);
    expect(skyLobby.lockedReasons).toEqual(["尚未记录为已解锁"]);
    expect(restaurant.prerequisites).toEqual([
      { description: "酒店最高声誉达到 60%", met: false },
    ]);
    expect(restaurant.lockedReasons).toEqual(["酒店最高声誉达到 60%"]);
  });

  it("projects items and menus in their authoritative catalog order", () => {
    const state = createPhase4AcceptanceState("content-order");
    state.phase4!.catalogProgress.unlockedIds = [
      FACILITY_CATALOG.find(({ type }) => type === "all-day-dining")!.id,
    ];

    const projection = projectContentProgress(state);

    expect(projection.items.map(({ id }) => id)).toEqual(ITEM_CATALOG.map(({ id }) => id));
    expect(projection.menus.map(({ id }) => id)).toEqual(MENU_STRUCTURES.map(({ id }) => id));
    expect(projection.items.find(({ id }) => id === "item:dining-table")?.unlocked).toBe(true);
    expect(projection.items.find(({ id }) => id === "item:treatment-bed")?.unlocked).toBe(false);
    expect(projection.menus.find(({ id }) => id === "menu:all-day-balanced")?.unlocked)
      .toBe(true);
    expect(projection.menus.find(({ id }) => id === "menu:bar-classics")?.unlocked)
      .toBe(false);
  });

  it("projects signature offerings in catalog order with facility-backed availability", () => {
    const state = createPhase4AcceptanceState("content-offerings");
    state.phase4!.catalogProgress.unlockedIds = [
      FACILITY_CATALOG.find(({ type }) => type === "spa")!.id,
    ];

    const projection = projectContentProgress(state);

    expect(projection.offerings.map(({ id }) => id)).toEqual(
      FACILITY_OFFERINGS.map(({ id }) => id),
    );
    expect(projection.offerings.find(({ id }) => id === "service:cloud-restoration")?.unlocked)
      .toBe(true);
    expect(projection.offerings.find(({ id }) => id === "drink:cloud-negroni")?.unlocked)
      .toBe(false);
  });
});
