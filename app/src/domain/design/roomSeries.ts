import type { RoomBlueprint, RoomMetrics, Cell } from "../game/state";
import { evaluateRoom } from "../room/evaluateRoom";
import { mirrorRoom, resizeRoom, rotateRoom } from "../room/transformRoom";
import { createRoomDraft, validateRoomDraft, type Opening } from "../room/editRoom";
import type {
  DesignGene,
  RoomVariant,
  RoomVariantOverride,
} from "./designTypes";

export type RoomVariantKind = "king" | "twin" | "corner";

export interface RoomMaster extends RoomBlueprint {
  gene: DesignGene;
  openings: { walls: Opening[]; doors: Opening[]; windows: Opening[] };
}

export interface RoomSeriesVariant extends RoomVariant {
  variantKind: RoomVariantKind;
  metrics: RoomMetrics;
}

export type SyncProperty = "area" | "gene";

export interface SyncChange {
  id: string;
  variantId: string;
  property: SyncProperty;
  selected: boolean;
  previousValue: unknown;
  nextValue: unknown;
}

function cloneGene(gene: DesignGene): DesignGene {
  return { ...gene, materials: [...gene.materials] };
}

function cloneCells(cells: Cell[]): Cell[] {
  return cells.map((cell) => ({ ...cell }));
}

function metricsFor(cells: Cell[], columns: number, rows: number): RoomMetrics {
  return evaluateRoom(cells, columns, rows);
}

export function createRoomMaster(input: {
  id: string;
  name: string;
  cells: Cell[];
  columns: number;
  rows: number;
  gene: DesignGene;
  openings?: { walls: Opening[]; doors: Opening[]; windows: Opening[] };
}): RoomMaster {
  if (input.id.trim().length === 0) {
    throw new Error("客房母版编号不能为空");
  }
  if (input.name.trim().length === 0) {
    throw new Error("客房母版名称不能为空");
  }
  const cells = cloneCells(input.cells);
  const openings = structuredClone(input.openings ?? {walls:[],doors:[],windows:[]});
  if (!validateRoomDraft({...createRoomDraft(cells,input.columns,input.rows),...openings}).ok) throw new Error("客房开口无效");
  return {
    id: input.id,
    name: input.name.trim(),
    columns: input.columns,
    rows: input.rows,
    cells,
    metrics: metricsFor(cells, input.columns, input.rows),
    visual: { status: "idle" },
    gene: cloneGene(input.gene),
    openings,
  };
}

function variantName(kind: RoomVariantKind): string {
  return kind === "king" ? "特大床房" : kind === "twin" ? "双床房" : "转角景观房";
}

function masterDraft(master: RoomMaster) {
  return {
    ...createRoomDraft(master.cells, master.columns, master.rows),
    ...structuredClone(master.openings),
  };
}

function normalizedMasterDraft(master: RoomMaster) {
  const draft = masterDraft(master);
  const xs = draft.cells.map(({ x }) => x);
  const ys = draft.cells.map(({ y }) => y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const mapOpening = (opening: Opening): Opening => ({
    ...opening,
    x: opening.x - minX,
    y: opening.y - minY,
  });
  return {
    ...draft,
    cells: draft.cells.map((cell) => ({
      ...cell,
      x: cell.x - minX,
      y: cell.y - minY,
    })),
    walls: draft.walls.map(mapOpening),
    doors: draft.doors.map(mapOpening),
    windows: draft.windows.map(mapOpening),
  };
}

function shrinkRoomWidth(draft: ReturnType<typeof masterDraft>) {
  const maxX = Math.max(...draft.cells.map((cell) => cell.x));
  const nextMaxX = maxX - 1;
  const moveOpening = (opening: Opening): Opening =>
    opening.side === "east" && opening.x === maxX
      ? { ...opening, x: nextMaxX }
      : { ...opening };
  return {
    ...draft,
    cells: draft.cells.filter((cell) => cell.x <= nextMaxX),
    walls: draft.walls.map(moveOpening),
    doors: draft.doors.map(moveOpening),
    windows: draft.windows.map(moveOpening),
  };
}

function transformVariantDraft(master: RoomMaster, kind: RoomVariantKind): {
  draft: ReturnType<typeof masterDraft>;
  rotation: RoomVariant["rotation"];
  mirrored: boolean;
  overrides: RoomVariantOverride[];
} {
  const draft = normalizedMasterDraft(master);
  if (kind === "king") {
    return {
      draft,
      rotation: 0,
      mirrored: false,
      overrides: ["bedType"],
    };
  }
  if (kind === "twin") {
    const mirrored = mirrorRoom(draft, "horizontal");
    return {
      draft: mirrored,
      rotation: 0,
      mirrored: true,
      overrides: ["bedType"],
    };
  }
  const xs = draft.cells.map(({ x }) => x);
  const ys = draft.cells.map(({ y }) => y);
  const width = Math.max(...xs) - Math.min(...xs) + 1;
  const height = Math.max(...ys) - Math.min(...ys) + 1;
  const resized = width < master.columns
    ? resizeRoom(draft, { width: width + 1, height })
    : shrinkRoomWidth(draft);
  const mirrored = mirrorRoom(resized, "horizontal");
  return {
    draft: mirrored,
    rotation: 0,
    mirrored: true,
    overrides: ["area", "view"],
  };
}

export function createRoomVariants(master: RoomMaster): RoomSeriesVariant[] {
  return (["king", "twin", "corner"] as const).map((kind) => {
    const transformed = transformVariantDraft(master, kind);
    return {
      id: `${master.id}-${kind}`,
      name: variantName(kind),
      masterId: master.id,
      variantKind: kind,
      cells: cloneCells(transformed.draft.cells),
      rotation: transformed.rotation,
      mirrored: transformed.mirrored,
      overrides: transformed.overrides,
      gene: cloneGene(master.gene),
      metrics: metricsFor(transformed.draft.cells, master.columns, master.rows),
      openings: {
        walls: structuredClone(transformed.draft.walls),
        doors: structuredClone(transformed.draft.doors),
        windows: structuredClone(transformed.draft.windows),
      },
    };
  });
}

function valuesDiffer(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) !== JSON.stringify(b);
}

