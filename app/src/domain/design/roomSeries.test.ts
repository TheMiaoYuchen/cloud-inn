import { describe, expect, it } from "vitest";

import { CONTEMPORARY_ORIENTAL } from "./stylePresets";
import {
  applySelectedSync,
  createRoomMaster,
  createRoomVariants,
  previewMasterSync,
  selectAllSyncChanges,
  selectNoneSyncChanges,
} from "./roomSeries";
import { createRectangle } from "../room/grid";
import { createRoomDraft, validateRoomDraft } from "../room/editRoom";

const cells = [
  ...createRectangle(0, 0, 4, 3, "bedroom"),
  ...createRectangle(0, 3, 4, 1, "bathroom"),
];

describe("room series inheritance", () => {
  it("creates a deterministic master with metrics from its footprint", () => {
    const master = createRoomMaster({
      id: "master-deluxe",
      name: "云岫豪华客房",
      cells,
      columns: 8,
      rows: 12,
      gene: CONTEMPORARY_ORIENTAL.gene,
    });

    expect(master).toMatchObject({
      id: "master-deluxe",
      name: "云岫豪华客房",
      metrics: { areaSquareMeters: 4 },
      gene: CONTEMPORARY_ORIENTAL.gene,
    });
  });

  it("creates stable king, twin, and corner variants with explicit overrides", () => {
    const master = createRoomMaster({
      id: "master-deluxe",
      name: "云岫豪华客房",
      cells,
      columns: 8,
      rows: 12,
      gene: CONTEMPORARY_ORIENTAL.gene,
    });
    const variants = createRoomVariants(master);

    expect(variants.map((variant) => variant.id)).toEqual([
      "master-deluxe-king",
      "master-deluxe-twin",
      "master-deluxe-corner",
    ]);
    expect(variants.map((variant) => variant.variantKind)).toEqual([
      "king",
      "twin",
      "corner",
    ]);
    expect(variants.every((variant) => variant.masterId === master.id)).toBe(true);
    expect(variants.every((variant) => Boolean(variant.gene))).toBe(true);
    expect(variants[0].overrides).toContain("bedType");
    expect(variants[1].overrides).toContain("bedType");
    expect(variants[2]!.overrides).toContain("area");
    expect(variants[2]!.metrics!.areaSquareMeters).not.toBe(master.metrics.areaSquareMeters);
  });

  it("retains and transforms master openings for every generated variant", () => {
    const master = createRoomMaster({
      id: "master-openings",
      name: "带开口母版",
      cells,
      columns: 8,
      rows: 12,
      gene: CONTEMPORARY_ORIENTAL.gene,
      openings: {
        walls: [{ x: 0, y: 0, side: "north" }],
        doors: [{ x: 0, y: 1, side: "west" }],
        windows: [{ x: 3, y: 0, side: "east" }],
      },
    });

    const [king, twin, corner] = createRoomVariants(master);

    expect(king?.openings).toEqual(master.openings);
    expect(twin?.openings?.doors).toEqual([{ x: 3, y: 1, side: "east" }]);
    expect(corner?.openings?.doors).toEqual([{ x: 4, y: 1, side: "east" }]);
    for (const variant of [king, twin, corner]) {
      expect(
        validateRoomDraft({
          cells: variant!.cells,
          columns: master.columns,
          rows: master.rows,
          walls: variant!.openings!.walls,
          doors: variant!.openings!.doors,
          windows: variant!.openings!.windows,
        }).ok,
      ).toBe(true);
    }
  });

  it("creates a bounded corner variant from non-origin cells and valid openings", () => {
    const master = createRoomMaster({
      id: "master-offset",
      name: "偏移客房",
      cells: [
        ...createRectangle(2, 3, 3, 2, "bedroom"),
        ...createRectangle(2, 5, 3, 1, "bathroom"),
      ],
      columns: 8,
      rows: 12,
      gene: CONTEMPORARY_ORIENTAL.gene,
      openings: {
        walls: [],
        doors: [{ x: 2, y: 4, side: "west" }],
        windows: [{ x: 4, y: 3, side: "east" }],
      },
    });

    const corner = createRoomVariants(master).find(
      ({ variantKind }) => variantKind === "corner",
    )!;

    const xs = corner.cells.map(({ x }) => x);
    const ys = corner.cells.map(({ y }) => y);
    expect({
      minX: Math.min(...xs),
      minY: Math.min(...ys),
      width: Math.max(...xs) - Math.min(...xs) + 1,
      height: Math.max(...ys) - Math.min(...ys) + 1,
    }).toEqual({ minX: 0, minY: 0, width: 4, height: 3 });
    expect(validateRoomDraft({
      ...createRoomDraft(corner.cells, 8, 12),
      walls: corner.openings!.walls,
      doors: corner.openings!.doors,
      windows: corner.openings!.windows,
    }).ok).toBe(true);
  });

  it("previews each affected property, supports select all/none, and preserves unselected overrides", () => {
    const master = createRoomMaster({
      id: "master-deluxe",
      name: "云岫豪华客房",
      cells,
      columns: 8,
      rows: 12,
      gene: CONTEMPORARY_ORIENTAL.gene,
    });
    const variants = createRoomVariants(master).map((variant) =>
      variant.id === "master-deluxe-twin"
        ? { ...variant, overrides: [...variant.overrides, "gene" as const] }
        : variant,
    );
    const changedMaster = {
      ...master,
      gene: { ...master.gene, lighting: "3000K gallery lighting" },
      cells: [...master.cells, { x: 4, y: 0, zone: "bedroom" as const }],
    };
    const preview = previewMasterSync(master, changedMaster, variants);

    expect(preview.map((change) => `${change.variantId}:${change.property}`)).toContain(
      "master-deluxe-king:gene",
    );
    expect(preview.map((change) => `${change.variantId}:${change.property}`)).toContain(
      "master-deluxe-twin:area",
    );
    expect(selectAllSyncChanges(preview).every((change) => change.selected)).toBe(true);
    expect(selectNoneSyncChanges(preview).every((change) => !change.selected)).toBe(true);

    const selected = preview.filter(
      (change) => change.variantId === "master-deluxe-king" && change.property === "gene",
    ).map((change) => ({ ...change, selected: true }));
    const applied = applySelectedSync(changedMaster, variants, selected);
    expect(applied.find((variant) => variant.id === "master-deluxe-king")?.gene.lighting).toBe(
      "3000K gallery lighting",
    );
    expect(applied.find((variant) => variant.id === "master-deluxe-twin")?.gene.lighting).toBe(
      master.gene.lighting,
    );
    expect(applied.find((variant) => variant.id === "master-deluxe-twin")?.overrides).toContain(
      "gene",
    );
  });

  it("keeps a corner variant resized when selected master openings are synchronized", () => {
    const master = createRoomMaster({
      id: "master-corner-sync",
      name: "转角同步母版",
      cells,
      columns: 8,
      rows: 12,
      gene: CONTEMPORARY_ORIENTAL.gene,
      openings: {
        walls: [],
        doors: [{ x: 0, y: 1, side: "west" }],
        windows: [{ x: 3, y: 0, side: "east" }],
      },
    });
    const variants = createRoomVariants(master);
    const changedMaster = createRoomMaster({
      ...master,
      cells: [...master.cells, { x: 4, y: 0, zone: "bedroom" }],
      openings: {
        ...master.openings,
        windows: [{ x: 4, y: 0, side: "east" }],
      },
    });
    const selected = previewMasterSync(master, changedMaster, variants).map(
      (change) => ({
        ...change,
        selected:
          change.variantId === "master-corner-sync-corner" &&
          change.property === "area",
      }),
    );

    const corner = applySelectedSync(changedMaster, variants, selected).find(
      (variant) => variant.id === "master-corner-sync-corner",
    )!;

    expect(Math.max(...corner.cells.map((cell) => cell.x))).toBe(5);
    expect(corner.openings?.windows).toEqual([
      { x: 0, y: 0, side: "west" },
    ]);
  });
});
