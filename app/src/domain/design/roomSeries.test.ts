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
});
