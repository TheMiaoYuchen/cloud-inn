import { describe, expect, it } from "vitest";

import { createNewGame } from "../game/state";
import {
  NATURAL_RESORT,
  QUIET_METROPOLITAN_LUXURY,
  STYLE_PRESETS,
} from "./stylePresets";
import type {
  CorridorTemplate,
  DesignGene,
  RoomVariant,
} from "./designTypes";

const gene: DesignGene = {
  palette: "warm ivory and walnut",
  materials: ["walnut", "linen"],
  metal: "brushed bronze",
  lighting: "2700K layered lighting",
  mood: "quiet and welcoming",
};

describe("phase two design contracts", () => {
  it("exports three immutable luxury starter presets with complete genes", () => {
    expect(STYLE_PRESETS).toHaveLength(3);
    expect(STYLE_PRESETS.map((preset) => preset.id)).toEqual([
      "contemporary-oriental",
      "quiet-metropolitan-luxury",
      "natural-resort",
    ]);
    expect(QUIET_METROPOLITAN_LUXURY.gene.lighting).toContain("2700K");
    expect(NATURAL_RESORT.gene.materials.length).toBeGreaterThan(0);
    expect(() => {
      (STYLE_PRESETS as unknown as Array<unknown>).push({});
    }).toThrow();
  });

  it("describes inherited room variants and their explicit override fields", () => {
    const variant: RoomVariant = {
      id: "variant-king",
      name: "特大床房",
      masterId: "master-deluxe",
      cells: [{ x: 0, y: 0, zone: "bedroom" }],
      rotation: 90,
      mirrored: true,
      overrides: ["bedType", "view"],
      gene,
    };

    expect(variant.masterId).toBe("master-deluxe");
    expect(variant.overrides).toEqual(["bedType", "view"]);
  });

  it("describes a template envelope with a core, ring cells, entrances, and true-size slots", () => {
    const template: CorridorTemplate = {
      id: "ring-square",
      name: "方形环廊",
      width: 24,
      height: 24,
      core: [{ x: 11, y: 11 }],
      corridor: [{ x: 1, y: 1 }],
      entrances: [{ x: 11, y: 10 }],
      slots: [
        { id: "slot-1", anchor: { x: 2, y: 2 }, width: 8, height: 12 },
      ],
    };

    expect(template.slots[0]).toMatchObject({ width: 8, height: 12 });
  });

  it("keeps phase one saves compatible by leaving phase two state optional", () => {
    const state = createNewGame("save-compat");

    expect(state.phase2).toBeUndefined();
  });
});
