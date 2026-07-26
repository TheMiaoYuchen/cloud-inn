import { describe, expect, it } from "vitest";

import type { CorridorTemplate } from "../design/designTypes";
import {
  analyzeCorridorTemplate,
  createCorridorTemplate,
  createRoomFootprint,
  validateCorridorTemplate,
} from "./corridorTemplate";

const key = ({ x, y }: { x: number; y: number }) => `${x},${y}`;

describe("createCorridorTemplate", () => {
  it("creates a connected complete ring around a central core", () => {
    const template = createCorridorTemplate("complete-ring");
    const corridor = new Set(template.corridor.map(key));

    expect(template.id).toBe("complete-ring");
    expect(template.width).toBe(36);
    expect(template.height).toBe(36);
    expect(template.core).toHaveLength(64);
    expect(template.core).toContainEqual({ x: 14, y: 14 });
    expect(template.core).toContainEqual({ x: 21, y: 21 });
    expect(corridor).toEqual(
      expect.objectContaining({
        size: 52,
      }),
    );
    expect(corridor.has("11,11")).toBe(true);
    expect(corridor.has("24,11")).toBe(true);
    expect(corridor.has("24,24")).toBe(true);
    expect(corridor.has("11,24")).toBe(true);
    expect(validateCorridorTemplate(template)).toEqual({
      ok: true,
      reasons: [],
    });
  });

  it("creates a connected partial ring with a deliberate south gap", () => {
    const complete = createCorridorTemplate("complete-ring");
    const partial = createCorridorTemplate("partial-ring");
    const corridor = new Set(partial.corridor.map(key));

    expect(partial.id).toBe("partial-ring");
    expect(partial.corridor.length).toBeLessThan(complete.corridor.length);
    expect(corridor.has("17,24")).toBe(false);
    expect(corridor.has("18,24")).toBe(false);
    expect(partial.slots.every((slot) => !slot.id.startsWith("south"))).toBe(
      true,
    );
    expect(validateCorridorTemplate(partial).ok).toBe(true);
  });

  it("gives every template an entrance path from corridor to core", () => {
    for (const kind of ["complete-ring", "partial-ring"] as const) {
      const template = createCorridorTemplate(kind);

      expect(template.entrances).toEqual([
        { x: 17, y: 12 },
        { x: 17, y: 13 },
      ]);
      expect(validateCorridorTemplate(template).reasons).not.toContain(
        "入口未连接核心筒与走廊",
      );
    }
  });

  it("uses explicit varied slot dimensions adjacent to traversable corridor", () => {
    const template = createCorridorTemplate("complete-ring");

    expect(template.slots.map(({ id, width, height }) => ({
      id,
      width,
      height,
    }))).toEqual([
      { id: "north-west", width: 8, height: 8 },
      { id: "north-east", width: 9, height: 10 },
      { id: "east-north", width: 8, height: 8 },
      { id: "east-south", width: 10, height: 8 },
      { id: "south-east", width: 8, height: 10 },
      { id: "south-west", width: 11, height: 7 },
      { id: "west-south", width: 10, height: 7 },
      { id: "west-north", width: 10, height: 8 },
    ]);
    expect(validateCorridorTemplate(template).ok).toBe(true);

    const occupied = new Set<string>();
    for (const slot of template.slots) {
      for (const cell of createRoomFootprint(slot, slot).cells) {
        expect(occupied.has(key(cell))).toBe(false);
        occupied.add(key(cell));
      }
    }
  });
});

describe("createRoomFootprint", () => {
  it("projects a room at its true dimensions rather than filling its slot", () => {
    const template = createCorridorTemplate("complete-ring");
    const slot = template.slots.find(({ id }) => id === "south-west")!;

    const footprint = createRoomFootprint(slot, { width: 7, height: 5 });

    expect(footprint).toMatchObject({
      slotId: "south-west",
      anchor: slot.anchor,
      width: 7,
      height: 5,
    });
    expect(footprint.cells).toHaveLength(35);
    expect(footprint.cells[0]).toEqual(slot.anchor);
    expect(footprint.cells[footprint.cells.length - 1]).toEqual({
      x: slot.anchor.x + 6,
      y: slot.anchor.y + 4,
    });
  });

  it("rejects footprints that are invalid or larger than their slot", () => {
    const slot = createCorridorTemplate("complete-ring").slots[0];

    expect(() => createRoomFootprint(slot, { width: 9, height: 8 })).toThrow(
      "房间尺寸超出槽位",
    );
    expect(() => createRoomFootprint(slot, { width: 0, height: 8 })).toThrow(
      "房间尺寸必须是正整数",
    );
  });
});