export function previewMasterSync(
  master: RoomMaster,
  changedMaster: RoomMaster,
  variants: RoomVariant[],
): SyncChange[] {
  const changes: SyncChange[] = [];
  for (const variant of variants) {
    if (valuesDiffer(changedMaster.gene, master.gene)) {
      changes.push({
        id: `${variant.id}:gene`,
        variantId: variant.id,
        property: "gene",
        selected: false,
        previousValue: variant.gene,
        nextValue: changedMaster.gene,
      });
    }
    if (
      valuesDiffer(changedMaster.cells, master.cells) ||
      valuesDiffer(changedMaster.openings, master.openings)
    ) {
      changes.push({
        id: `${variant.id}:cells`,
        variantId: variant.id,
        property: "area",
        selected: false,
        previousValue: variant.cells,
        nextValue: changedMaster.cells,
      });
    }
  }
  return changes;
}

export function selectAllSyncChanges(changes: SyncChange[]): SyncChange[] {
  return changes.map((change) => ({ ...change, selected: true }));
}

export function selectNoneSyncChanges(changes: SyncChange[]): SyncChange[] {
  return changes.map((change) => ({ ...change, selected: false }));
}

export function applySelectedSync(
  changedMaster: RoomMaster,
  variants: RoomVariant[],
  selectedChanges: SyncChange[],
): RoomVariant[] {
  const selected = new Set(
    selectedChanges.filter((change) => change.selected).map((change) => `${change.variantId}:${change.property}`),
  );
  return variants.map((variant) => {
    const next = { ...variant, cells: cloneCells(variant.cells), gene: cloneGene(variant.gene), overrides: [...variant.overrides] };
    if (selected.has(`${variant.id}:gene`)) {
      next.gene = cloneGene(changedMaster.gene);
      next.overrides = next.overrides.filter((override) => override !== "gene");
    }
    if (selected.has(`${variant.id}:area`)) {
      let transformed = variant.variantKind
        ? transformVariantDraft(changedMaster, variant.variantKind).draft
        : { ...createRoomDraft(changedMaster.cells, changedMaster.columns, changedMaster.rows), ...structuredClone(changedMaster.openings) };
      if (!variant.variantKind && variant.rotation !== 0) {
        transformed = rotateRoom(transformed, variant.rotation);
      }
      if (!variant.variantKind && variant.mirrored) {
        transformed = mirrorRoom(transformed, "horizontal");
      }
      next.cells = cloneCells(transformed.cells);
      next.openings = {
        walls: structuredClone(transformed.walls),
        doors: structuredClone(transformed.doors),
        windows: structuredClone(transformed.windows),
      };
      next.metrics = metricsFor(next.cells, changedMaster.columns, changedMaster.rows);
      next.overrides = next.overrides.filter((override) => override !== "area");
    }
    return next;
  });
}
