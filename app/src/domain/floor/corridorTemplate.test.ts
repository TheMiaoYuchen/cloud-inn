import { describe, expect, it } from "vitest";

import type { CorridorTemplate } from "../design/designTypes";
import {
  analyzeCorridorTemplate,
  createCorridorTemplate,
  createDenseGuestFloorTemplate,
  createRoomFootprint,
  validateCorridorTemplate,
} from "./corridorTemplate";

const key = ({ x, y }: { x: number; y: number }) => `${x},${y}`;

describe("createCorridorTemplate", () => {
  it("creates a connected complete ring around a central core", () => {
    const template = createCorridorTemplate("complete-ring");
    const corridor = new Set(template.corridor.map(key));

    expect(template.id).toBe("complete-ring");
    expect(template.width).toBe(64);
    expect(template.height).toBe(64);
    expect(template.core).toHaveLength(64);
    expect(template.core).toContainEqual({ x: 28, y: 28 });
    expect(template.core).toContainEqual({ x: 35, y: 35 });
    expect(corridor).toEqual(
      expect.objectContaining({
        size: 132,
      }),
    );
    expect(corridor.has("15,15")).toBe(true);
    expect(corridor.has("48,15")).toBe(true);
    expect(corridor.has("48,48")).toBe(true);
    expect(corridor.has("15,48")).toBe(true);
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
    expect(corridor.has("31,48")).toBe(false);
    expect(corridor.has("32,48")).toBe(false);
    expect(partial.slots.every((slot) => !slot.id.startsWith("south"))).toBe(
      true,
    );
    expect(validateCorridorTemplate(partial).ok).toBe(true);
  });

  it("gives every template an entrance path from corridor to core", () => {
    for (const kind of ["complete-ring", "partial-ring"] as const) {
      const template = createCorridorTemplate(kind);

      expect(template.entrances[0]).toEqual({ x: 31, y: 16 });
      expect(template.entrances[template.entrances.length - 1]).toEqual({ x: 31, y: 27 });
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
      { id: "north-west", width: 9, height: 13 },
      { id: "north-east", width: 13, height: 9 },
      { id: "east-north", width: 10, height: 12 },
      { id: "east-south", width: 12, height: 10 },
      { id: "south-east", width: 8, height: 12 },
      { id: "south-west", width: 12, height: 8 },
      { id: "west-south", width: 13, height: 8 },
      { id: "west-north", width: 8, height: 13 },
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

  it.each(["complete-ring", "partial-ring"] as const)(
    "offers multiple true-size slots for 8x12 and rotated 12x8 rooms in %s",
    (kind) => {
      const template = createCorridorTemplate(kind);

      expect(
        template.slots.filter(({ width, height }) => width >= 8 && height >= 12).length,
      ).toBeGreaterThanOrEqual(2);
      expect(
        template.slots.filter(({ width, height }) => width >= 12 && height >= 8).length,
      ).toBeGreaterThanOrEqual(2);
      expect(new Set(template.slots.map(({ width, height }) => `${width}x${height}`)).size).toBeGreaterThan(2);
      expect(validateCorridorTemplate(template)).toEqual({ ok: true, reasons: [] });
    },
  );
});

describe("createDenseGuestFloorTemplate", () => {
  it("creates 32 deterministic true-size outer slots around a connected ring", () => {
    const first = createDenseGuestFloorTemplate({
      floorId: "floor:28",
      slotsPerSide: 8,
    });
    const second = createDenseGuestFloorTemplate({
      floorId: "floor:28",
      slotsPerSide: 8,
    });

    expect(first).toEqual(second);
    expect(first.id).toBe("dense-guest:floor:28");
    expect(first.slots).toHaveLength(32);
    expect(new Set(first.slots.map(({ id }) => id)).size).toBe(32);
    expect(first.slots.every(({ width, height }) => width * height === 24)).toBe(true);
    expect(validateCorridorTemplate(first)).toEqual({ ok: true, reasons: [] });
  });

  it("rejects invalid floor IDs and density bounds", () => {
    expect(() => createDenseGuestFloorTemplate({ floorId: "Floor 28", slotsPerSide: 8 })).toThrow("稳定 ID");
    expect(() => createDenseGuestFloorTemplate({ floorId: "floor:28", slotsPerSide: 5 })).toThrow("每侧槽位");
    expect(() => createDenseGuestFloorTemplate({ floorId: "floor:28", slotsPerSide: 8.5 })).toThrow("每侧槽位");
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

    expect(() => createRoomFootprint(slot, { width: slot.width + 1, height: 8 })).toThrow(
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
      "north-west": 9,
      "north-east": 1,
      "east-north": 18,
      "east-south": 31,
      "south-east": 56,
      "south-west": 58,
      "west-south": 38,
      "west-north": 25,
    });
    expect(first.hints).toContainEqual({
      kind: "service-distance",
      severity: "warning",
      advisory: true,
      slotId: "east-south",
      value: 31,
      message: "east-south 距服务入口 31 格",
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