describe("analyzeCorridorTemplate", () => {
  it("returns deterministic shortest service distances and advisory hints", () => {
    const template = createCorridorTemplate("complete-ring");

    const first = analyzeCorridorTemplate(template, {
      serviceDistanceWarning: 12,
      congestionWarning: 99,
    });
    const second = analyzeCorridorTemplate(structuredClone(template), {
      serviceDistanceWarning: 12,
      congestionWarning: 99,
    });

    expect(first).toEqual(second);
    expect(first.serviceDistances).toEqual({
      "north-west": 1,
      "north-east": 3,
      "east-north": 8,
      "east-south": 16,
      "south-east": 21,
      "south-west": 20,
      "west-south": 13,
      "west-north": 7,
    });
    expect(first.hints).toContainEqual({
      kind: "service-distance",
      severity: "warning",
      advisory: true,
      slotId: "east-south",
      value: 16,
      message: "east-south 距服务入口 16 格",
    });
    expect(first.hints.every(({ advisory }) => advisory)).toBe(true);
    expect(JSON.stringify(first)).not.toMatch(/cash|cost|rate|revenue/i);
  });

  it("flags deterministic corridor congestion without invalidating the layout", () => {
    const template = createCorridorTemplate("complete-ring");
    const analysis = analyzeCorridorTemplate(template, {
      serviceDistanceWarning: 99,
      congestionWarning: 3,
    });

    expect(analysis.maxCongestion).toBe(8);
    expect(analysis.hints).toContainEqual({
      kind: "congestion",
      severity: "warning",
      advisory: true,
      value: 8,
      message: "入口附近预计有 8 条服务动线重叠",
    });
    expect(validateCorridorTemplate(template).ok).toBe(true);
  });

  it("reports broken core, entrance, corridor, and slot connections", () => {
    const valid = createCorridorTemplate("complete-ring");
    const broken: CorridorTemplate = {
      ...valid,
      corridor: valid.corridor.filter(({ x }) => x < 20),
      entrances: [{ x: 0, y: 0 }],
      slots: [valid.slots.find(({ id }) => id === "east-north")!],
    };

    const result = validateCorridorTemplate(broken);

    expect(result.ok).toBe(false);
    expect(result.reasons).toContain("入口未连接核心筒与走廊");
    expect(result.reasons).toContain("槽位 east-north 未连接走廊");
  });

  it("rejects disconnected corridor islands even when the first cell is valid", () => {
    const template = createCorridorTemplate("complete-ring");
    const broken: CorridorTemplate = {
      ...template,
      corridor: [...template.corridor, { x: 35, y: 35 }],
    };

    expect(validateCorridorTemplate(broken).reasons).toContain(
      "走廊存在不连通区段",
    );
  });

  it("counts congestion only along one deterministic shortest path per slot", () => {
    const template: CorridorTemplate = {
      id: "forked-paths",
      name: "分叉测试",
      width: 7,
      height: 7,
      core: [{ x: 3, y: 3 }],
      entrances: [{ x: 3, y: 2 }],
      corridor: [
        { x: 3, y: 1 },
        { x: 2, y: 1 },
        { x: 1, y: 1 },
        { x: 1, y: 2 },
        { x: 1, y: 3 },
        { x: 4, y: 1 },
        { x: 5, y: 1 },
        { x: 5, y: 2 },
        { x: 5, y: 3 },
      ],
      slots: [
        { id: "west", anchor: { x: 0, y: 3 }, width: 1, height: 1 },
        { id: "east", anchor: { x: 6, y: 3 }, width: 1, height: 1 },
      ],
    };

    const analysis = analyzeCorridorTemplate(template, {
      serviceDistanceWarning: 99,
      congestionWarning: 99,
    });

    expect(analysis.serviceDistances).toEqual({ west: 5, east: 5 });
    expect(analysis.maxCongestion).toBe(2);
    expect(analysis.corridorUsage).toMatchObject({
      "1,1": 1,
      "5,1": 1,
      "3,1": 2,
    });
  });
});
